"""A busy service on the shop PC, simulated: several staff tablets, QR phones, the kitchen screen
and the cashier all at once against the real ZaabOS Local server — with the server killed
(power cut / crash) in the middle and restarted, and the kitchen printer unplugged for a while.

    python tests/soak_shop_day.py --seconds 90          # manual run, prints a report
    pytest tests/soak_shop_day.py                         # short run (CI)

At the end the money must reconcile to the kip, every table has at most one open bill, no
request was applied twice, the database is intact and every kitchen ticket printed.
"""
import argparse
import json
import random
import sqlite3
import sys
import threading
import time
import uuid
from contextlib import closing
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from test_local_mode import Browser, free_port, login, start, stop  # noqa: E402

D = lambda v: round(float(v or 0), 2)


class FakePrinter:
    """Kitchen printer on the LAN. `online=False` = unplugged: connections are refused."""
    def __init__(self):
        import socket
        self.socket = socket
        self.port = free_port()
        self.online = True
        self.tickets = 0
        self._srv = None
        self._lock = threading.Lock()
        self.plug_in()

    def plug_in(self):
        s = self.socket.socket()
        s.setsockopt(self.socket.SOL_SOCKET, self.socket.SO_REUSEADDR, 1)
        s.bind(('127.0.0.1', self.port))
        s.listen(16)
        self._srv, self.online = s, True
        threading.Thread(target=self._serve, args=(s,), daemon=True).start()

    def unplug(self):
        self.online = False
        self._srv.close()

    def _serve(self, s):
        while True:
            try:
                c, _ = s.accept()
            except OSError:
                return
            with c:
                data = b''
                while True:
                    chunk = c.recv(65536)
                    if not chunk:
                        break
                    data += chunk
            if data.startswith(b'\x1b@'):
                with self._lock:
                    self.tickets += 1


class Shop:
    def __init__(self, data_dir, port):
        self.data, self.port = Path(data_dir), port
        self.proc = start(self.data, port)
        self.admin_pw = (self.data / 'first-login.txt').read_text(encoding='utf-8').split('password: ', 1)[1].split()[0]
        self.errors_500 = 0
        self.lock = threading.Lock()

    def restart(self, hard=True):
        if hard:
            self.proc.kill()           # like pulling the plug: no clean shutdown
            self.proc.wait()
        else:
            stop(self.proc)
        self.proc = start(self.data, self.port)

    def session(self, user='admin', pw=None):
        b = Browser(f'http://127.0.0.1:{self.port}')
        b.csrf = b.ok('POST', '/api/login', {'username': user, 'password': pw or self.admin_pw})['csrf_token']
        return b


def retrying(shop, b, method, path, data=None, relogin=None, tries=40):
    """What a tablet does on a flaky connection: retry the SAME request (same client_request_id)."""
    for _ in range(tries):
        try:
            code, body = b.call(method, path, data)
        except Exception:
            time.sleep(0.25)
            continue
        if code >= 500:
            with shop.lock:
                shop.errors_500 += 1
            time.sleep(0.2)
            continue
        if code == 401 and relogin:
            relogin()
            continue
        return code, body
    return None, {}


def run(seconds=30, crash=True, unplug=True, seed=7, verbose=True):
    random.seed(seed)
    import tempfile
    work = Path(tempfile.mkdtemp(prefix='zaabos-soak-'))
    printer = FakePrinter()
    shop = Shop(work / 'data', free_port())
    admin = shop.session()
    boot = admin.ok('GET', '/api/bootstrap')
    branch = boot['branches'][0]['id']
    tables = boot['tables']
    items = boot['items']
    admin.ok('POST', '/api/printers', {'branch_id': branch, 'name': 'Kitchen', 'role': 'kitchen', 'host': '127.0.0.1', 'port': printer.port})
    staff_pw = 'staff-pass-' + uuid.uuid4().hex[:6]
    for i in range(3):
        admin.ok('POST', '/api/users', {'username': f'tab{i}', 'display_name': f'Tablet {i}', 'password': staff_pw, 'role': 'staff'})
    admin.ok('POST', '/api/operations/shift/open', {'branch_id': branch, 'opening_cash': 100000})

    stop_at = time.time() + seconds
    sent_order_keys, stats = [], {'staff_orders': 0, 'qr_orders': 0, 'paid': 0, 'kitchen_moves': 0}
    slock = threading.Lock()

    def staff(i):
        sess = {'b': shop.session(f'tab{i}', staff_pw)}
        relog = lambda: sess.__setitem__('b', shop.session(f'tab{i}', staff_pw))
        my_tables = [tables[i], tables[3]]       # own table + one table all tablets share
        while time.time() < stop_at:
            t = random.choice(my_tables)
            cart = [{'menu_item_id': random.choice(items)['id'], 'quantity': random.randint(1, 3)}]
            code, orders = retrying(shop, sess['b'], 'GET', f'/api/orders?branch_id={branch}', relogin=relog)
            open_bill = next((o for o in (orders or {}).get('orders', []) if o['table_id'] == t['id'] and o['status'] not in ('completed', 'cancelled')), None)
            if open_bill:
                code, body = retrying(shop, sess['b'], 'POST', f"/api/orders/{open_bill['id']}/items", {'items': cart}, relog)
                oid, new_ids = open_bill['id'], (body or {}).get('item_ids') or []
            else:
                key = uuid.uuid4().hex
                code, body = retrying(shop, sess['b'], 'POST', '/api/orders', {'branch_id': branch, 'order_type': 'dine_in', 'table_id': t['id'],
                                                                             'cart': cart, 'client_request_id': key, 'client_device_id': f'tab{i}'}, relog)
                oid = (body or {}).get('order_id')
                with slock:
                    sent_order_keys.append(key)
                new_ids = None
            if oid and code == 200:
                with slock:
                    stats['staff_orders'] += 1
                if new_ids is None:
                    o = next((x for x in retrying(shop, sess['b'], 'GET', f'/api/orders?branch_id={branch}', relogin=relog)[1].get('orders', []) if x['id'] == oid), None)
                    new_ids = [it['id'] for it in (o or {}).get('items', []) if not it.get('kitchen_sent_at')]
                if new_ids:
                    retrying(shop, sess['b'], 'PUT', f'/api/orders/{oid}/send-to-kitchen', {'item_ids': new_ids}, relog)
            time.sleep(random.uniform(0.2, 0.6))

    def qr_phone(i):
        b = Browser(f'http://127.0.0.1:{shop.port}')
        t = tables[4 + (i % 2)]     # two phones share each of tables 5 and 6
        while time.time() < stop_at:
            code, body = retrying(shop, b, 'POST', '/api/public/orders', {'branch_id': branch, 'order_type': 'dine_in', 'table_token': t['qr_token'],
                                                                         'cart': [{'menu_item_id': random.choice(items)['id'], 'quantity': 1}]})
            if code == 200:
                with slock:
                    stats['qr_orders'] += 1
            time.sleep(random.uniform(0.8, 1.5))

    def kitchen():
        sess = {'b': shop.session()}
        relog = lambda: sess.__setitem__('b', shop.session())
        nxt = {'received': 'preparing', 'preparing': 'ready'}
        while time.time() < stop_at:
            code, body = retrying(shop, sess['b'], 'GET', f'/api/kitchen/orders?branch_id={branch}', relogin=relog)
            for o in (body or {}).get('orders', [])[:3]:
                if o['status'] in nxt:
                    c, _ = retrying(shop, sess['b'], 'PUT', f"/api/orders/{o['id']}/status", {'status': nxt[o['status']]}, relog)
                    if c == 200:
                        with slock:
                            stats['kitchen_moves'] += 1
            time.sleep(0.7)

    def cashier():
        sess = {'b': shop.session()}
        relog = lambda: sess.__setitem__('b', shop.session())
        while time.time() < stop_at:
            code, body = retrying(shop, sess['b'], 'GET', f'/api/orders?branch_id={branch}', relogin=relog)
            ready = [o for o in (body or {}).get('orders', []) if o['payment_status'] == 'unpaid' and o['status'] == 'ready']
            for o in ready[:2]:
                key = uuid.uuid4().hex
                method = random.choice(['cash', 'qr', 'bank_transfer'])
                c, r = retrying(shop, sess['b'], 'PUT', f"/api/orders/{o['id']}/payment", {'payment_status': 'paid', 'payment_method': method,
                                                                                             'client_request_id': key}, relog)
                if c == 200:
                    with slock:
                        stats['paid'] += 1
            time.sleep(1.2)

    threads = [threading.Thread(target=staff, args=(i,)) for i in range(3)] + \
              [threading.Thread(target=qr_phone, args=(i,)) for i in range(4)] + \
              [threading.Thread(target=kitchen), threading.Thread(target=cashier)]
    for t in threads:
        t.start()
    events = []
    if unplug:
        time.sleep(seconds * 0.25); printer.unplug(); events.append('printer unplugged')
    if crash:
        time.sleep(seconds * 0.2); shop.restart(hard=True); events.append('server killed + restarted')
    if unplug:
        time.sleep(seconds * 0.1); printer.plug_in(); events.append('printer back')
    for t in threads:
        t.join()

    # reprint what failed while unplugged (the red banner in the UI), then let the queue drain
    for j in admin_session(shop).ok('GET', f'/api/print/jobs?branch_id={branch}&status=failed'):
        admin_session(shop).ok('POST', f"/api/print/jobs/{j['id']}/retry")
    time.sleep(4)
    report = check(shop, branch, sent_order_keys, printer)
    report.update(stats=stats, events=events, errors_500=shop.errors_500, printer_tickets=printer.tickets)
    stop(shop.proc)
    printer.unplug()
    if verbose:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


_admin_cache = {}


def admin_session(shop):
    if shop.port not in _admin_cache:
        _admin_cache[shop.port] = shop.session()
    return _admin_cache[shop.port]


def check(shop, branch, sent_keys, printer):
    db = shop.data / 'zaabos.db'
    problems = []
    with closing(sqlite3.connect(db)) as c:
        c.row_factory = sqlite3.Row
        if c.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            problems.append('database integrity check failed')
        for o in c.execute("SELECT * FROM orders WHERE payment_status='paid'"):
            items = D(c.execute('SELECT COALESCE(SUM((quantity-COALESCE(cancelled_quantity,0))*unit_price),0) FROM order_items WHERE order_id=?', (o['id'],)).fetchone()[0])
            due = D(D(o['total_amount']) - D(o['discount_amount']) + D(o['service_charge_amount']) + D(o['tax_amount']) + D(o['delivery_fee']))
            paid = D(c.execute('SELECT COALESCE(SUM(amount),0) FROM payments WHERE order_id=? AND reversed_at IS NULL', (o['id'],)).fetchone()[0])
            if items != D(o['total_amount']) or paid != due:
                problems.append(f"order {o['order_no']}: items {items} / total {o['total_amount']} / due {due} / paid {paid}")
        dup_pay = c.execute('SELECT order_id, COUNT(*) n FROM payments WHERE reversed_at IS NULL AND client_request_id IS NOT NULL GROUP BY order_id, client_request_id HAVING n>1 AND COUNT(DISTINCT payment_method)=1').fetchall()
        if dup_pay:
            problems.append(f'payment applied twice: {[r[0] for r in dup_pay]}')
        per_table = c.execute("""SELECT table_id, COUNT(*) n FROM orders WHERE order_type='dine_in' AND payment_status='unpaid'
                                 AND status NOT IN ('completed','cancelled') AND COALESCE(notes,'') NOT LIKE 'แยกจากบิล%' GROUP BY table_id HAVING n>1""").fetchall()
        # Staff tablets can open a second bill on a table (same as the web today); QR tables must never.
        for r in per_table:
            problems.append(f'table {r[0]} has {r[1]} open bills')
        for k in sent_keys:
            n = c.execute('SELECT COUNT(*) FROM orders WHERE client_request_id=?', (k,)).fetchone()[0]
            if n > 1:
                problems.append(f'order request {k[:8]} created {n} bills')
        jobs = {r['status']: r['n'] for r in c.execute("SELECT status, COUNT(*) n FROM kitchen_print_jobs GROUP BY status")}
        pay_total = D(c.execute('SELECT COALESCE(SUM(amount),0) FROM payments WHERE reversed_at IS NULL').fetchone()[0])
    if jobs.get('pending') or jobs.get('failed'):
        problems.append(f'print jobs not printed: {jobs}')
    r = admin_session(shop).ok('GET', f'/api/reports/summary?branch_id={branch}')
    if D(r['total_sales']) != pay_total:
        problems.append(f"report {r['total_sales']} != payments {pay_total}")
    shift = admin_session(shop).ok('GET', f'/api/operations/shift?branch_id={branch}')['summary']
    if D(shift['gross_received']) != pay_total:
        problems.append(f"shift {shift['gross_received']} != payments {pay_total}")
    return {'ok': not problems, 'problems': problems, 'sales': pay_total, 'print_jobs': jobs}


def test_busy_service_with_crash_and_unplugged_printer():
    rep = run(seconds=20, verbose=False)
    assert rep['ok'], rep
    assert rep['stats']['paid'] > 3 and rep['stats']['qr_orders'] > 5 and rep['stats']['staff_orders'] > 10, rep
    assert rep['errors_500'] == 0, rep


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=int, default=60)
    ap.add_argument('--no-crash', action='store_true')
    ap.add_argument('--no-unplug', action='store_true')
    a = ap.parse_args()
    rep = run(a.seconds, crash=not a.no_crash, unplug=not a.no_unplug)
    sys.exit(0 if rep['ok'] else 1)
