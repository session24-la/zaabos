"""ZaabOS operator backup.

Creates a PostgreSQL custom-format dump plus a SHA-256 manifest that also records
the row counts of the core tables, so a later restore drill can verify that the
restored database really contains the data that was backed up.

Reads only. Never writes to the source database.
Secrets (passwords, full connection URLs) are never printed.
"""
import os
import re
import sys
import json
import shutil
import hashlib
import subprocess
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit

CORE_TABLES = ('tenants', 'users', 'branches', 'menu_items', 'orders',
               'order_items', 'payments', 'schema_migrations')


def safe_target(dsn):
    """host/port/dbname only — never the user or password."""
    try:
        u = urlsplit(dsn)
        return f'{u.hostname}:{u.port or 5432}/{(u.path or "/").lstrip("/")}'
    except Exception:
        return '(unparseable dsn)'


def scrub(text, *secrets):
    """Remove connection URLs and passwords from anything we print."""
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
    # belt and braces: any postgres URL that slipped through
    out = re.sub(r'postgres(?:ql)?://[^\s\'"]+', 'postgresql://***REDACTED***', out)
    return out


def fail(msg):
    print('FAIL: ' + msg)
    sys.exit(1)


def row_counts(dsn):
    """Best-effort row counts of the core tables, for restore verification."""
    try:
        import psycopg2
    except ImportError:
        return {}
    counts = {}
    conn = None
    try:
        conn = psycopg2.connect(dsn)
        conn.set_session(readonly=True)
        cur = conn.cursor()
        for t in CORE_TABLES:
            cur.execute('SELECT to_regclass(%s)', (t,))
            if cur.fetchone()[0] is None:
                continue
            cur.execute(f'SELECT COUNT(*) FROM "{t}"')
            counts[t] = cur.fetchone()[0]
    except Exception:
        return counts
    finally:
        if conn:
            conn.close()
    return counts


def main():
    dsn = (os.getenv('DATABASE_URL') or '').strip()
    if not dsn:
        fail('DATABASE_URL is required')

    pg_dump = shutil.which('pg_dump')
    if not pg_dump:
        fail('pg_dump not found. Install the PostgreSQL client '
             '(on Railway set RAILPACK_DEPLOY_APT_PACKAGES=postgresql-client).')

    out_dir = Path(os.getenv('ZAABOS_BACKUP_DIR') or 'backups').expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    dump_path = out_dir / f'zaabos_operator_{ts}.dump'

    print(f'source   : {safe_target(dsn)}')
    print(f'artifact : {dump_path}')

    # The DSN goes through the environment, not argv, so it never shows up in a
    # process listing on a shared host.
    u = urlsplit(dsn)
    env = dict(os.environ)
    env.update({
        'PGHOST': u.hostname or '',
        'PGPORT': str(u.port or 5432),
        'PGUSER': u.username or '',
        'PGPASSWORD': u.password or '',
        'PGDATABASE': (u.path or '/').lstrip('/'),
    })
    r = subprocess.run(
        [pg_dump, '--format=custom', '--no-owner', '--no-acl',
         '--file', str(dump_path)],
        capture_output=True, text=True, env=env)
    def discard_partial():
        # Never leave a half-written or empty .dump lying around: a later drill
        # could pick it up and fail for the wrong reason.
        try:
            if dump_path.exists():
                dump_path.unlink()
        except OSError:
            pass

    if r.returncode:
        discard_partial()
        fail('pg_dump failed: ' + scrub(r.stderr, dsn)[-1200:])
    if not dump_path.is_file() or dump_path.stat().st_size < 1024:
        discard_partial()
        fail('dump is missing or suspiciously small')

    try:
        os.chmod(dump_path, 0o600)
    except OSError:
        pass

    digest = hashlib.sha256(dump_path.read_bytes()).hexdigest()
    meta = {
        'file': dump_path.name,
        'bytes': dump_path.stat().st_size,
        'sha256': digest,
        'created_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source': safe_target(dsn),
        'format': 'custom (pg_dump -Fc)',
        'core_row_counts': row_counts(dsn),
    }
    manifest = dump_path.with_suffix('.dump.json')
    manifest.write_text(json.dumps(meta, indent=2), encoding='utf-8')
    try:
        os.chmod(manifest, 0o600)
    except OSError:
        pass

    print('PASS: backup created')
    print(json.dumps(meta, indent=2))


if __name__ == '__main__':
    main()
