"""Step 2 — ZaabOS Local: the POS running on the shop's own PC (SQLite, no internet needed).

Starts the real launcher (waitress) in a subprocess against a temporary data folder, sells
through HTTP like a browser would, restarts it, and checks the sale and a backup survived.
"""
import http.cookiejar
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
pytest.importorskip('waitress')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Browser:
    def __init__(self, base):
        self.base, self.csrf = base, ''
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, data=None):
        req = urllib.request.Request(self.base + path, method=method, data=None if data is None else json.dumps(data).encode(),
                                     headers={'Content-Type': 'application/json', 'X-CSRF-Token': self.csrf})
        try:
            with self.opener.open(req, timeout=15) as r:
                return r.status, json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')

    def ok(self, method, path, data=None):
        code, body = self.call(method, path, data)
        assert code == 200, (path, code, body)
        return body


def start(data_dir, port):
    env = dict(os.environ)
    for k in ('DATABASE_URL', 'ZAABOS_DATA_DIR', 'ZAABOS_ADMIN_PASSWORD', 'ZAABOS_PUBLIC_URL', 'ZAABOS_BACKUP_DIR'):
        env.pop(k, None)
    proc = subprocess.Popen([sys.executable, 'zaabos_local.py', '--no-browser', '--port', str(port), '--data-dir', str(data_dir)],
                            cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=1)
            return proc
        except Exception:
            if proc.poll() is not None:
                raise AssertionError(proc.stdout.read())
            time.sleep(0.2)
    proc.kill()
    raise AssertionError('launcher did not start: ' + proc.stdout.read())


def stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def login(port, password):
    b = Browser(f'http://127.0.0.1:{port}')
    b.csrf = b.ok('POST', '/api/login', {'username': 'admin', 'password': password})['csrf_token']
    return b


def test_local_shop_pc_sells_restarts_and_keeps_data(tmp_path):
    data, port = tmp_path / 'ZaabOS', free_port()
    proc = start(data, port)
    try:
        note = (data / 'first-login.txt').read_text(encoding='utf-8')
        password = note.split('password: ', 1)[1].split()[0]
        b = login(port, password)
        boot = b.ok('GET', '/api/bootstrap')
        assert boot['public_url'].endswith(f':{port}') and 'localhost' not in boot['public_url']
        branch, table = boot['branches'][0]['id'], boot['tables'][0]['id']
        item = boot['items'][0]
        oid = b.ok('POST', '/api/orders', {'branch_id': branch, 'order_type': 'dine_in', 'table_id': table,
                                           'cart': [{'menu_item_id': item['id'], 'quantity': 2}]})['order_id']
        b.ok('POST', '/api/operations/shift/open', {'branch_id': branch, 'opening_cash': 0})
        paid = b.ok('PUT', f'/api/orders/{oid}/payment', {'payment_status': 'paid', 'payment_method': 'cash'})['amount']
        assert paid == item['base_price'] * 2
    finally:
        stop(proc)

    assert (data / 'zaabos.db').exists() and not (ROOT / 'backups' / 'zaabos_local').exists()
    backups = list((data / 'backups').glob('zaabos_local_*.db'))
    assert backups, 'launcher must back up the database on start'
    with sqlite3.connect(backups[0]) as c:
        assert c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'

    proc = start(data, port)            # next morning: same PC, same data
    try:
        b = login(port, password)
        report = b.ok('GET', f'/api/reports/summary?branch_id={branch}')
        assert report['total_sales'] == paid
        assert b.ok('GET', f'/api/operations/shift?branch_id={branch}')['shift'] is not None, 'open shift survives restart'
    finally:
        stop(proc)


def test_second_launch_does_not_start_a_second_server(tmp_path):
    data, port = tmp_path / 'ZaabOS', free_port()
    proc = start(data, port)
    try:
        again = subprocess.run([sys.executable, 'zaabos_local.py', '--no-browser', '--port', str(port), '--data-dir', str(data)],
                               cwd=ROOT, capture_output=True, text=True, timeout=30)
        assert again.returncode == 0 and 'already running' in again.stdout
    finally:
        stop(proc)


def test_shop_pc_imports_menu_from_cloud_and_reports_status(tmp_path):
    """Two real servers: A plays zaabos.com (fresh install: 10 dishes, 6 tables), B is the shop PC."""
    cloud_dir, shop_dir = tmp_path / 'cloud', tmp_path / 'shop'
    cp, sp = free_port(), free_port()
    cloud, shop_proc = start(cloud_dir, cp), start(shop_dir, sp)
    try:
        cloud_pw = (cloud_dir / 'first-login.txt').read_text(encoding='utf-8').split('password: ', 1)[1].split()[0]
        shop_pw = (shop_dir / 'first-login.txt').read_text(encoding='utf-8').split('password: ', 1)[1].split()[0]
        b = login(sp, shop_pw)
        st = b.ok('GET', '/api/local/status')
        assert st['version'] and st['public_url'].endswith(f':{sp}') and st['autostart'] in (True, False)
        branch = b.ok('GET', '/api/bootstrap')['branches'][0]['id']
        # a dish from the cloud must arrive on the shop PC
        cb = login(cp, cloud_pw)
        dish = cb.ok('GET', '/api/bootstrap')['items'][0]
        code, _ = b.call('POST', '/api/local/import-cloud', {'branch_id': branch, 'url': f'http://127.0.0.1:{cp}', 'username': 'admin', 'password': 'wrong'})
        assert code == 502
        r = b.ok('POST', '/api/local/import-cloud', {'branch_id': branch, 'url': f'http://127.0.0.1:{cp}', 'username': 'admin', 'password': cloud_pw})
        assert r['items'] == 10 and r['tables'] == 6
        boot = b.ok('GET', '/api/bootstrap')
        assert len(boot['items']) == 10 and dish['name'] in [i['name'] for i in boot['items']]
        assert len(boot['tables']) == 6
        # still sells after import
        oid = b.ok('POST', '/api/orders', {'branch_id': branch, 'order_type': 'dine_in', 'table_id': boot['tables'][0]['id'],
                                           'cart': [{'menu_item_id': boot['items'][0]['id'], 'quantity': 1}]})['order_id']
        assert oid
        backup = b.ok('POST', '/api/local/backup')
        assert backup['file'].startswith('zaabos_local_')
    finally:
        stop(cloud); stop(shop_proc)


def test_daily_health_check_reports_green_on_a_clean_day(tmp_path):
    data, port = tmp_path / 'ZaabOS', free_port()
    proc = start(data, port)
    try:
        pw = (data / 'first-login.txt').read_text(encoding='utf-8').split('password: ', 1)[1].split()[0]
        b = login(port, pw)
        boot = b.ok('GET', '/api/bootstrap')
        branch = boot['branches'][0]['id']
        b.ok('POST', '/api/operations/shift/open', {'branch_id': branch, 'opening_cash': 0})
        oid = b.ok('POST', '/api/orders', {'branch_id': branch, 'order_type': 'dine_in', 'table_id': boot['tables'][0]['id'],
                                           'cart': [{'menu_item_id': boot['items'][0]['id'], 'quantity': 1}]})['order_id']
        b.ok('PUT', f'/api/orders/{oid}/payment', {'payment_status': 'paid', 'payment_method': 'cash'})
        checks = {c['key']: c for c in b.ok('GET', '/api/local/health')['checks']}
        for key in ('money', 'drawer', 'open_bills', 'shifts', 'printing', 'database', 'backup'):
            assert checks[key]['level'] == 'ok', checks[key]
        # break the money on purpose: the check must turn red
        from contextlib import closing
        with closing(sqlite3.connect(data / 'zaabos.db', timeout=15)) as c:
            c.execute('UPDATE payments SET amount=amount-1 WHERE order_id=?', (oid,))
            c.commit()
        checks = {c['key']: c for c in b.ok('GET', '/api/local/health')['checks']}
        assert checks['money']['level'] == 'bad'
    finally:
        stop(proc)
