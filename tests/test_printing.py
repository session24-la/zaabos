"""Step 3 — network printing (RP331-class ESC/POS printer on raw TCP 9100).

A fake printer listens on a local port and records what it receives, so the whole path —
send to kitchen -> job -> render -> ESC/POS over TCP -> printed/failed -> reprint — is real.
"""
import json
import socket
import threading

import pytest

pytest.importorskip('PIL')

from test_money_reconciliation import call, core, ok, open_shift, order, pay, shop  # noqa: F401  (fixture)
import printing  # noqa: E402


class FakePrinter:
    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(('127.0.0.1', 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.received = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            data = b''
            with conn:
                while True:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    data += chunk
            self.received.append(data)

    def close(self):
        self.sock.close()


@pytest.fixture
def local_print(monkeypatch):
    monkeypatch.setenv('ZAABOS_LOCAL_PRINT', '1')
    printer = FakePrinter()
    yield printer
    printer.close()


def _wait(pred, timeout=5):
    import time
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    return pred()


def _jobs(shop, status=None):
    with core.app.app_context():
        q = 'SELECT * FROM kitchen_print_jobs WHERE tenant_id=?' + (' AND status=?' if status else '') + ' ORDER BY id'
        return [dict(r) for r in core.db().execute(q, (shop['tenant'], status) if status else (shop['tenant'],)).fetchall()]


def _only_this_shop(shop):
    """Other tests leave pending jobs from other shops in the same database; park them."""
    with core.app.app_context():
        c = core.db()
        c.execute("UPDATE kitchen_print_jobs SET status='parked' WHERE tenant_id<>? AND status='pending'", (shop['tenant'],))
        c.commit()


def add_printer(shop, port, role='receipt', host='127.0.0.1'):
    return ok(call(shop, 'owner', 'POST', '/api/printers', {'branch_id': shop['branch'], 'name': f'RP331 {role}', 'role': role,
                                                           'host': host, 'port': port, 'paper_width': '80'}))['id']


def test_escpos_raster_is_well_formed():
    img = printing.render(printing.test_lines('RP331'), '80')
    data = printing.escpos(img)
    assert img.width == 576 and data.startswith(b'\x1b@') and b'\x1dv0\x00' in data and data.endswith(b'\x1dVB\x00')
    wb = 576 // 8
    # every raster band header declares exactly the bytes that follow it
    i, total_rows = 0, 0
    while True:
        i = data.find(b'\x1dv0\x00', i)
        if i < 0:
            break
        w = data[i + 4] | data[i + 5] << 8
        h = data[i + 6] | data[i + 7] << 8
        assert w == wb
        total_rows += h
        i += 8 + w * h
    assert total_rows == img.height


def test_kitchen_ticket_prints_on_wifi_printer_without_browser(shop, local_print):
    _only_this_shop(shop)
    add_printer(shop, local_print.port, role='kitchen')
    oid = order(shop)
    items = [r['id'] for r in _items(oid)]
    body = ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': items[:1]}))
    assert body['printed_by_server'] is True, 'browser must not also open a print dialog'
    assert printing.process_once(core) == 1
    assert _wait(lambda: len(local_print.received) == 1)
    job = _jobs(shop)[-1]
    assert job['status'] == 'printed' and json.loads(job['item_ids']) == items[:1]
    assert local_print.received[0].startswith(b'\x1b@')


def test_receipt_is_queued_and_printed(shop, local_print):
    _only_this_shop(shop)
    add_printer(shop, local_print.port, role='receipt')
    open_shift(shop)
    oid = order(shop)
    ok(pay(shop, oid, payment_method='cash', cash_received=100000))
    assert ok(call(shop, 'staff', 'POST', f'/api/orders/{oid}/print-receipt'))['queued'] is True
    printing.process_once(core)
    assert _wait(lambda: len(local_print.received) == 1)
    assert _jobs(shop, 'printed')[-1]['job_type'] == 'receipt'


def test_printer_off_marks_failed_then_reprint_works(shop, local_print, monkeypatch):
    _only_this_shop(shop)
    dead = socket.socket(); dead.bind(('127.0.0.1', 0)); dead_port = dead.getsockname()[1]; dead.close()
    pid = add_printer(shop, dead_port, role='kitchen')
    monkeypatch.setattr(printing, 'RETRY_SECONDS', 0)
    oid = order(shop)
    ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': [r['id'] for r in _items(oid)]}))
    for _ in range(printing.MAX_ATTEMPTS):
        printing.process_once(core)
    failed = ok(call(shop, 'staff', 'GET', f"/api/print/jobs?branch_id={shop['branch']}&status=failed"))
    assert len(failed) == 1 and failed[0]['attempts'] == printing.MAX_ATTEMPTS and failed[0]['last_error']
    assert ok(call(shop, 'staff', 'GET', f"/api/printers?branch_id={shop['branch']}"))['failed'] == 1
    # Printer is fixed (moved to the working one); staff presses reprint once -> exactly one ticket.
    with core.app.app_context():
        c = core.db(); c.execute('UPDATE printers SET port=? WHERE id=?', (local_print.port, pid)); c.commit()
    ok(call(shop, 'staff', 'POST', f"/api/print/jobs/{failed[0]['id']}/retry"))
    printing.process_once(core)
    printing.process_once(core)
    assert _wait(lambda: len(local_print.received) == 1)
    assert not _jobs(shop, 'failed') and not _jobs(shop, 'pending')


def test_station_printers_get_only_their_items(shop, local_print):
    _only_this_shop(shop)
    bar = FakePrinter()
    try:
        with core.app.app_context():
            c = core.db()
            st = c.execute('INSERT INTO kitchen_stations(tenant_id,branch_id,name,created_at) VALUES(?,?,?,?)',
                           (shop['tenant'], shop['branch'], 'Bar', core.now())).lastrowid
            c.execute('UPDATE menu_items SET kitchen_station_id=? WHERE id=?', (st, shop['beer']))
            c.commit()
        add_printer(shop, local_print.port, role='kitchen')             # default kitchen printer
        ok(call(shop, 'owner', 'POST', '/api/printers', {'branch_id': shop['branch'], 'name': 'Bar', 'role': 'kitchen',
                                                         'host': '127.0.0.1', 'port': bar.port, 'station_id': st}))
        oid = order(shop)
        ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': [r['id'] for r in _items(oid)]}))
        printing.process_once(core)
        assert _wait(lambda: len(local_print.received) == 1 and len(bar.received) == 1)
        by_station = {j['station_id']: json.loads(j['item_ids']) for j in _jobs(shop)}
        noodle_item, beer_item = [r['id'] for r in _items(oid)]
        assert by_station == {None: [noodle_item], st: [beer_item]}
    finally:
        bar.close()


def test_cloud_server_never_claims_print_jobs(shop, monkeypatch):
    """zaabos.com cannot reach a printer in the shop: without ZAABOS_LOCAL_PRINT the browser keeps printing."""
    monkeypatch.delenv('ZAABOS_LOCAL_PRINT', raising=False)
    add_printer(shop, 9100, role='kitchen', host='192.0.2.10')
    oid = order(shop)
    body = ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': [r['id'] for r in _items(oid)]}))
    assert body['printed_by_server'] is False
    assert ok(call(shop, 'staff', 'POST', f'/api/orders/{oid}/print-receipt'))['queued'] is False
    code, _ = call(shop, 'owner', 'POST', f"/api/printers/{add_printer(shop, 9100, host='192.0.2.11')}/test")
    assert code == 409


def test_printer_input_is_validated(shop):
    for bad in ({'host': 'http://1.2.3.4'}, {'host': ''}, {'port': 70000}, {'role': 'fax'}, {'paper_width': '72'}):
        data = {'branch_id': shop['branch'], 'name': 'P', 'role': 'receipt', 'host': '192.168.1.50', 'port': 9100}
        data.update(bad)
        code, _ = call(shop, 'owner', 'POST', '/api/printers', data)
        assert code == 400, bad
    code, _ = call(shop, 'staff', 'POST', '/api/printers', {'branch_id': shop['branch'], 'name': 'P', 'host': '192.168.1.50'})
    assert code == 403


def _items(oid):
    with core.app.app_context():
        return [dict(r) for r in core.db().execute('SELECT * FROM order_items WHERE order_id=? ORDER BY id', (oid,)).fetchall()]


@pytest.fixture
def fake_cups(tmp_path, monkeypatch):
    """Stand-in lp/lpstat/cancel on PATH. `offline` file present = printer never takes the job."""
    import os, stat
    bindir = tmp_path / 'bin'; bindir.mkdir()
    state = tmp_path / 'cups'; state.mkdir()
    scripts = {
        'lp': f'#!/bin/sh\ncat > "{state}/job.bin"\necho "request id is RP331-7 (1 file(s))"\n',
        'lpstat': f'#!/bin/sh\nif [ "$1" = "-e" ]; then echo _RP331; exit 0; fi\n'
                  f'if [ -f "{state}/offline" ] && [ ! -f "{state}/cancelled" ]; then echo "RP331-7 kot 100 now"; fi\n',
        'cancel': f'#!/bin/sh\ntouch "{state}/cancelled"\n',
    }
    for name, body in scripts.items():
        f = bindir / name; f.write_text(body); f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv('PATH', f'{bindir}{os.pathsep}{os.environ["PATH"]}')
    monkeypatch.setattr(printing, 'SYSTEM_WAIT_SECONDS', 1)
    return state


def test_usb_printer_prints_through_os_queue(shop, local_print, fake_cups):
    _only_this_shop(shop)
    queues = ok(call(shop, 'owner', 'GET', '/api/printers/system'))['queues']
    assert queues == ['_RP331']
    pid = ok(call(shop, 'owner', 'POST', '/api/printers', {'branch_id': shop['branch'], 'name': 'RP331', 'role': 'receipt',
                                                           'connection': 'system', 'host': '_RP331'}))['id']
    ok(call(shop, 'owner', 'POST', f'/api/printers/{pid}/test'))
    assert (fake_cups / 'job.bin').read_bytes().startswith(b'\x1b@')
    code, _ = call(shop, 'owner', 'POST', '/api/printers', {'branch_id': shop['branch'], 'name': 'X', 'connection': 'system', 'host': '_Nope'})
    assert code == 400


def test_usb_printer_offline_cancels_job_so_it_never_prints_late(shop, local_print, fake_cups, monkeypatch):
    _only_this_shop(shop)
    (fake_cups / 'offline').touch()
    monkeypatch.setattr(printing, 'RETRY_SECONDS', 0)
    ok(call(shop, 'owner', 'POST', '/api/printers', {'branch_id': shop['branch'], 'name': 'RP331', 'role': 'kitchen',
                                                     'connection': 'system', 'host': '_RP331'}))
    oid = order(shop)
    ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': [r['id'] for r in _items(oid)]}))
    printing.process_once(core)
    assert (fake_cups / 'cancelled').exists(), 'a job the printer did not take must be cancelled in the OS queue'
    job = _jobs(shop)[-1]
    assert job['status'] == 'pending' and 'USB' in job['last_error']


def test_receipt_matches_web_receipt_fields(shop, local_print):
    """Printed receipt uses the same settings and words as the browser receipt: shop name,
    subtitle, table/guest row, currency symbol, Buddhist year in Thai, screen language, delivery."""
    from zoneinfo import ZoneInfo
    order_row = {'total_amount': 50000, 'discount_amount': 0, 'service_charge_amount': 0, 'tax_amount': 0, 'delivery_fee': 10000,
                 'order_no': 'Z-1', 'table_name_snapshot': 'โต๊ะ 2', 'guest_count': 3, 'payment_status': 'paid', 'payment_method': 'cash',
                 'discount_label': '', 'created_at': '2026-09-23T05:42:00+00:00', 'paid_at': '2026-09-23T05:42:00+00:00'}
    items = [{'qty': 2, 'name': 'น้ำเปล่า', 'unit_price': 5000, 'options': [], 'notes': ''}]
    pays = [{'payment_method': 'cash', 'amount': 60000, 'cash_received': 100000}]
    rs = {'shop_name': 'ร้านของฉัน', 'footer': 'ขอบใจ', 'show_guest': True}
    th = printing.receipt_lines(order_row, items, pays, rs, ZoneInfo('Asia/Vientiane'), 'Kot', 'th', 'LAK')
    flat = json.dumps(th, ensure_ascii=False)
    for want in ('ร้านของฉัน', 'ยอดก่อนภาษี', '₭60,000', '₭40,000', 'ค่าส่ง', '23/09/2569 12:42', 'ลูกค้า', 'Kot', 'ขอบใจ'):
        assert want in flat, want
    lo = json.dumps(printing.receipt_lines(order_row, items, pays, rs, ZoneInfo('Asia/Vientiane'), '', 'lo', 'LAK'), ensure_ascii=False)
    assert 'ລວມ' in lo and '23/09/2026' in lo
    printing.render(th, '80', printing.FONT_SCALE['large'])   # renders without error at every scale


def test_one_printer_can_do_receipts_and_kitchen_and_be_reassigned(shop, local_print):
    _only_this_shop(shop)
    a = add_printer(shop, local_print.port, role='none')
    b = add_printer(shop, local_print.port, role='none')
    for job in ('receipt', 'kitchen'):
        ok(call(shop, 'owner', 'PUT', '/api/printers/assign', {'branch_id': shop['branch'], 'job': job, 'printer_id': a}))
    roles = {p['id']: p['role'] for p in ok(call(shop, 'owner', 'GET', f"/api/printers?branch_id={shop['branch']}"))['printers']}
    assert roles == {a: 'both', b: 'none'}
    # Kitchen moves to B; A keeps receipts only.
    ok(call(shop, 'owner', 'PUT', '/api/printers/assign', {'branch_id': shop['branch'], 'job': 'kitchen', 'printer_id': b}))
    roles = {p['id']: p['role'] for p in ok(call(shop, 'owner', 'GET', f"/api/printers?branch_id={shop['branch']}"))['printers']}
    assert roles == {a: 'receipt', b: 'kitchen'}
    # Receipts back to the browser dialog.
    ok(call(shop, 'owner', 'PUT', '/api/printers/assign', {'branch_id': shop['branch'], 'job': 'receipt', 'printer_id': None}))
    oid = order(shop)
    assert ok(call(shop, 'staff', 'POST', f'/api/orders/{oid}/print-receipt'))['queued'] is False
    assert ok(call(shop, 'staff', 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': [r['id'] for r in _items(oid)]}))['printed_by_server'] is True
    printing.process_once(core)
    assert _wait(lambda: len(local_print.received) == 1)


def test_cannot_add_this_computer_as_a_printer(shop, local_print, monkeypatch):
    monkeypatch.setenv('ZAABOS_PUBLIC_URL', 'http://192.168.1.21:8080')
    code, body = call(shop, 'owner', 'POST', '/api/printers', {'branch_id': shop['branch'], 'name': 'x', 'host': '192.168.1.21', 'port': 9100})
    assert code == 400 and 'IP ของเครื่องคอมพิวเตอร์นี้' in body['error']


def test_network_scan_finds_a_listening_printer(local_print, monkeypatch):
    """Scan the /24 of a fake 'own IP' where only one address answers on the printer port."""
    real = socket.create_connection
    def fake(addr, timeout=None):
        host, port = addr
        if host == '10.9.8.50':
            return real(('127.0.0.1', local_print.port), timeout=timeout)
        raise OSError('closed')
    monkeypatch.setattr(printing.socket, 'create_connection', fake)
    assert printing.scan_network('10.9.8.7', port=9100) == ['10.9.8.50']
    assert printing.scan_network('127.0.0.1') == []
