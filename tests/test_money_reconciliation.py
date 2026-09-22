"""Step 1 — core money correctness: order -> payment -> refund/reopen -> shift close -> report.

Every test ends by checking the same invariants, so a new money path that breaks
reconciliation fails here even if its own endpoint "works".

Run: python -m pytest tests/test_money_reconciliation.py -q
Never point DATABASE_URL at a deployed database.
"""
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


def test_cash_payment_requires_open_shift(shop):
    """Cash taken with no open shift belongs to no drawer and can never be reconciled."""
    oid = order(shop)
    code, body = pay(shop, oid, payment_method='cash')
    assert code == 409, body
    ok(pay(shop, oid, payment_method='qr'))         # non-cash is still allowed without a shift
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
