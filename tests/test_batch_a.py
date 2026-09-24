"""Batch A — stable, fast service: kitchen slips for cancelled food and table moves, fixing
mistakes before the kitchen gets them, sold-out updates reaching every screen, and a sales day
that can start after midnight (shops that sell past 00:00).

Run: python -m pytest tests/test_batch_a.py -q
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_money_reconciliation import call, core, ok, open_shift, order, pay, shop  # noqa: E402,F401
from test_printing import FakePrinter, _jobs, _only_this_shop, _wait, add_printer, local_print  # noqa: E402,F401
import printing  # noqa: E402


def _items(oid):
    with core.app.app_context():
        return [dict(r) for r in core.db().execute('SELECT * FROM order_items WHERE order_id=? ORDER BY id', (oid,)).fetchall()]


def send(shop, oid, ids):
    return ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': ids}))


def test_fixing_an_unsent_item_needs_no_manager(shop):
    oid = order(shop)
    noodle, beer = _items(oid)
    body = ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/items/{beer["id"]}/cancel', {}))
    assert body['kitchen_slip'] is None and body['printed_by_server'] is False
    body = ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/items/{noodle["id"]}/quantity', {'quantity': 1}))
    assert body['quantity'] == 1 and body['kitchen_slip'] is None
    with core.app.app_context():
        ops = core.db().execute("SELECT operation_type,reason_text,detail FROM critical_operations WHERE tenant_id=? ORDER BY id", (shop['tenant'],)).fetchall()
    assert [(o['operation_type'], o['reason_text']) for o in ops] == [('cancel_item', 'แก้ไขก่อนส่งครัว'), ('reduce_item_quantity', 'แก้ไขก่อนส่งครัว')]
    assert all(o['detail'].endswith('unsent') for o in ops), 'still audited'


def test_cancelling_sent_food_needs_approval_and_tells_the_kitchen(shop):
    oid = order(shop)
    noodle, beer = _items(oid)
    send(shop, oid, [noodle['id'], beer['id']])
    code, body = call(shop, 'staff', 'PUT', f'/api/orders/{oid}/items/{noodle["id"]}/cancel', {'reason': 'ของหมด'})
    assert code == 403, 'sent food still needs a manager'
    body = ok(call(shop, 'owner', 'PUT', f'/api/orders/{oid}/items/{noodle["id"]}/cancel', {'reason': 'ของหมด', 'quantity': 1, 'mark_sold_out': True}))
    assert body['kitchen_slip']['kind'] == 'void' and body['kitchen_slip']['items'] == [{'name': 'Noodles', 'name2': '', 'qty': 1}]
    void = [j for j in _jobs(shop) if j['job_type'] == 'void']
    assert len(void) == 1 and json.loads(void[0]['payload'])['reason'] == 'ของหมด'
    code, body = call(shop, 'staff', 'PUT', f'/api/orders/{oid}/items/{beer["id"]}/quantity', {'quantity': 0})
    assert code == 400
    with core.app.app_context():
        assert core.db().execute('SELECT sold_out FROM menu_items WHERE id=?', (shop['noodle'],)).fetchone()['sold_out'] == 1
    # sold-out reaches the floor poll and the customer QR page
    listing = ok(call(shop, 'staff', 'GET', f"/api/orders?branch_id={shop['branch']}"))
    assert listing['sold_out_ids'] == [shop['noodle']]
    with core.app.test_client() as c:
        assert c.get(f"/api/public/sold-out?branch_id={shop['branch']}").get_json()['ids'] == [shop['noodle']]
    ok(call(shop, 'staff', 'PUT', f"/api/menu-items/{shop['noodle']}/sold-out", {'sold_out': False}))
    assert ok(call(shop, 'staff', 'GET', f"/api/orders?branch_id={shop['branch']}"))['sold_out_ids'] == []


def test_moving_a_table_with_food_in_the_kitchen_prints_a_move_note(shop):
    oid = order(shop, table=0)
    ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/move-table', {'table_id': shop['tables'][1]}))
    assert not [j for j in _jobs(shop) if j['job_type'] == 'move'], 'nothing cooking yet: no note'
    send(shop, oid, [i['id'] for i in _items(oid)])
    body = ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/move-table', {'table_id': shop['tables'][2]}))
    assert body['kitchen_slip'] == {'from': 'T1', 'to': 'T2', 'kind': 'move', 'order_no': body['kitchen_slip']['order_no']}
    moves = [j for j in _jobs(shop) if j['job_type'] == 'move']
    assert len(moves) == 1 and json.loads(moves[0]['payload']) == {'from': 'T1', 'to': 'T2'}


def test_void_and_move_notes_print_on_the_kitchen_printer(shop, local_print):
    _only_this_shop(shop)
    add_printer(shop, local_print.port, role='kitchen')
    oid = order(shop)
    noodle = _items(oid)[0]
    send(shop, oid, [noodle['id']])
    printing.process_once(core)
    ok(call(shop, 'owner', 'PUT', f'/api/orders/{oid}/items/{noodle["id"]}/cancel', {'reason': 'ลูกค้าเปลี่ยนใจ', 'quantity': 1}))
    ok(call(shop, 'owner', 'PUT', f'/api/orders/{oid}/move-table', {'table_id': shop['tables'][1]}))
    printing.process_once(core)
    assert _wait(lambda: len(local_print.received) == 3)
    done = [j for j in _jobs(shop) if j['job_type'] in ('void', 'move')]
    assert [j['status'] for j in done] == ['printed', 'printed']


def test_sales_day_can_start_after_midnight(shop):
    open_shift(shop)
    oid = order(shop)
    ok(pay(shop, oid, payment_method='cash', cash_received=65000))
    # paid at 02:30 Vientiane time on 2026-05-11 = still the 10 May sales day when the day starts at 04:00
    local = datetime(2026, 5, 11, 2, 30, tzinfo=core.RESTAURANT_TZ)
    ts = local.astimezone(timezone.utc).isoformat(timespec='seconds')
    with core.app.app_context():
        c = core.db()
        c.execute('UPDATE orders SET paid_at=?,created_at=? WHERE id=?', (ts, ts, oid))
        c.execute('UPDATE payments SET paid_at=? WHERE order_id=?', (ts, oid))
        c.commit()
    rep = lambda d: ok(call(shop, 'owner', 'GET', f"/api/reports/summary?branch_id={shop['branch']}&from={d}&to={d}"))
    assert rep('2026-05-11')['order_count'] == 1 and rep('2026-05-10')['order_count'] == 0
    settings = ok(call(shop, 'owner', 'GET', f"/api/settings/receipt?branch_id={shop['branch']}"))
    settings.update(branch_id=shop['branch'], day_cutoff_hour='4')
    ok(call(shop, 'owner', 'PUT', '/api/settings/receipt', settings))
    r10 = rep('2026-05-10')
    assert r10['order_count'] == 1 and r10['day_cutoff_hour'] == 4 and rep('2026-05-11')['order_count'] == 0
    hist = ok(call(shop, 'staff', 'GET', f"/api/orders?branch_id={shop['branch']}&date_from=2026-05-10&date_to=2026-05-10"))['orders']
    assert [o['id'] for o in hist] == [oid]
    boot = ok(call(shop, 'staff', 'GET', '/api/bootstrap'))
    assert boot['day_cutoff'][str(shop['branch'])] == 4
    settings.update(day_cutoff_hour='9')
    assert ok(call(shop, 'owner', 'PUT', '/api/settings/receipt', settings))['settings']['day_cutoff_hour'] == '0', 'only 0-6 allowed'


def test_business_today_helper():
    now = datetime.now(core.RESTAURANT_TZ)
    assert core.restaurant_today(0) == now.date().isoformat()
    assert core.restaurant_today(4) == (now - timedelta(hours=4)).date().isoformat()


def test_reducing_sent_food_can_mark_the_dish_sold_out(shop):
    oid = order(shop)
    noodle, beer = _items(oid)
    send(shop, oid, [noodle['id']])
    body = ok(call(shop, 'owner', 'PUT', f'/api/orders/{oid}/items/{noodle["id"]}/quantity', {'quantity': 1, 'reason': 'ของหมด', 'mark_sold_out': True}))
    assert body['kitchen_slip']['items'][0]['qty'] == 1
    assert ok(call(shop, 'staff', 'GET', f"/api/orders?branch_id={shop['branch']}"))['sold_out_ids'] == [shop['noodle']]
