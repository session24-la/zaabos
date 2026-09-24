"""Batch B — per-line order tools: dishes priced when ordered, special price / free item with a
manager's approval (approval token, password never kept in the browser), takeaway for one dish,
"rush" for food already in the kitchen, quick note buttons.

Run: python -m pytest tests/test_batch_b.py -q
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_money_reconciliation import assert_ledger, call, core, ok, open_shift, order, pay, shop  # noqa: E402,F401
from test_printing import FakePrinter, _jobs, _only_this_shop, _wait, add_printer, local_print  # noqa: E402,F401
import printing  # noqa: E402

MANAGER_PW = 'manager-pass-123'


@pytest.fixture
def mshop(shop):
    """shop + a manager who can approve, and a dish priced when ordered (seafood by weight)."""
    with core.app.app_context():
        c = core.db()
        shop['manager_name'] = f"mgr-{shop['tenant']}"
        shop['users']['manager'] = c.execute('INSERT INTO users(tenant_id,username,password_hash,display_name,role,created_at) VALUES(?,?,?,?,?,?)',
                                             (shop['tenant'], shop['manager_name'], core.hash_password(MANAGER_PW), 'Manager', 'manager', core.now())).lastrowid
        cat = c.execute('SELECT category_id FROM menu_items WHERE id=?', (shop['noodle'],)).fetchone()['category_id']
        shop['fish'] = c.execute('INSERT INTO menu_items(tenant_id,branch_id,category_id,name,base_price,open_price,created_at) VALUES(?,?,?,?,?,?,?)',
                                 (shop['tenant'], shop['branch'], cat, 'Grilled fish', 0, 1, core.now())).lastrowid
        c.commit()
    return shop


def _items(oid):
    with core.app.app_context():
        return [dict(r) for r in core.db().execute('SELECT * FROM order_items WHERE order_id=? ORDER BY id', (oid,)).fetchall()]


def _ops(shop, kind):
    with core.app.app_context():
        return [dict(r) for r in core.db().execute('SELECT * FROM critical_operations WHERE tenant_id=? AND operation_type=? ORDER BY id',
                                                   (shop['tenant'], kind)).fetchall()]


def new_order(shop, cart, who='staff', **extra):
    body = {'branch_id': shop['branch'], 'order_type': 'dine_in', 'table_id': shop['tables'][0], 'cart': cart}
    body.update(extra)
    return call(shop, who, 'POST', '/api/orders', body)


def approval(shop, password=MANAGER_PW, who='staff'):
    return call(shop, who, 'POST', '/api/approvals', {'approval_username': shop['manager_name'], 'approval_password': password})


def test_open_price_dish_needs_a_price_from_staff_and_is_not_for_qr(mshop):
    code, body = new_order(mshop, [{'menu_item_id': mshop['fish'], 'quantity': 1}])
    assert code == 400 and 'ราคา' in body['error']
    oid = ok(new_order(mshop, [{'menu_item_id': mshop['fish'], 'quantity': 2, 'price': 120000}]))['order_id']
    fish = _items(oid)[0]
    assert fish['unit_price'] == 120000 and fish['line_total'] == 240000 and fish['list_price'] is None and fish['price_reason'] == ''
    assert not _ops(mshop, 'reprice_item'), 'a normal open-price sale is not a price change'
    with core.app.test_client() as c:
        r = c.post('/api/public/orders', json={'branch_id': mshop['branch'], 'order_type': 'dine_in', 'table_token': f"{mshop['tables'][0]}",
                                               'cart': [{'menu_item_id': mshop['fish'], 'quantity': 1, 'price': 1}]})
    assert r.status_code == 400


def test_customer_qr_cannot_set_prices_or_takeaway(mshop):
    with core.app.app_context():
        token = core.db().execute('SELECT qr_token FROM dining_tables WHERE id=?', (mshop['tables'][1],)).fetchone()['qr_token']
    with core.app.test_client() as c:
        r = c.post('/api/public/orders', json={'branch_id': mshop['branch'], 'order_type': 'dine_in', 'table_token': token,
                                               'cart': [{'menu_item_id': mshop['noodle'], 'quantity': 1, 'price': 1, 'takeaway': True}]})
    assert r.status_code == 200, r.get_json()
    it = _items(r.get_json()['order_id'])[0]
    assert it['unit_price'] == 25000 and it['takeaway'] == 0 and it['list_price'] is None


def test_special_price_and_free_item_need_a_manager(mshop):
    cart = [{'menu_item_id': mshop['noodle'], 'quantity': 1, 'price': 20000, 'price_reason': 'ลูกค้าประจำ'},
            {'menu_item_id': mshop['beer'], 'quantity': 1, 'price': 0}]
    code, body = new_order(mshop, cart)
    assert code == 403 and body['code'] == 'approval_required'
    code, body = approval(mshop, password='wrong')
    assert code == 403
    token = ok(approval(mshop))['approval_token']
    oid = ok(new_order(mshop, cart, approval_token=token))['order_id']
    noodle, beer = _items(oid)
    assert (noodle['unit_price'], noodle['list_price'], noodle['price_reason']) == (20000, 25000, 'ลูกค้าประจำ')
    assert (beer['unit_price'], beer['list_price'], beer['price_reason']) == (0, 15000, 'ของแถม')
    assert [o['approved_by_user_id'] for o in _ops(mshop, 'reprice_item')] == [mshop['users']['manager']]
    assert [o['approved_by_user_id'] for o in _ops(mshop, 'free_item')] == [mshop['users']['manager']]
    # the owner needs nobody; a higher price needs nobody either (still audited)
    ok(new_order(mshop, [{'menu_item_id': mshop['beer'], 'quantity': 1, 'price': 0}], who='owner'))
    oid = ok(new_order(mshop, [{'menu_item_id': mshop['beer'], 'quantity': 1, 'price': 18000}]))['order_id']
    assert _items(oid)[0]['list_price'] == 15000
    # the bill and the money reconcile with the changed prices
    open_shift(mshop)
    ok(pay(mshop, oid, payment_method='cash', cash_received=18000))
    assert_ledger(mshop)


def test_approval_token_belongs_to_one_staff_member_and_expires(mshop, monkeypatch):
    token = ok(approval(mshop))['approval_token']
    cart = [{'menu_item_id': mshop['beer'], 'quantity': 1, 'price': 0}]
    code, body = new_order(mshop, cart, who='staff2', approval_token=token)
    assert code == 403, 'another staff member cannot reuse it'
    monkeypatch.setattr(core, 'APPROVAL_TTL', -1)
    code, body = new_order(mshop, cart, approval_token=token)
    assert code == 403 and body['code'] == 'approval_required'
    monkeypatch.setattr(core, 'APPROVAL_TTL', 900)
    # the same approval also works for the other manager-only actions (void food already sent)
    oid = order(mshop)
    noodle = _items(oid)[0]
    ok(call(mshop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': [noodle['id']]}))
    ok(call(mshop, 'staff', 'PUT', f"/api/orders/{oid}/items/{noodle['id']}/cancel", {'reason': 'ของหมด', 'quantity': 1, 'approval_token': token}))


def test_reprice_a_line_on_the_bill(mshop):
    oid = order(mshop)
    noodle = _items(oid)[0]
    url = f"/api/orders/{oid}/items/{noodle['id']}/price"
    code, _ = call(mshop, 'staff', 'PUT', url, {'price': 0})
    assert code == 403
    token = ok(approval(mshop))['approval_token']
    body = ok(call(mshop, 'staff', 'PUT', url, {'price': 0, 'approval_token': token}))
    assert body['total_amount'] == 15000 and body['price_reason'] == 'ของแถม' and body['list_price'] == 25000
    # raising it back to the menu price needs nobody and clears the mark
    body = ok(call(mshop, 'staff', 'PUT', url, {'price': 25000}))
    assert body['list_price'] is None and body['price_reason'] == '' and body['total_amount'] == 65000
    assert len(_ops(mshop, 'free_item')) == 1 and len(_ops(mshop, 'reprice_item')) == 1
    with core.app.app_context():
        assert core.db().execute('SELECT total_amount FROM orders WHERE id=?', (oid,)).fetchone()['total_amount'] == 65000


def test_takeaway_for_one_dish(mshop):
    oid = ok(new_order(mshop, [{'menu_item_id': mshop['noodle'], 'quantity': 1, 'takeaway': True, 'notes': 'ບໍ່ເຜັດ'},
                               {'menu_item_id': mshop['beer'], 'quantity': 1}]))['order_id']
    noodle, beer = _items(oid)
    assert noodle['takeaway'] == 1 and beer['takeaway'] == 0
    with core.app.app_context():
        printed = printing._items_for(core.db(), oid)
    assert [i['takeaway'] for i in printed] == [True, False]
    lines = printing.kitchen_lines({'table_name_snapshot': 'T0', 'order_type': 'dine_in', 'order_no': 'X', 'notes': ''}, printed, '', core.RESTAURANT_TZ)
    texts = [l.get('text') or '' for l in lines]
    assert texts.index('   * ບໍ່ເຜັດ') < texts.index('   >> ห่อกลับ / ຫໍ່ກັບ') and sum('ห่อกลับ' in t for t in texts) == 1
    # not sent yet: no note for the kitchen
    body = ok(call(mshop, 'staff', 'PUT', f"/api/orders/{oid}/items/{beer['id']}/takeaway", {'takeaway': True}))
    assert body['kitchen_slip'] is None
    ok(call(mshop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': [noodle['id']]}))
    body = ok(call(mshop, 'staff', 'PUT', f"/api/orders/{oid}/items/{noodle['id']}/takeaway", {'takeaway': False}))
    assert body['kitchen_slip']['kind'] == 'takeaway' and 'ทานที่ร้าน' in body['kitchen_slip']['title']
    assert [j['job_type'] for j in _jobs(mshop) if j['job_type'] == 'takeaway'] == ['takeaway']


def test_rush_only_food_in_the_kitchen(mshop):
    oid = order(mshop)
    noodle, beer = _items(oid)
    code, body = call(mshop, 'staff', 'POST', f'/api/orders/{oid}/rush', {})
    assert code == 400
    ok(call(mshop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': [noodle['id']]}))
    body = ok(call(mshop, 'staff', 'POST', f'/api/orders/{oid}/rush', {}))
    assert body['item_ids'] == [noodle['id']] and body['kitchen_slip']['items'] == [{'name': 'Noodles', 'name2': '', 'qty': 2}]
    assert _items(oid)[0]['rush_at'] and not _items(oid)[1]['rush_at']
    rush = [j for j in _jobs(mshop) if j['job_type'] == 'rush']
    assert len(rush) == 1 and json.loads(rush[0]['payload'])['title'].startswith('เร่ง')
    # the kitchen screen sees it
    kitchen = ok(call(mshop, 'staff', 'GET', f"/api/kitchen/orders?branch_id={mshop['branch']}"))['orders']
    assert [i['rush_at'] is not None for o in kitchen if o['id'] == oid for i in o['items']] == [True, False]


def test_rush_and_takeaway_notes_print_on_the_kitchen_printer(mshop, local_print):
    _only_this_shop(mshop)
    add_printer(mshop, local_print.port, role='kitchen')
    oid = order(mshop)
    noodle = _items(oid)[0]
    ok(call(mshop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': [noodle['id']]}))
    printing.process_once(core)
    ok(call(mshop, 'staff', 'POST', f'/api/orders/{oid}/rush', {}))
    ok(call(mshop, 'staff', 'PUT', f"/api/orders/{oid}/items/{noodle['id']}/takeaway", {'takeaway': True}))
    printing.process_once(core)
    assert _wait(lambda: len(local_print.received) == 3)
    assert [j['status'] for j in _jobs(mshop) if j['job_type'] in ('rush', 'takeaway')] == ['printed', 'printed']


def test_split_keeps_price_marks_and_takeaway(mshop):
    token = ok(approval(mshop))['approval_token']
    oid = ok(new_order(mshop, [{'menu_item_id': mshop['noodle'], 'quantity': 2, 'price': 0, 'takeaway': True}], approval_token=token))['order_id']
    it = _items(oid)[0]
    new_id = ok(call(mshop, 'staff', 'POST', f'/api/orders/{oid}/split', {'items': [{'item_id': it['id'], 'quantity': 1}]}))['new_order_id']
    moved = _items(new_id)[0]
    assert (moved['unit_price'], moved['list_price'], moved['price_reason'], moved['takeaway']) == (0, 25000, 'ของแถม', 1)


def test_receipt_says_free(mshop):
    lines = printing.receipt_lines(
        {'table_name_snapshot': 'T0', 'order_type': 'dine_in', 'order_no': 'X', 'guest_count': 2, 'discount_amount': 0, 'discount_label': '',
         'service_charge_amount': 0, 'tax_amount': 0, 'delivery_fee': 0, 'total_amount': 25000, 'grand_total': 25000, 'created_at': None,
         'paid_at': None, 'cash_received': None, 'notes': '', 'payment_status': 'unpaid'},
        [{'qty': 1, 'name': 'Noodles', 'unit_price': 25000}, {'qty': 1, 'name': 'Beer', 'unit_price': 0, 'price_reason': 'ของแถม'}],
        [], {'shop_name': 'S'}, core.RESTAURANT_TZ, lang='lo')
    rows = [l for l in lines if l.get('qty')]
    assert rows[1]['right'] == 'ແຖມ' and rows[0]['right'] != 'ແຖມ'


def test_quick_note_buttons_follow_the_menu_language_and_can_be_edited(mshop):
    boot = ok(call(mshop, 'staff', 'GET', '/api/bootstrap'))
    assert boot['quick_notes'][str(mshop['branch'])][0] == 'ไม่เผ็ด'
    settings = ok(call(mshop, 'owner', 'GET', f"/api/settings/receipt?branch_id={mshop['branch']}"))
    settings.update(branch_id=mshop['branch'], menu_lang_primary='lo')
    ok(call(mshop, 'owner', 'PUT', '/api/settings/receipt', settings))
    assert ok(call(mshop, 'staff', 'GET', '/api/bootstrap'))['quick_notes'][str(mshop['branch'])][:2] == ['ບໍ່ເຜັດ', 'ເຜັດໜ້ອຍ']
    settings.update(quick_notes='ບໍ່ເຜັດ,  ສຸກ\nສຸກ\n' + 'x' * 50)
    saved = ok(call(mshop, 'owner', 'PUT', '/api/settings/receipt', settings))['settings']['quick_notes']
    assert saved.split('\n') == ['ບໍ່ເຜັດ', 'ສຸກ', 'x' * 30]
    assert ok(call(mshop, 'staff', 'GET', '/api/bootstrap'))['quick_notes'][str(mshop['branch'])] == ['ບໍ່ເຜັດ', 'ສຸກ', 'x' * 30]


def test_menu_item_open_price_flag(mshop):
    body = ok(call(mshop, 'owner', 'POST', '/api/menu-items', {'branch_id': mshop['branch'], 'name': 'Crab', 'base_price': 0, 'open_price': True}))
    ok(call(mshop, 'owner', 'PUT', f"/api/menu-items/{body['id']}", {'name': 'Crab (kg)'}))
    items = {i['id']: i for i in ok(call(mshop, 'staff', 'GET', '/api/bootstrap'))['items']}
    assert items[body['id']]['open_price'] == 1, 'an edit that does not send the flag keeps it'
    ok(call(mshop, 'owner', 'PUT', f"/api/menu-items/{body['id']}", {'open_price': False}))
    assert {i['id']: i for i in ok(call(mshop, 'staff', 'GET', '/api/bootstrap'))['items']}[body['id']]['open_price'] == 0


def test_customer_menu_hides_cost_price_and_stock(mshop):
    with core.app.app_context():
        c = core.db()
        c.execute('UPDATE menu_items SET cost_price=9000, track_stock=1, stock_qty=7 WHERE id=?', (mshop['noodle'],))
        c.commit()
    with core.app.test_client() as client:
        items = client.get(f"/api/public/menu?branch_id={mshop['branch']}").get_json()['items']
    noodle = next(i for i in items if i['id'] == mshop['noodle'])
    assert noodle['base_price'] == 25000 and 'cost_price' not in noodle and 'stock_qty' not in noodle
    assert next(i for i in items if i['id'] == mshop['fish'])['open_price'] == 1
