"""Regression tests on disposable local SQLite or the dedicated CI PostgreSQL.

Run: python -m pytest tests/test_runtime_regressions.py -q
Never point DATABASE_URL at a deployed database.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DSN = os.getenv('DATABASE_URL', '')
if DSN:
    target = urlsplit(DSN)
    if target.hostname not in ('localhost', '127.0.0.1') or target.path != '/zaabos_ci':
        raise RuntimeError('REFUSE: tests require the local disposable zaabos_ci database')

import app as core
import wsgi  # noqa: F401
import restore_test_postgres as restore
from pgcreds import pg_env


@pytest.fixture
def shop():
    stamp = uuid.uuid4().hex
    with core.app.app_context():
        conn = core.db()
        tenant = conn.execute("INSERT INTO tenants(name,active,subscription_status,created_at) VALUES(?,1,'active',?)",
                              ('Runtime test '+stamp, core.now())).lastrowid
        branch = conn.execute('INSERT INTO branches(tenant_id,name,active,created_at) VALUES(?,?,1,?)',
                              (tenant, 'Test branch', core.now())).lastrowid
        table = conn.execute('INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,active,created_at) VALUES(?,?,?,?,1,?)',
                             (tenant, branch, 'Test table', stamp, core.now())).lastrowid
        category = conn.execute('INSERT INTO menu_categories(tenant_id,branch_id,name,created_at) VALUES(?,?,?,?)',
                                (tenant, branch, 'Food', core.now())).lastrowid
        item = conn.execute('INSERT INTO menu_items(tenant_id,branch_id,category_id,name,base_price,created_at) VALUES(?,?,?,?,?,?)',
                            (tenant, branch, category, 'Noodles', 25000, core.now())).lastrowid
        owner = conn.execute('INSERT INTO users(tenant_id,username,password_hash,display_name,role,created_at) VALUES(?,?,?,?,?,?)',
                             (tenant, stamp, 'unused-session-fixture', 'Tester', 'owner', core.now())).lastrowid
        # Payments require an open shift (Step 1); give the fixture cashier one.
        conn.execute("INSERT INTO work_shifts(tenant_id,branch_id,opened_by_user_id,opened_at,opening_cash,status,notes) VALUES(?,?,?,?,0,'open','')",
                     (tenant, branch, owner, core.now()))
        conn.commit()
    return dict(tenant=tenant, branch=branch, table=table, token=stamp, item=item, owner=owner)


def customer_order(shop):
    with core.app.test_client() as client:
        return client.post('/api/public/orders', json={
            'branch_id': shop['branch'], 'order_type': 'dine_in', 'table_token': shop['token'],
            'cart': [{'menu_item_id': shop['item'], 'quantity': 1}],
        })


def staff_request(shop, method, path, data):
    with core.app.test_client() as client:
        with client.session_transaction() as session:
            session.update(user_id=shop['owner'], active_tenant_id=shop['tenant'], csrf_token='runtime-test')
        return client.open(path, method=method, json=data, headers={'X-CSRF-Token': 'runtime-test'})


def read_order(oid):
    with core.app.app_context():
        return dict(core.db().execute('SELECT * FROM orders WHERE id=?', (oid,)).fetchone())


def test_fresh_sqlite_starts_without_test_monkeypatch(tmp_path):
    dest = tmp_path/'app'
    shutil.copytree(ROOT, dest, ignore=shutil.ignore_patterns('.git', '*.db', '.secret_key', '__pycache__', '.pytest_cache', 'backups'))
    env = dict(os.environ, ZAABOS_ADMIN_PASSWORD='local-test-password-only')
    env.pop('DATABASE_URL', None)
    result = subprocess.run([sys.executable, '-c', 'import wsgi; print("STARTUP_OK")'],
                            cwd=dest, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert 'STARTUP_OK' in result.stdout


def test_staff_add_round_reactivates_kitchen(shop):
    response = customer_order(shop)
    assert response.status_code == 200
    oid = response.json['order_id']
    with core.app.app_context():
        core.db().execute("UPDATE orders SET status='served' WHERE id=?", (oid,))
        core.db().commit()
    response = staff_request(shop, 'POST', f'/api/orders/{oid}/items',
                             {'items': [{'menu_item_id': shop['item'], 'quantity': 1}]})
    assert response.status_code == 200, response.json
    assert read_order(oid)['status'] == 'received'
    assert read_order(oid)['total_amount'] == 50000


def test_unpaid_table_bill_stays_visible_after_twelve_hours(shop):
    oid = customer_order(shop).json['order_id']
    with core.app.app_context():
        core.db().execute('UPDATE orders SET created_at=? WHERE id=?', ('2020-01-01T00:00:00+00:00', oid))
        core.db().commit()
    with core.app.test_client() as client:
        response = client.post('/api/public/orders/history', json={'branch_id': shop['branch'], 'table_token': shop['token']})
    assert response.status_code == 200
    assert len(response.json['orders']) == 1


def test_paid_bill_rejects_staff_item_edits(shop):
    oid = customer_order(shop).json['order_id']
    paid = staff_request(shop, 'PUT', f'/api/orders/{oid}/payment', {'payment_status': 'paid', 'payment_method': 'qr'})
    assert paid.status_code == 200, paid.json
    response = staff_request(shop, 'POST', f'/api/orders/{oid}/items', {'items': [{'menu_item_id': shop['item'], 'quantity': 1}]})
    assert response.status_code == 409
    assert read_order(oid)['total_amount'] == 25000


@pytest.mark.parametrize('manifest', [None, 'not-json', '[]', '{}', '{"sha256":"bad","bytes":4}',
    json.dumps({'sha256': hashlib.sha256(b'dump').hexdigest(), 'bytes': 'invalid'}),
    json.dumps({'sha256': '0'*64, 'bytes': 4})])
def test_invalid_backup_rejected_before_database_access(tmp_path, monkeypatch, capsys, manifest):
    dump = tmp_path/'test.dump'
    dump.write_bytes(b'dump')
    if manifest is not None:
        dump.with_suffix('.dump.json').write_text(manifest)
    monkeypatch.setenv('RESTORE_TEST_DATABASE_URL', 'postgresql://localhost/unused')
    monkeypatch.setattr(sys, 'argv', ['restore_test_postgres.py', str(dump)])
    monkeypatch.setattr(restore.shutil, 'which', lambda _: '/unused/pg_restore')
    def no_connection(*args, **kwargs):
        pytest.fail('invalid backup reached database connection')
    monkeypatch.setattr(restore.psycopg2, 'connect', no_connection)
    with pytest.raises(SystemExit) as error:
        restore.main()
    assert error.value.code == 1
    assert 'FAIL:' in capsys.readouterr().out


def test_credentials_keep_connection_options_without_password_in_argv():
    from psycopg2.extensions import parse_dsn
    env = pg_env('postgresql://tester:local%40test@localhost:5432/db%20name?sslmode=require&connect_timeout=7')
    params = parse_dsn(env['PGDATABASE'])
    assert params['dbname'] == 'db name'
    assert params['sslmode'] == 'require'
    assert params['connect_timeout'] == '7'
    assert 'password' not in params
    assert env['PGPASSWORD'] == 'local@test'
    assert 'local@test' not in env['PGDATABASE']


def test_same_cluster_database_rejected_across_network_addresses():
    a = dict(database='db', address='10.0.0.1', port=5432, started='same', system_identifier=123)
    assert restore.same_database(a, dict(a, address='127.0.0.1'))
    assert not restore.same_database(a, dict(a, database='other'))


def wait_until_blocked_or_done(future):
    deadline = time.monotonic()+5
    while time.monotonic() < deadline:
        if future.done():
            return
        with core.app.app_context():
            row = core.db().execute("SELECT COUNT(*) c FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'").fetchone()
        if row['c']:
            return
        time.sleep(0.02)
    raise AssertionError('competing request neither completed nor waited for a database lock')


@pytest.mark.skipif(not DSN, reason='requires disposable local PostgreSQL')
@pytest.mark.parametrize('first', ['append', 'payment'])
def test_qr_append_and_checkout_are_atomic(shop, monkeypatch, first):
    from flask import request
    oid = customer_order(shop).json['order_id']
    entered, release = threading.Event(), threading.Event()
    name = '_validate_and_price_cart' if first == 'append' else '_pricing_settings'
    original = getattr(core, name)
    def paused(*args, **kwargs):
        if request.path == ('/api/public/orders' if first == 'append' else f'/api/orders/{oid}/payment'):
            entered.set()
            assert release.wait(10), 'timed out waiting for competing request'
        return original(*args, **kwargs)
    monkeypatch.setattr(core, name, paused)
    def append():
        return customer_order(shop)
    def pay():
        return staff_request(shop, 'PUT', f'/api/orders/{oid}/payment', {'payment_status': 'paid', 'payment_method': 'qr'})
    with ThreadPoolExecutor(max_workers=2) as pool:
        leading = pool.submit(append if first == 'append' else pay)
        assert entered.wait(5)
        trailing = pool.submit(pay if first == 'append' else append)
        try:
            wait_until_blocked_or_done(trailing)
        finally:
            release.set()
        lead, trail = leading.result(timeout=15), trailing.result(timeout=15)
    assert lead.status_code == trail.status_code == 200, (lead.json, trail.json)
    appended, paid = (lead, trail) if first == 'append' else (trail, lead)
    old = read_order(oid)
    assert old['status'] == 'completed' and old['payment_status'] == 'paid'
    assert paid.json['amount'] == old['total_amount']
    if first == 'append':
        assert appended.json['order_id'] == oid and old['total_amount'] == 50000
    else:
        assert appended.json['order_id'] != oid and old['total_amount'] == 25000
        assert read_order(appended.json['order_id'])['payment_status'] == 'unpaid'


@pytest.mark.skipif(not DSN, reason='requires disposable local PostgreSQL and client tools')
def test_real_postgres_backup_restore_and_tamper_guard(tmp_path):
    import psycopg2
    from psycopg2.extensions import make_dsn, parse_dsn
    params = parse_dsn(DSN)
    params['dbname'] = 'postgres'
    conn = psycopg2.connect(make_dsn(**params)); conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute('CREATE DATABASE zaabos_restore')
    conn.close()
    params['dbname'] = 'zaabos_restore'
    target = make_dsn(**params)
    env = dict(os.environ, ZAABOS_BACKUP_DIR=str(tmp_path), RESTORE_TEST_DATABASE_URL=target)
    def run(script, *args):
        return subprocess.run([sys.executable, str(ROOT/script), *args], env=env,
                              capture_output=True, text=True, timeout=90)
    backup = run('backup_postgres.py')
    assert backup.returncode == 0, backup.stdout+backup.stderr
    dump = next(tmp_path.glob('*.dump'))
    restored = run('restore_test_postgres.py', str(dump))
    assert restored.returncode == 0, restored.stdout+restored.stderr
    conn = psycopg2.connect(target); conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute('CREATE TABLE restore_sentinel(value INTEGER)')
        cur.execute('INSERT INTO restore_sentinel VALUES(731)')
        dump.write_bytes(dump.read_bytes()+b'tampered')
        rejected = run('restore_test_postgres.py', str(dump))
        assert rejected.returncode == 1 and 'FAIL:' in rejected.stdout
        cur.execute('SELECT value FROM restore_sentinel')
        assert cur.fetchone()[0] == 731
    conn.close()
