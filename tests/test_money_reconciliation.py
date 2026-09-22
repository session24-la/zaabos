"""Step 1 — core money correctness: order -> payment -> refund/reopen -> shift close -> report.

Every test ends by checking the same invariants, so a new money path that breaks
reconciliation fails here even if its own endpoint "works".

Run: python -m pytest tests/test_money_reconciliation.py -q
Never point DATABASE_URL at a deployed database.
"""
import json
import sys
import uuid
from decimal import Decimal
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app as core  # noqa: E402
import wsgi  # noqa: E402,F401

D = lambda v: Decimal(str(v or 0)).quantize(Decimal('0.01'))


# ---------------------------------------------------------------- fixtures ---
@pytest.fixture
def shop():
    stamp = uuid.uuid4().hex
    with core.app.app_context():
        c = core.db()
        tenant = c.execute("INSERT INTO tenants(name,active,subscription_status,created_at) VALUES(?,1,'active',?)",
                           ('Money test ' + stamp, core.now())).lastrowid
        branch = c.execute('INSERT INTO branches(tenant_id,name,active,created_at) VALUES(?,?,1,?)',
                           (tenant, 'B', core.now())).lastrowid
        tables = [c.execute('INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,active,created_at) VALUES(?,?,?,?,1,?)',
                            (tenant, branch, f'T{i}', f'{stamp}-{i}', core.now())).lastrowid for i in range(3)]
        cat = c.execute('INSERT INTO menu_categories(tenant_id,branch_id,name,created_at) VALUES(?,?,?,?)',
                        (tenant, branch, 'Food', core.now())).lastrowid
        noodle = c.execute('INSERT INTO menu_items(tenant_id,branch_id,category_id,name,base_price,created_at) VALUES(?,?,?,?,?,?)',
                           (tenant, branch, cat, 'Noodles', 25000, core.now())).lastrowid
        beer = c.execute('INSERT INTO menu_items(tenant_id,branch_id,category_id,name,base_price,created_at) VALUES(?,?,?,?,?,?)',
                         (tenant, branch, cat, 'Beer', 15000, core.now())).lastrowid
        users = {}
        for role in ('owner', 'staff', 'staff2'):
            users[role] = c.execute('INSERT INTO users(tenant_id,username,password_hash,display_name,role,created_at) VALUES(?,?,?,?,?,?)',
                                    (tenant, f'{role}-{stamp}', 'unused', role, 'staff' if role == 'staff2' else role, core.now())).lastrowid
        c.commit()
    return dict(tenant=tenant, branch=branch, tables=tables, noodle=noodle, beer=beer, users=users)


def call(shop, who, method, path, data=None):
    with core.app.test_client() as client:
        with client.session_transaction() as s:
            s.update(user_id=shop['users'][who], active_tenant_id=shop['tenant'], csrf_token='t')
        r = client.open(path, method=method, json=data, headers={'X-CSRF-Token': 't'})
        return r.status_code, (r.get_json(silent=True) or {})


def ok(res):
    code, body = res
    assert code == 200, body
    return body


def order(shop, who='staff', table=0, cart=None):
    cart = cart or [{'menu_item_id': shop['noodle'], 'quantity': 2}, {'menu_item_id': shop['beer'], 'quantity': 1}]
    return ok(call(shop, who, 'POST', '/api/orders', {'branch_id': shop['branch'], 'order_type': 'dine_in',
                                                        'table_id': shop['tables'][table], 'cart': cart}))['order_id']


def pay(shop, oid, who='staff', **kw):
    body = {'payment_status': 'paid'}
    body.update(kw)
    return call(shop, who, 'PUT', f'/api/orders/{oid}/payment', body)


def open_shift(shop, who='staff', cash=100000):
    return ok(call(shop, who, 'POST', '/api/operations/shift/open', {'branch_id': shop['branch'], 'opening_cash': cash}))


def live(shop, who='staff'):
    return ok(call(shop, who, 'GET', f"/api/operations/shift?branch_id={shop['branch']}"))['summary']


def close(shop, who='staff', counted=0):
    return ok(call(shop, who, 'POST', '/api/operations/shift/close', {'branch_id': shop['branch'], 'counted_cash': counted}))


def report(shop):
    return ok(call(shop, 'owner', 'GET', f"/api/reports/summary?branch_id={shop['branch']}"))


def assert_ledger(shop):
    """Invariants that must hold after ANY sequence of money operations."""
    with core.app.app_context():
        c = core.db()
        paid = c.execute("SELECT * FROM orders WHERE tenant_id=? AND payment_status='paid'", (shop['tenant'],)).fetchall()
        for o in paid:
            due = D(o['total_amount']) - D(o['discount_amount']) + D(o['service_charge_amount']) + D(o['tax_amount']) + D(o['delivery_fee'])
            items = D(c.execute('SELECT COALESCE(SUM((quantity-COALESCE(cancelled_quantity,0))*unit_price),0) t FROM order_items WHERE order_id=?', (o['id'],)).fetchone()['t'])
            active = D(c.execute('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE order_id=? AND reversed_at IS NULL', (o['id'],)).fetchone()['t'])
            refunded = D(c.execute('SELECT COALESCE(SUM(amount),0) t FROM refunds WHERE order_id=?', (o['id'],)).fetchone()['t'])
            assert items == D(o['total_amount']), f"order {o['id']}: items {items} != stored total {o['total_amount']}"
            assert active == due, f"order {o['id']}: active payments {active} != bill due {due}"
            assert refunded <= active, f"order {o['id']}: refunded {refunded} > paid {active}"
        unpaid_with_active = c.execute("""SELECT o.id FROM orders o JOIN payments p ON p.order_id=o.id AND p.reversed_at IS NULL
                                          WHERE o.tenant_id=? AND o.payment_status<>'paid'""", (shop['tenant'],)).fetchall()
        assert not unpaid_with_active, f'unpaid orders with live payments: {[r["id"] for r in unpaid_with_active]}'
        pay_total = D(c.execute('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE tenant_id=? AND reversed_at IS NULL', (shop['tenant'],)).fetchone()['t'])
        ref_total = D(c.execute('SELECT COALESCE(SUM(amount),0) t FROM refunds WHERE tenant_id=?', (shop['tenant'],)).fetchone()['t'])
    r = report(shop)
    assert D(r['total_sales']) == pay_total, f"report sales {r['total_sales']} != payments {pay_total}"
    assert D(sum(D(x['total']) for x in r['payment_breakdown'])) == pay_total
    assert D(r['refund_total']) == ref_total
    assert D(r['net_sales']) == pay_total - ref_total


# ------------------------------------------------------------------- tests ---
def test_cash_sale_reconciles_to_the_cent(shop):
    open_shift(shop, cash=100000)
    oid = order(shop)                                 # 2x25000 + 15000 = 65000
    body = ok(pay(shop, oid, payment_method='cash', cash_received=70000))
    assert D(body['amount']) == D(65000) and D(body['change']) == D(5000)
    s = live(shop)
    assert D(s['expected_cash']) == D(165000)
    closed = close(shop, counted=165000)
    assert D(closed['difference']) == 0
    assert_ledger(shop)


def test_split_payment_only_cash_leg_goes_to_drawer(shop):
    open_shift(shop, cash=0)
    oid = order(shop)
    ok(pay(shop, oid, payments=[{'method': 'cash', 'amount': 20000, 'cash_received': 20000},
                                {'method': 'bank_transfer', 'amount': 45000}]))
    s = live(shop)
    assert D(s['expected_cash']) == D(20000)
    assert D(s['gross_received']) == D(65000)
    assert_ledger(shop)


def test_split_payment_must_equal_bill(shop):
    open_shift(shop)
    oid = order(shop)
    code, _ = pay(shop, oid, payments=[{'method': 'cash', 'amount': 20000}, {'method': 'qr', 'amount': 40000}])
    assert code == 400
    assert_ledger(shop)


def test_double_payment_rejected(shop):
    open_shift(shop)
    oid = order(shop)
    ok(pay(shop, oid, payment_method='qr'))
    code, _ = pay(shop, oid, payment_method='qr')
    assert code == 409
    assert_ledger(shop)


def test_every_payment_requires_open_shift(shop):
    """Money taken with no open shift belongs to no shift report and can never be reconciled."""
    oid = order(shop)
    for method in ('cash', 'qr', 'bank_transfer', 'card'):
        code, body = pay(shop, oid, payment_method=method)
        assert code == 409 and body.get('code') == 'shift_required', (method, body)
    open_shift(shop)
    ok(pay(shop, oid, payment_method='qr'))
    assert D(live(shop)['gross_received']) == D(65000)
    assert_ledger(shop)


def test_partial_refund_reduces_drawer_and_report(shop):
    open_shift(shop, who='owner', cash=0)
    oid = order(shop, who='owner')
    ok(pay(shop, oid, who='owner', payment_method='cash'))
    ok(call(shop, 'owner', 'POST', f'/api/orders/{oid}/refund', {'amount': 15000, 'reason': 'beer returned'}))
    code, _ = call(shop, 'owner', 'POST', f'/api/orders/{oid}/refund', {'amount': 60000, 'reason': 'too much'})
    assert code == 400
    assert D(live(shop, 'owner')['expected_cash']) == D(50000)
    assert_ledger(shop)


def test_refund_on_split_bill_can_be_returned_in_cash(shop):
    """Customer paid transfer+cash, cashier hands back cash: the drawer must drop."""
    open_shift(shop, who='owner', cash=0)
    oid = order(shop, who='owner')
    ok(pay(shop, oid, who='owner', payments=[{'method': 'bank_transfer', 'amount': 45000},
                                             {'method': 'cash', 'amount': 20000, 'cash_received': 20000}]))
    ok(call(shop, 'owner', 'POST', f'/api/orders/{oid}/refund', {'amount': 15000, 'reason': 'beer returned', 'method': 'cash'}))
    assert D(live(shop, 'owner')['expected_cash']) == D(5000)
    assert_ledger(shop)


def test_reopen_and_repay_in_same_shift_nets_to_zero(shop):
    open_shift(shop, who='owner', cash=0)
    oid = order(shop, who='owner')
    ok(pay(shop, oid, who='owner', payment_method='cash'))
    ok(call(shop, 'owner', 'POST', f'/api/orders/{oid}/reopen', {'reason': 'wrong item'}))
    ok(call(shop, 'owner', 'PUT', f"/api/orders/{oid}/items/{_first_item(oid)}/quantity", {'quantity': 1, 'reason': 'wrong item'}))
    ok(pay(shop, oid, who='owner', payment_method='cash'))   # 25000 + 15000 = 40000
    assert D(live(shop, 'owner')['expected_cash']) == D(40000)
    assert_ledger(shop)


def test_reopen_by_another_cashier_keeps_both_drawers_right(shop):
    """Staff takes 65,000 cash. Owner (own shift) reverses it and re-charges 65,000 cash.
    Physically: staff drawer holds 65,000; owner drawer received nothing new."""
    open_shift(shop, who='owner', cash=0)
    open_shift(shop, who='staff', cash=0)
    oid = order(shop)
    ok(pay(shop, oid, who='staff', payment_method='cash'))
    ok(call(shop, 'owner', 'POST', f'/api/orders/{oid}/reopen', {'reason': 'wrong table'}))
    ok(pay(shop, oid, who='owner', payment_method='cash'))
    assert D(live(shop, 'staff')['expected_cash']) == D(65000)
    assert D(live(shop, 'owner')['expected_cash']) == D(0)
    assert_ledger(shop)


def test_reopen_after_shift_closed_is_charged_to_current_shift(shop):
    open_shift(shop, who='owner', cash=0)
    oid = order(shop, who='owner')
    ok(pay(shop, oid, who='owner', payment_method='cash'))
    first = close(shop, who='owner', counted=65000)
    assert D(first['difference']) == 0
    open_shift(shop, who='owner', cash=65000)
    ok(call(shop, 'owner', 'POST', f'/api/orders/{oid}/reopen', {'reason': 'customer disputed'}))
    ok(pay(shop, oid, who='owner', payment_method='qr'))      # money goes back, customer pays by QR
    assert D(live(shop, 'owner')['expected_cash']) == D(0)
    hist = ok(call(shop, 'owner', 'GET', f"/api/operations/shifts?branch_id={shop['branch']}"))
    assert D(hist[0]['summary']['expected_cash']) == D(65000), 'closed shift summary must stay frozen'
    assert_ledger(shop)


def test_cash_in_out_and_close_twice(shop):
    open_shift(shop, cash=50000)
    ok(call(shop, 'staff', 'POST', '/api/operations/cash-movement', {'branch_id': shop['branch'], 'movement_type': 'cash_in', 'amount': 20000, 'reason': 'change'}))
    ok(call(shop, 'staff', 'POST', '/api/operations/cash-movement', {'branch_id': shop['branch'], 'movement_type': 'cash_out', 'amount': 5000, 'reason': 'ice'}))
    assert D(live(shop)['expected_cash']) == D(65000)
    close(shop, counted=64000)
    code, _ = call(shop, 'staff', 'POST', '/api/operations/shift/close', {'branch_id': shop['branch'], 'counted_cash': 1})
    assert code == 409
    assert_ledger(shop)


def test_merge_and_split_keep_totals(shop):
    open_shift(shop)
    a = order(shop, table=0)
    b = order(shop, table=1, cart=[{'menu_item_id': shop['beer'], 'quantity': 2}])
    ok(call(shop, 'staff', 'POST', f'/api/orders/{b}/merge', {'target_order_id': a}))
    item = _first_item(a)
    new = ok(call(shop, 'staff', 'POST', f'/api/orders/{a}/split', {'items': [{'item_id': item, 'quantity': 1}]}))
    new_id = new['new_order_id']
    ok(pay(shop, a, payment_method='cash'))
    ok(pay(shop, new_id, payment_method='qr'))
    assert D(live(shop)['gross_received']) == D(95000)
    code, _ = call(shop, 'staff', 'POST', f'/api/orders/{a}/merge', {'target_order_id': new_id})
    assert code == 409
    assert_ledger(shop)


def test_merge_into_paid_bill_rejected(shop):
    open_shift(shop)
    a = order(shop, table=0)
    b = order(shop, table=1)
    ok(pay(shop, a, payment_method='qr'))
    code, _ = call(shop, 'staff', 'POST', f'/api/orders/{b}/merge', {'target_order_id': a})
    assert code == 409
    assert_ledger(shop)


def test_staff_cannot_edit_or_refund_without_approval(shop):
    open_shift(shop)
    oid = order(shop)
    ok(pay(shop, oid, payment_method='cash'))
    code, _ = call(shop, 'staff', 'POST', f'/api/orders/{oid}/refund', {'amount': 1000, 'reason': 'x'})
    assert code == 403
    code, _ = call(shop, 'staff', 'POST', f'/api/orders/{oid}/reopen', {'reason': 'mistake'})
    assert code == 403
    assert_ledger(shop)


def _first_item(oid):
    with core.app.app_context():
        return core.db().execute('SELECT id FROM order_items WHERE order_id=? ORDER BY id LIMIT 1', (oid,)).fetchone()['id']


def test_merge_racing_payment_never_changes_a_paid_bill(shop):
    """Two devices: one merges table B into A while another cashes out A."""
    from concurrent.futures import ThreadPoolExecutor
    open_shift(shop)
    for i in range(8):
        a = order(shop, table=0)
        b = order(shop, table=1, cart=[{'menu_item_id': shop['beer'], 'quantity': 1}])
        with ThreadPoolExecutor(2) as ex:
            f1 = ex.submit(call, shop, 'staff', 'POST', f'/api/orders/{b}/merge', {'target_order_id': a})
            f2 = ex.submit(pay, shop, a, 'staff2', payment_method='qr')
            r1, r2 = f1.result(), f2.result()
        assert r1[0] in (200, 409) and r2[0] in (200, 400, 409), (r1, r2)
        assert_ledger(shop)


def test_tax_service_discount_rounding_reconciles(shop):
    """Odd rates + manual discount: bill due, payments and report must agree to the cent."""
    ok(call(shop, 'owner', 'PUT', '/api/pricing/settings', {'branch_id': shop['branch'], 'tax_rate': 7, 'service_charge_rate': 10}))
    open_shift(shop, who='owner', cash=0)
    ids = [order(shop, who='owner', table=i % 3, cart=[{'menu_item_id': shop['beer'], 'quantity': q}]) for i, q in enumerate((1, 3, 7))]
    ok(pay(shop, ids[0], who='owner', payment_method='cash'))
    ok(pay(shop, ids[1], who='owner', payment_method='qr', discount_amount=3333, discount_reason='regular'))
    body = ok(pay(shop, ids[2], who='owner', payments=[{'method': 'cash', 'amount': 50000, 'cash_received': 50000},
                                                      {'method': 'card', 'amount': 73585}]))
    # 7 x 15,000 = 105,000 ; +10% service = 10,500 ; +7% tax on 115,500 = 8,085 -> 123,585
    assert D(body['amount']) == D(123585)
    ok(call(shop, 'owner', 'POST', f'/api/orders/{ids[2]}/refund', {'amount': 0.01, 'reason': 'cent', 'method': 'card'}))
    assert_ledger(shop)


def test_payment_retry_after_lost_response_is_not_an_error(shop):
    """Tablet sends checkout, Wi-Fi drops before the reply, tablet retries the same request.
    The retry must report success (same payment), not 'cannot pay again'."""
    open_shift(shop)
    oid = order(shop)
    key = uuid.uuid4().hex
    ok(pay(shop, oid, payment_method='qr', client_request_id=key))
    code, body = pay(shop, oid, payment_method='qr', client_request_id=key)
    assert code == 200 and body.get('idempotent'), body
    assert_ledger(shop)


FRESH_SCRIPT = r'''
import app as core, wsgi, json
c = core.app.test_client()
with core.app.app_context():
    db = core.db()
    counts = {t: db.execute(f"SELECT COUNT(*) AS n FROM {t}").fetchone()["n"] for t in ("branches", "dining_tables", "menu_categories", "menu_items")}
    admin = db.execute("SELECT id FROM users WHERE role='super_admin'").fetchone()["id"]
    tenant = db.execute("SELECT id FROM tenants ORDER BY id LIMIT 1").fetchone()["id"]
    branch = db.execute("SELECT id FROM branches ORDER BY id LIMIT 1").fetchone()["id"]
    table = db.execute("SELECT id FROM dining_tables ORDER BY id LIMIT 1").fetchone()["id"]
    item = db.execute("SELECT id,base_price FROM menu_items ORDER BY id LIMIT 1").fetchone()
with c.session_transaction() as s:
    s.update(user_id=admin, active_tenant_id=tenant, csrf_token="x")
H = {"X-CSRF-Token": "x"}
o = c.post("/api/orders", json={"branch_id": branch, "order_type": "dine_in", "table_id": table,
           "cart": [{"menu_item_id": item["id"], "quantity": 2}]}, headers=H).get_json()
c.post("/api/operations/shift/open", json={"branch_id": branch, "opening_cash": 0}, headers=H)
p = c.put(f"/api/orders/{o['order_id']}/payment", json={"payment_status": "paid", "payment_method": "cash"}, headers=H).get_json()
r = c.get(f"/api/reports/summary?branch_id={branch}", headers=H).get_json()
sh = c.get(f"/api/operations/shift?branch_id={branch}", headers=H).get_json()
print("RESULT" + json.dumps(dict(counts=counts, due=item["base_price"] * 2, paid=p.get("amount"),
      report=r.get("total_sales"), shift_cash=sh["summary"]["expected_cash"])))
'''


def test_fresh_install_is_ready_to_sell(tmp_path):
    """Brand-new database: branch, 6 tables and a sample menu exist; the very first sale
    reaches both the daily report and the shift."""
    import json, shutil, subprocess, os
    dest = tmp_path / 'app'
    shutil.copytree(ROOT, dest, ignore=shutil.ignore_patterns('.git', '*.db', '.secret_key', '__pycache__', '.pytest_cache', 'backups'))
    env = dict(os.environ, ZAABOS_ADMIN_PASSWORD='local-test-password-only')
    env.pop('DATABASE_URL', None)
    out = subprocess.run([sys.executable, '-c', FRESH_SCRIPT], cwd=dest, env=env, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.split('RESULT', 1)[1])
    assert res['counts'] == {'branches': 1, 'dining_tables': 6, 'menu_categories': 3, 'menu_items': 10}
    assert res['paid'] == res['due'] == res['report'] == res['shift_cash'] == 70000


def test_pos_page_loads_local_qr_renderer():
    """Table QR codes render locally (CSP blocks external image hosts). Guard against the
    asset version bump that silently dropped qr-local.js."""
    html = core.app.test_client().get('/').get_data(as_text=True)
    assert '/static/qr-local.js' in html
    assert html.index('/static/app.js') < html.index('/static/qr-local.js')


def test_report_lists_every_shift_of_the_day(shop):
    """After a shift change the closed shift stays visible (and reprintable) in the report."""
    open_shift(shop, who='owner', cash=0)
    ok(pay(shop, order(shop, who='owner'), who='owner', payment_method='cash'))
    close(shop, who='owner', counted=65000)
    open_shift(shop, who='staff', cash=10000)
    ok(pay(shop, order(shop, table=1), payment_method='qr'))
    rows = report(shop)['shifts']
    assert len(rows) == 2
    closed = next(r for r in rows if r['status'] == 'closed')
    live_row = next(r for r in rows if r['status'] == 'open')
    assert D(closed['expected_cash']) == D(65000) and D(closed['difference']) == 0
    assert D(closed['summary']['net_received']) == D(65000)
    assert D(live_row['summary']['net_received']) == D(65000) and D(live_row['summary']['expected_cash']) == D(10000)
    assert 'summary_json' not in closed
    assert_ledger(shop)


def test_data_dir_keeps_database_across_restarts(tmp_path):
    """ZAABOS_DATA_DIR (Railway volume / shop PC data folder): a restart reuses the same
    database and admin instead of creating a fresh one."""
    import os, shutil, subprocess
    dest, data = tmp_path / 'app', tmp_path / 'data'
    shutil.copytree(ROOT, dest, ignore=shutil.ignore_patterns('.git', '*.db', '.secret_key', '__pycache__', '.pytest_cache', 'backups'))
    env = dict(os.environ, ZAABOS_DATA_DIR=str(data))
    env.pop('DATABASE_URL', None); env.pop('ZAABOS_ADMIN_PASSWORD', None)
    runs = [subprocess.run([sys.executable, '-c', 'import wsgi'], cwd=dest, env=env, capture_output=True, text=True, timeout=60) for _ in range(2)]
    assert all(r.returncode == 0 for r in runs), runs[0].stderr
    assert (data / 'zaabos.db').exists() and not (dest / 'zaabos.db').exists()
    assert 'temporary_password' in runs[0].stdout and 'temporary_password' not in runs[1].stdout


# ------------------------------------------------ Step 1 remaining gaps ---
def public(path, data):
    with core.app.test_client() as client:
        r = client.post(path, json=data)
        return r.status_code, (r.get_json(silent=True) or {})


def _qr_token(shop, table=0):
    with core.app.app_context():
        return core.db().execute('SELECT qr_token FROM dining_tables WHERE id=?', (shop['tables'][table],)).fetchone()['qr_token']


def _stock(item_id):
    with core.app.app_context():
        return core.db().execute('SELECT stock_qty FROM menu_items WHERE id=?', (item_id,)).fetchone()['stock_qty']


def _track_stock(item_id, qty):
    with core.app.app_context():
        c = core.db()
        c.execute('UPDATE menu_items SET track_stock=1, stock_qty=? WHERE id=?', (qty, item_id))
        c.commit()


def test_cancel_after_kitchen_restores_stock_and_stays_out_of_sales(shop):
    """Item cancelled after the kitchen got it: stock returns, bill shrinks, report counts the
    cancellation but not the money. Whole-order cancel after kitchen: nothing reaches sales."""
    _track_stock(shop['noodle'], 10)
    open_shift(shop, who='owner', cash=0)
    a = order(shop, who='owner', table=0)                     # 2 noodles + 1 beer
    b = order(shop, who='owner', table=1)
    assert _stock(shop['noodle']) == 6
    for oid in (a, b):
        items = [i for i in _items(oid)]
        ok(call(shop, 'owner', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': items}))
    noodle_a = _items(a)[0]
    ok(call(shop, 'owner', 'PUT', f'/api/orders/{a}/items/{noodle_a}/cancel', {'quantity': 1, 'reason': 'burnt'}))
    for step in ('preparing', 'cancelled'):
        ok(call(shop, 'owner', 'PUT', f'/api/orders/{b}/status', {'status': step, 'reason': 'customer left'}))
    assert _stock(shop['noodle']) == 9
    ok(pay(shop, a, who='owner', payment_method='cash'))     # 25000 + 15000
    r = report(shop)
    assert D(r['total_sales']) == D(40000) and r['order_count'] == 1
    assert r['cancellations']['item_count'] == 1 and r['cancellations']['order_count'] == 1
    assert D(r['open_order_total']) == 0
    assert D(live(shop, 'owner')['expected_cash']) == D(40000)
    # A cancelled bill must never be paid or reopened into sales.
    code, _ = pay(shop, b, who='owner', payment_method='cash')
    assert code == 409
    assert_ledger(shop)


def test_percent_promotion_with_cap_and_minimum(shop):
    ok(call(shop, 'owner', 'POST', '/api/promotions', {'code': 'late10', 'name': 'Late night', 'discount_type': 'percent',
                                                        'discount_value': 10, 'min_spend': 50000, 'max_discount': 5000}))
    ok(call(shop, 'owner', 'PUT', '/api/pricing/settings', {'branch_id': shop['branch'], 'tax_rate': 10, 'service_charge_rate': 0}))
    open_shift(shop, cash=0)
    small = order(shop, table=0, cart=[{'menu_item_id': shop['beer'], 'quantity': 1}])
    code, _ = pay(shop, small, payment_method='qr', promotion_code='LATE10')
    assert code == 400, 'below minimum spend must be refused'
    big = order(shop, table=1, cart=[{'menu_item_id': shop['noodle'], 'quantity': 4}])   # 100,000
    body = ok(pay(shop, big, payment_method='qr', promotion_code='late10'))
    # 10% = 10,000 capped at 5,000 -> 95,000 ; +10% tax = 9,500 -> 104,500
    assert D(body['amount']) == D(104500)
    mid = order(shop, table=2, cart=[{'menu_item_id': shop['noodle'], 'quantity': 1}, {'menu_item_id': shop['beer'], 'quantity': 3}])
    body = ok(pay(shop, mid, payment_method='cash', promotion_code='LATE10'))
    # 70,000 -> 10% = 7,000 capped 5,000 -> 65,000 ; tax 6,500 -> 71,500
    assert D(body['amount']) == D(71500)
    r = report(shop)
    assert D(r['discount']) == D(10000)
    assert_ledger(shop)


def test_promotion_window_uses_restaurant_time(shop):
    """Owner types start/end in Lao local time. A promotion that ended an hour ago (local) must
    be refused, and one running now must apply — regardless of UTC storage."""
    from datetime import timedelta
    local = core.restaurant_now().replace(tzinfo=None, microsecond=0)
    fmt = lambda dt: dt.strftime('%Y-%m-%dT%H:%M')
    ok(call(shop, 'owner', 'POST', '/api/promotions', {'code': 'OVER', 'name': 'Over', 'discount_type': 'fixed', 'discount_value': 1000,
                                                        'starts_at': fmt(local - timedelta(hours=5)), 'ends_at': fmt(local - timedelta(hours=1))}))
    ok(call(shop, 'owner', 'POST', '/api/promotions', {'code': 'NOW', 'name': 'Now', 'discount_type': 'fixed', 'discount_value': 1000,
                                                        'starts_at': fmt(local - timedelta(hours=1)), 'ends_at': fmt(local + timedelta(hours=1))}))
    open_shift(shop, cash=0)
    oid = order(shop)
    code, body = pay(shop, oid, payment_method='qr', promotion_code='OVER')
    assert code == 400, body
    assert D(ok(pay(shop, oid, payment_method='qr', promotion_code='NOW'))['amount']) == D(64000)
    assert_ledger(shop)


def _set_paid_at(oid, ts):
    with core.app.app_context():
        c = core.db()
        c.execute('UPDATE orders SET paid_at=? WHERE id=?', (ts, oid))
        c.execute('UPDATE payments SET paid_at=? WHERE order_id=?', (ts, oid))
        c.commit()


def test_report_day_boundary_is_lao_midnight(shop):
    """23:50 and 00:10 Lao time are different business days even though both are the same UTC day."""
    open_shift(shop, who='owner', cash=0)
    late = order(shop, who='owner', table=0)
    early = order(shop, who='owner', table=1, cart=[{'menu_item_id': shop['beer'], 'quantity': 1}])
    ok(pay(shop, late, who='owner', payment_method='qr'))
    ok(pay(shop, early, who='owner', payment_method='qr'))
    _set_paid_at(late, '2026-03-01T16:50:00+00:00')    # 23:50 Vientiane, 1 March
    _set_paid_at(early, '2026-03-01T17:10:00+00:00')   # 00:10 Vientiane, 2 March
    day = lambda d: ok(call(shop, 'owner', 'GET', f"/api/reports/summary?branch_id={shop['branch']}&from={d}&to={d}"))
    d1, d2 = day('2026-03-01'), day('2026-03-02')
    assert D(d1['total_sales']) == D(65000) and D(d2['total_sales']) == D(15000)
    for r in (d1, d2):
        assert D(sum(D(x['total']) for x in r['payment_breakdown'])) == D(r['total_sales'])
    both = ok(call(shop, 'owner', 'GET', f"/api/reports/summary?branch_id={shop['branch']}&from=2026-03-01&to=2026-03-02"))
    assert D(both['total_sales']) == D(80000)


def test_delivery_fee_counts_in_bill_report_and_shift(shop):
    open_shift(shop, cash=0)
    oid = ok(call(shop, 'staff', 'POST', '/api/orders', {'branch_id': shop['branch'], 'order_type': 'delivery', 'customer_phone': '02055551234',
                                                          'customer_address': 'Ban Sisaket', 'delivery_fee': 10000,
                                                          'cart': [{'menu_item_id': shop['noodle'], 'quantity': 1}]}))['order_id']
    body = ok(pay(shop, oid, payment_method='cash', cash_received=50000))
    assert D(body['amount']) == D(35000) and D(body['change']) == D(15000)
    r = report(shop)
    assert D(r['delivery_fee']) == D(10000) and D(r['total_sales']) == D(35000)
    assert D(live(shop)['expected_cash']) == D(35000)
    assert_ledger(shop)


def test_delivery_fee_is_not_lost_when_merged(shop):
    """Merging a delivery bill (with its fee) into another bill must not silently drop the fee."""
    open_shift(shop, cash=0)
    dl = ok(call(shop, 'staff', 'POST', '/api/orders', {'branch_id': shop['branch'], 'order_type': 'delivery', 'customer_phone': '02055551234',
                                                         'customer_address': 'Ban Sisaket', 'delivery_fee': 10000,
                                                         'cart': [{'menu_item_id': shop['beer'], 'quantity': 1}]}))['order_id']
    tk = ok(call(shop, 'staff', 'POST', '/api/orders', {'branch_id': shop['branch'], 'order_type': 'takeaway',
                                                         'cart': [{'menu_item_id': shop['beer'], 'quantity': 1}]}))['order_id']
    code, _ = call(shop, 'staff', 'POST', f'/api/orders/{dl}/merge', {'target_order_id': tk})
    if code == 200:
        assert D(ok(pay(shop, tk, payment_method='qr'))['amount']) == D(40000)
    else:
        assert code == 409
    assert_ledger(shop)


def test_many_qr_customers_one_table_one_bill_to_shift_close(shop):
    """Three phones at the same table order by QR, staff adds a round, cashier takes cash, closes shift."""
    token = _qr_token(shop, 0)
    ids = set()
    for cart in ([{'menu_item_id': shop['noodle'], 'quantity': 1}],
                 [{'menu_item_id': shop['beer'], 'quantity': 2}],
                 [{'menu_item_id': shop['noodle'], 'quantity': 1}]):
        body = ok(public('/api/public/orders', {'branch_id': shop['branch'], 'order_type': 'dine_in', 'table_token': token, 'cart': cart}))
        ids.add(body['order_id'])
    assert len(ids) == 1, f'one table must have one open bill, got {ids}'
    oid = ids.pop()
    ok(call(shop, 'staff', 'POST', f'/api/orders/{oid}/items', {'items': [{'menu_item_id': shop['beer'], 'quantity': 1}]}))
    # 2 x 25,000 + 3 x 15,000 = 95,000
    open_shift(shop, cash=20000)
    assert D(ok(pay(shop, oid, payment_method='cash', cash_received=100000))['amount']) == D(95000)
    # After payment, a new QR order on the same table starts a new bill, never touches the paid one.
    nxt = ok(public('/api/public/orders', {'branch_id': shop['branch'], 'order_type': 'dine_in', 'table_token': token,
                                            'cart': [{'menu_item_id': shop['beer'], 'quantity': 1}]}))['order_id']
    assert nxt != oid
    closed = close(shop, counted=115000)
    assert D(closed['difference']) == 0 and D(closed['summary']['gross_received']) == D(95000)
    r = report(shop)
    assert r['open_order_count'] == 1 and D(r['open_order_total']) == D(15000)
    assert_ledger(shop)


def test_qr_orders_racing_on_one_table_make_one_bill(shop):
    from concurrent.futures import ThreadPoolExecutor
    token = _qr_token(shop, 1)
    payload = {'branch_id': shop['branch'], 'order_type': 'dine_in', 'table_token': token,
               'cart': [{'menu_item_id': shop['beer'], 'quantity': 1}]}
    with ThreadPoolExecutor(4) as ex:
        results = list(ex.map(lambda _: public('/api/public/orders', payload), range(4)))
    assert all(code == 200 for code, _ in results), results
    with core.app.app_context():
        open_bills = core.db().execute("SELECT COUNT(*) n FROM orders WHERE table_id=? AND status<>'cancelled'", (shop['tables'][1],)).fetchone()['n']
    assert open_bills == 1
    open_shift(shop, cash=0)
    oid = results[0][1]['order_id']
    assert D(ok(pay(shop, oid, payment_method='qr'))['amount']) == D(60000)
    assert_ledger(shop)


def test_offline_order_sync_retry_then_pay_reconciles(shop):
    """Tablet queues an order offline, syncs it twice (lost reply), then it is paid.
    One bill, stock taken once, payment and report agree."""
    _track_stock(shop['beer'], 10)
    key = uuid.uuid4().hex
    payload = {'branch_id': shop['branch'], 'order_type': 'dine_in', 'table_id': shop['tables'][2],
               'cart': [{'menu_item_id': shop['beer'], 'quantity': 3}], 'client_request_id': key,
               'client_device_id': 'tablet-1', 'offline_created_at': '2026-03-01T12:00:00.000Z'}
    first = ok(call(shop, 'staff', 'POST', '/api/orders', payload))
    again = ok(call(shop, 'staff', 'POST', '/api/orders', payload))
    assert again.get('idempotent') and again['order_id'] == first['order_id']
    assert _stock(shop['beer']) == 7
    open_shift(shop, cash=0)
    ok(pay(shop, first['order_id'], payment_method='cash'))
    assert D(report(shop)['total_sales']) == D(45000)
    assert_ledger(shop)


def test_offline_sync_racing_retries_make_one_order(shop):
    from concurrent.futures import ThreadPoolExecutor
    _track_stock(shop['beer'], 10)
    key = uuid.uuid4().hex
    payload = {'branch_id': shop['branch'], 'order_type': 'takeaway', 'client_request_id': key,
               'cart': [{'menu_item_id': shop['beer'], 'quantity': 2}]}
    with ThreadPoolExecutor(3) as ex:
        results = list(ex.map(lambda _: call(shop, 'staff', 'POST', '/api/orders', payload), range(3)))
    assert all(code == 200 for code, _ in results), results
    assert len({b['order_id'] for _, b in results}) == 1
    assert _stock(shop['beer']) == 8
    assert_ledger(shop)


def _items(oid):
    with core.app.app_context():
        return [r['id'] for r in core.db().execute('SELECT id FROM order_items WHERE order_id=? ORDER BY id', (oid,)).fetchall()]


def test_report_today_is_lao_date_before_7am():
    """05:55 in Vientiane is 22:55 UTC the day before. The report's "today" must still be the
    Lao date, otherwise early-morning sales and shifts look missing."""
    import re, shutil, subprocess
    if not shutil.which('node'):
        pytest.skip('node not installed')
    src = (ROOT / 'static' / 'app.js').read_text(encoding='utf-8')
    helpers = re.search(r'^function isoDate.*?^function presetRange.*?^}$', src, re.S | re.M).group(0)
    script = ("const ZAABOS_RESTAURANT_TZ='Asia/Vientiane';\n" + helpers +
              "\nconst RealDate=Date; Date=class extends RealDate{constructor(...a){super(...(a.length?a:['2026-09-22T22:55:00Z']))}"
              " static UTC(...a){return RealDate.UTC(...a)}};"
              "\nconsole.log(JSON.stringify([presetRange('today'),presetRange('yesterday'),presetRange('month')]))")
    out = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == [['2026-09-23', '2026-09-23'], ['2026-09-22', '2026-09-22'], ['2026-09-01', '2026-09-23']]
