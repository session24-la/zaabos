"""ZaabOS restore drill.

Restores a pg_dump artifact into RESTORE_TEST_DATABASE_URL — never into
DATABASE_URL — and then verifies that the restored database is actually usable.

Safety design
-------------
The old version compared the two connection strings as text. That is not enough:
the same PostgreSQL database can be reached through two different URLs (internal
vs public hostname, different user, trailing slash), and a text comparison would
happily let you wipe production. This version connects to both and compares a
server fingerprint — database name, server address/port and postmaster start
time — so two different spellings of the same database are still recognised as
the same database and the drill aborts.

Nothing sensitive (password, full connection URL) is ever printed.
Exit code 0 = PASS, 1 = FAIL.
"""
import os
import re
import sys
import json
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

import psycopg2

CORE_TABLES = ('tenants', 'users', 'branches', 'menu_items', 'orders',
               'order_items', 'payments', 'schema_migrations')
# Tables a real production database must not be empty in.
MUST_HAVE_ROWS = ('tenants', 'users', 'schema_migrations')


def safe_target(dsn):
    try:
        u = urlsplit(dsn)
        return f'{u.hostname}:{u.port or 5432}/{(u.path or "/").lstrip("/")}'
    except Exception:
        return '(unparseable dsn)'


def scrub(text, *secrets):
    out = text or ''
    for s in secrets:
        if s:
            out = out.replace(s, '***REDACTED***')
            try:
                pw = urlsplit(s).password
                if pw:
                    out = out.replace(pw, '***REDACTED***')
            except Exception:
                pass
    out = re.sub(r'postgres(?:ql)?://[^\s\'"]+', 'postgresql://***REDACTED***', out)
    return out


def fail(msg):
    print('FAIL: ' + msg)
    sys.exit(1)


def fingerprint(dsn, label):
    """Identify the physical database behind a DSN, independent of how it is spelled."""
    try:
        conn = psycopg2.connect(dsn, connect_timeout=15)
    except Exception as e:
        fail(f'cannot connect to {label} ({safe_target(dsn)}): {scrub(str(e), dsn)}')
    try:
        cur = conn.cursor()
        cur.execute('SELECT current_database(), '
                    'COALESCE(host(inet_server_addr()), %s), '
                    'COALESCE(inet_server_port(), 0), '
                    'pg_postmaster_start_time()', ('local',))
        dbname, addr, port, started = cur.fetchone()
        ident = None
        try:  # superuser-only; a bonus when available, never required
            cur.execute('SELECT system_identifier FROM pg_control_system()')
            ident = cur.fetchone()[0]
        except Exception:
            conn.rollback()
        return {'database': dbname, 'address': addr, 'port': port,
                'started': str(started), 'system_identifier': ident}
    finally:
        conn.close()


def same_database(a, b):
    if a.get('system_identifier') and b.get('system_identifier'):
        if a['system_identifier'] != b['system_identifier']:
            return False  # provably different clusters
    return (a['database'] == b['database']
            and a['address'] == b['address']
            and a['port'] == b['port']
            and a['started'] == b['started'])


def main():
    if len(sys.argv) != 2:
        fail('usage: python restore_test_postgres.py backups/<file>.dump')

    dump = Path(sys.argv[1])
    if not dump.is_file():
        fail(f'backup file not found: {dump}')

    prod = (os.getenv('DATABASE_URL') or '').strip()
    test = (os.getenv('RESTORE_TEST_DATABASE_URL') or '').strip()
    if not test:
        fail('RESTORE_TEST_DATABASE_URL is required. '
             'It must point at a DISPOSABLE database — its contents are destroyed.')

    pg_restore = shutil.which('pg_restore')
    if not pg_restore:
        fail('pg_restore not found. Install the PostgreSQL client '
             '(on Railway set RAILPACK_DEPLOY_APT_PACKAGES=postgresql-client).')

    print(f'artifact : {dump.name}')
    print(f'target   : {safe_target(test)}   (this database will be ERASED)')

    # ---------- guard 1: plain text equality ----------
    if prod and test == prod:
        fail('restore target equals DATABASE_URL — refusing to touch production')

    # ---------- guard 2: same physical database behind different URLs ----------
    target_fp = fingerprint(test, 'restore target')
    if prod:
        prod_fp = fingerprint(prod, 'production (read-only identity check)')
        if same_database(prod_fp, target_fp):
            fail('restore target and DATABASE_URL resolve to the SAME database '
                 f'({target_fp["database"]}) — refusing to touch production')
        print(f'guard    : target ({target_fp["database"]}) is a different database '
              f'from production ({prod_fp["database"]}) — OK')
    else:
        print('guard    : DATABASE_URL not set in this environment; '
              'only the explicit target will be written')

    # ---------- wipe the disposable target, then restore ----------
    # Dropping and recreating the schema gives a deterministic restore and a
    # meaningful exit code. `pg_restore --clean` against a fresh empty database
    # reports errors for every object it cannot drop, which made the very first
    # drill look like a failure.
    conn = psycopg2.connect(test, connect_timeout=15)
    conn.autocommit = True
    try:
        cur = conn.cursor()
        cur.execute('DROP SCHEMA IF EXISTS public CASCADE')
        cur.execute('CREATE SCHEMA public')
    finally:
        conn.close()

    r = subprocess.run(
        [pg_restore, '--no-owner', '--no-acl', '--exit-on-error',
         '--dbname', test, str(dump)],
        capture_output=True, text=True)
    if r.returncode:
        fail('pg_restore failed: ' + scrub(r.stderr, test, prod)[-1500:])

    # ---------- verification ----------
    expected = {}
    manifest = dump.with_suffix('.dump.json')
    if manifest.is_file():
        try:
            expected = (json.loads(manifest.read_text(encoding='utf-8'))
                        .get('core_row_counts') or {})
        except Exception:
            expected = {}

    conn = psycopg2.connect(test, connect_timeout=15)
    problems, report = [], {}
    try:
        cur = conn.cursor()
        for t in CORE_TABLES:
            cur.execute('SELECT to_regclass(%s)', (t,))
            if cur.fetchone()[0] is None:
                problems.append(f'missing table after restore: {t}')
                report[t] = 'MISSING'
                continue
            cur.execute(f'SELECT COUNT(*) FROM "{t}"')
            n = cur.fetchone()[0]
            report[t] = n
            if t in MUST_HAVE_ROWS and n == 0:
                problems.append(f'core table restored empty: {t}')
            if t in expected and expected[t] != n:
                problems.append(
                    f'row count mismatch in {t}: backup recorded {expected[t]}, restored {n}')
        # the restored database must actually be queryable, not just present
        cur.execute('SELECT COUNT(*) FROM users u JOIN tenants t ON t.id = u.tenant_id')
        report['users_joined_to_tenants'] = cur.fetchone()[0]
        cur.execute('SELECT COALESCE(MAX(version), 0) FROM schema_migrations')
        report['latest_migration'] = cur.fetchone()[0]
    except Exception as e:
        problems.append('verification query failed: ' + scrub(str(e), test, prod))
    finally:
        conn.close()

    print('\nrestored database:')
    print(json.dumps(report, indent=2, default=str))
    if expected:
        print('backup manifest recorded:')
        print(json.dumps(expected, indent=2))
    else:
        print('note: no manifest row counts found next to the dump — '
              'row-count comparison was skipped')

    if problems:
        print()
        for p in problems:
            print(' - ' + p)
        fail('restore drill did NOT pass')

    print(f'\nPASS: restore drill completed on {safe_target(test)}, '
          'separate from production')


if __name__ == '__main__':
    main()
