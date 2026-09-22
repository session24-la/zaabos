from flask import Flask, render_template, request, jsonify, g, session, send_from_directory, send_file
import sqlite3, os, functools, secrets, shutil, random, string, json, hashlib, subprocess, io
from datetime import datetime, date, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from werkzeug.security import generate_password_hash, check_password_hash

# ---------- dual SQLite/Postgres support (same pattern as CASHFLOW 24) ----------
IS_POSTGRES = bool(os.getenv('DATABASE_URL'))
try:
    import psycopg2, psycopg2.extras
except ImportError:
    psycopg2 = None

INTEGRITY_ERRORS = (sqlite3.IntegrityError,) + ((psycopg2.IntegrityError,) if psycopg2 else ())


MONEY_QUANT = Decimal('0.01')
def money_decimal(value=0):
    """Canonical application money arithmetic. DB compatibility remains REAL/DOUBLE for now."""
    try:
        d = Decimal(str(0 if value in (None, '') else value))
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError('จำนวนเงินไม่ถูกต้อง')
    if not d.is_finite(): raise ValueError('จำนวนเงินไม่ถูกต้อง')
    return d.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)

def money_float(value=0):
    return float(money_decimal(value))

def money_sum(values):
    return sum((money_decimal(v) for v in values), Decimal('0.00')).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)


class PGCursor:
    def __init__(self, cur, lastrowid=None):
        self._cur = cur
        self.lastrowid = lastrowid
    def fetchone(self): return self._cur.fetchone()
    def fetchall(self): return self._cur.fetchall()
    def __iter__(self): return iter(self._cur.fetchall())
    @property
    def rowcount(self): return self._cur.rowcount


class PGConn:
    """Adapter so ?-placeholder / lastrowid / dict-row sqlite3-style code runs
    unchanged on Postgres. Only this class + db()/init_db() know Postgres exists."""
    def __init__(self, dsn):
        self._conn = psycopg2.connect(dsn)

    def execute(self, sql, params=()):
        pg_sql = sql.replace('?', '%s')
        # Most application tables use an integer `id` and need SQLite-style
        # lastrowid emulation. Migration ledgers are keyed by `version`, not `id`,
        # so blindly appending RETURNING id makes PostgreSQL crash at startup.
        insert_head = pg_sql.lstrip().upper()
        no_id_return_tables = ('SCHEMA_MIGRATIONS',)
        add_returning = (
            insert_head.startswith('INSERT INTO')
            and 'RETURNING' not in pg_sql.upper()
            and not any(insert_head.startswith(f'INSERT INTO {table}') for table in no_id_return_tables)
        )
        if add_returning:
            pg_sql = pg_sql.rstrip().rstrip(';') + ' RETURNING id'
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        try:
            cur.execute(pg_sql, params)
        except Exception:
            self._conn.rollback()
            raise
        lastrowid = None
        if add_returning:
            row = cur.fetchone()
            lastrowid = row['id'] if row else None
        return PGCursor(cur, lastrowid)

    def executescript(self, sql):
        cur = self._conn.cursor()
        try:
            cur.execute(sql)
        except Exception:
            self._conn.rollback()
            raise
        cur.close()

    def commit(self): self._conn.commit()
    def rollback(self): self._conn.rollback()
    def close(self): self._conn.close()


def hash_password(p): return generate_password_hash(p, method='pbkdf2:sha256')

def verify_password(pw_hash, password):
    try:
        return check_password_hash(pw_hash, password)
    except Exception:
        return False

BASE = Path(__file__).resolve().parent
DB = BASE / 'zaabos.db'
SECRET_FILE = BASE / '.secret_key'
app = Flask(__name__)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
)

@app.after_request
def add_security_headers(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    response.headers.setdefault('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
    if request.is_secure:
        response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    return response

app.config['JSON_AS_ASCII'] = False
app.config['MAX_CONTENT_LENGTH'] = 8 * 1024 * 1024
MAX_IMAGE_DATA_URI_LEN = 3 * 1024 * 1024

def _valid_image_data_uri(s):
    if not s: return True
    if not isinstance(s, str) or not s.startswith('data:image/'): return False
    if len(s) > MAX_IMAGE_DATA_URI_LEN: return False
    return True

# Full application source restored from the uploaded verified file; QR route is injected below.
