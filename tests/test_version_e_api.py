"""Version E back-office data: table zones, history filters, customers, hourly sales.

Run: python -m pytest tests/test_version_e_api.py -q
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app as core  # noqa: E402
from test_money_reconciliation import shop, call, ok, order, pay, open_shift  # noqa: E402,F401


def test_tables_keep_a_zone_and_bulk_create_uses_prefix(shop):
    b = shop['branch']
    tid = ok(call(shop, 'owner', 'POST', '/api/tables', {'branch_id': b, 'name': 'VIP 1', 'zone': '  ห้อง   VIP '}))['id']
    ok(call(shop, 'owner', 'POST', '/api/tables/bulk', {'branch_id': b, 'count': 3, 'prefix': 'A', 'zone': 'โซน A'}))
    ok(call(shop, 'owner', 'POST', '/api/tables/bulk', {'branch_id': b, 'count': 2, 'prefix': 'A', 'zone': 'โซน A'}))
    rows = ok(call(shop, 'owner', 'GET', f'/api/tables?branch_id={b}'))['tables']
    zones = {r['name']: r['zone'] for r in rows}
    assert zones['VIP 1'] == 'ห้อง VIP'
    assert [n for n in zones if n.startswith('A')] == ['A1', 'A2', 'A3', 'A4', 'A5']
    assert all(zones[f'A{i}'] == 'โซน A' for i in range(1, 6))
    ok(call(shop, 'owner', 'PUT', f'/api/tables/{tid}', {'name': 'VIP 1', 'zone': 'ระเบียง'}))
    ok(call(shop, 'owner', 'PUT', f'/api/tables/{tid}', {'name': 'VIP 01'}))   # renaming keeps the zone
    rows = ok(call(shop, 'owner', 'GET', f'/api/tables?branch_id={b}'))['tables']
    assert {r['name']: r['zone'] for r in rows}['VIP 01'] == 'ระเบียง'
    boot = ok(call(shop, 'staff', 'GET', '/api/bootstrap'))
    assert any(t['zone'] == 'ระเบียง' for t in boot['tables'])


def test_history_filters_by_date_and_text(shop):
    oid = order(shop)
    with core.app.app_context():
        c = core.db()
        c.execute("UPDATE orders SET created_at='2020-01-15T10:00:00+00:00', customer_name='Somchai', customer_phone='02055551234' WHERE id=?", (oid,))
        c.commit()
    other = order(shop, table=1)
    b = shop['branch']
    today = core.restaurant_today()
    ids = lambda qs: [o['id'] for o in ok(call(shop, 'staff', 'GET', f'/api/orders?branch_id={b}&{qs}'))['orders']]
    assert ids(f'date_from={today}&date_to={today}') == [other]
    assert ids('date_from=2020-01-15&date_to=2020-01-15') == [oid]
    assert ids('date_from=2020-01-16&date_to=2020-01-14') == [oid]          # reversed range is swapped
    assert ids('q=somch') == [oid] and ids('q=5555') == [oid]
    assert ids('customer_phone=02055551234') == [oid]
    code, _ = call(shop, 'staff', 'GET', f'/api/orders?branch_id={b}&date_from=nope')
    assert code == 400


def test_customers_are_grouped_by_phone_then_name(shop):
    open_shift(shop)
    b = shop['branch']
    a1, a2, n1, anon = order(shop), order(shop, table=1), order(shop, table=2), order(shop)
    with core.app.app_context():
        c = core.db()
        c.execute("UPDATE orders SET customer_name='Noy', customer_phone='020111' WHERE id IN (?,?)", (a1, a2))
        c.execute("UPDATE orders SET customer_name='Kham', customer_phone='' WHERE id=?", (n1,))
        c.execute("UPDATE orders SET customer_name='ลูกค้า', customer_phone='' WHERE id=?", (anon,))
        c.commit()
    ok(pay(shop, a1, payment_method='cash', cash_received=65000))
    ok(pay(shop, a2, payment_method='qr'))
    rows = ok(call(shop, 'staff', 'GET', f'/api/customers?branch_id={b}'))['customers']
    assert [(r['name'], r['phone'], r['visits'], r['total_spent']) for r in rows] == [('Noy', '020111', 2, 130000.0), ('Kham', '', 1, 0.0)]
    assert [r['name'] for r in ok(call(shop, 'staff', 'GET', f'/api/customers?branch_id={b}&q=kha'))['customers']] == ['Kham']
    mine = ok(call(shop, 'staff', 'GET', f'/api/orders?branch_id={b}&customer_name=kham'))['orders']
    assert [o['id'] for o in mine] == [n1]


def test_report_has_hourly_sales_in_restaurant_time(shop):
    open_shift(shop)
    oid = order(shop)
    ok(pay(shop, oid, payment_method='cash', cash_received=65000))
    with core.app.app_context():
        c = core.db()
        paid_at = c.execute('SELECT paid_at FROM orders WHERE id=?', (oid,)).fetchone()['paid_at']
    hour = core.datetime.fromisoformat(paid_at).astimezone(core.RESTAURANT_TZ).hour
    r = ok(call(shop, 'owner', 'GET', f"/api/reports/summary?branch_id={shop['branch']}"))
    assert len(r['hourly']) == 24
    assert r['hourly'][hour] == {'hour': hour, 'total': 65000.0, 'orders': 1}
    assert sum(h['total'] for h in r['hourly']) == 65000.0
