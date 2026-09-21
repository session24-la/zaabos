from flask import Flask, render_template, request, jsonify, g, session, send_from_directory
import sqlite3, os, functools, secrets, shutil, random, string
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
    if request.is_secure:
        response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    return response

app.config['JSON_AS_ASCII'] = False
app.config['MAX_CONTENT_LENGTH'] = 8 * 1024 * 1024  # 8MB — menu item photos are sent as data: URIs in the JSON body

MAX_IMAGE_DATA_URI_LEN = 3 * 1024 * 1024  # ~3MB of base64 text (client resizes images well below this)

def _valid_image_data_uri(s):
    """Menu item photos are uploaded as data:image/... URIs (resized/compressed
    client-side) so no file storage/volume is needed — same dual-DB row works
    for SQLite and Postgres. Reject anything that isn't a reasonably-sized
    image data URI to keep the database from bloating or storing garbage."""
    if not s: return True  # empty/None is fine — means "no image"
    if not isinstance(s, str) or not s.startswith('data:image/'): return False
    if len(s) > MAX_IMAGE_DATA_URI_LEN: return False
    return True


def get_secret_key():
    env_key = (os.getenv('ZAABOS_SECRET_KEY') or '').strip()
    if env_key: return env_key
    if IS_POSTGRES:
        raise RuntimeError('ZAABOS_SECRET_KEY is required when PostgreSQL/production mode is enabled')
    if SECRET_FILE.exists(): return SECRET_FILE.read_text().strip()
    key = secrets.token_hex(32)
    SECRET_FILE.write_text(key)
    return key

app.secret_key = get_secret_key()
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax', PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    SESSION_COOKIE_SECURE=IS_POSTGRES)

if IS_POSTGRES:
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

ROLES = ('super_admin', 'owner', 'manager', 'staff')
ORDER_STATUSES = ('received', 'preparing', 'ready', 'served', 'completed', 'cancelled')
PAYMENT_METHODS = ('cash', 'qr', 'card', 'bank_transfer', 'other')
STATUS_TRANSITIONS = {
    'received': {'preparing','ready','cancelled'},
    'preparing': {'ready','cancelled'},
    'ready': {'served','cancelled'},
    'served': {'completed','cancelled'},
    'completed': set(), 'cancelled': set(),
}
BACKUP_DIR = BASE / 'backups'


def backup_db(label='auto'):
    if IS_POSTGRES:
        try:
            import subprocess
            BACKUP_DIR.mkdir(exist_ok=True)
            ts = datetime.now().strftime('%Y%m%d_%H%M%S')
            dest = BACKUP_DIR / f'zaabos_{label}_{ts}.sql'
            with open(dest, 'w') as f:
                subprocess.run(['pg_dump', os.getenv('DATABASE_URL')], stdout=f, check=True, timeout=60)
            return dest.name
        except Exception:
            return None
    try:
        if not DB.exists(): return None
        BACKUP_DIR.mkdir(exist_ok=True)
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        dest = BACKUP_DIR / f'zaabos_{label}_{ts}.db'
        shutil.copy2(DB, dest)
        return dest.name
    except Exception:
        return None


def db():
    if 'db' not in g:
        if IS_POSTGRES:
            g.db = PGConn(os.getenv('DATABASE_URL'))
        else:
            g.db = sqlite3.connect(DB)
            g.db.row_factory = sqlite3.Row
            g.db.execute('PRAGMA foreign_keys=ON')
    return g.db

@app.teardown_appcontext
def close_db(exc=None):
    conn = g.pop('db', None)
    if conn: conn.close()

RESTAURANT_TIMEZONE = os.getenv('ZAABOS_TIMEZONE', 'Asia/Vientiane')
try:
    RESTAURANT_TZ = ZoneInfo(RESTAURANT_TIMEZONE)
except Exception:
    RESTAURANT_TIMEZONE = 'Asia/Vientiane'
    RESTAURANT_TZ = ZoneInfo(RESTAURANT_TIMEZONE)

def now():
    # Persist an explicit UTC offset so browsers and services never have to guess
    # which timezone a timestamp belongs to.
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def restaurant_now():
    return datetime.now(RESTAURANT_TZ)

def restaurant_today():
    return restaurant_now().date().isoformat()

def local_date_bounds_utc(day_text):
    """Return [start,end) UTC ISO timestamps for one restaurant-local date."""
    d = datetime.strptime(day_text[:10], '%Y-%m-%d').date()
    start_local = datetime.combine(d, datetime.min.time(), tzinfo=RESTAURANT_TZ)
    end_local = start_local + timedelta(days=1)
    return (
        start_local.astimezone(timezone.utc).isoformat(timespec='seconds'),
        end_local.astimezone(timezone.utc).isoformat(timespec='seconds'),
    )

def local_range_bounds_utc(frm, to):
    start, _ = local_date_bounds_utc(frm)
    _, end = local_date_bounds_utc(to)
    return start, end

def local_datetime_input_to_utc(value):
    """Convert HTML datetime-local / naive local input into explicit UTC ISO."""
    if not value:
        return None
    raw = str(value).strip()
    try:
        dt = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=RESTAURANT_TZ)
        return dt.astimezone(timezone.utc).isoformat(timespec='seconds')
    except Exception:
        return None

# ---------- schema bootstrap ----------

def ensure_default_tenant(conn):
    # Guarded with INTEGRITY_ERRORS, not just the pre-check above: with gunicorn
    # running multiple workers (no --preload) or during a rolling restart, two
    # processes can both pass the "not exists" check before either commits.
    # Without this, the loser crashes on a UNIQUE violation instead of just
    # finding the row already there on retry.
    if not conn.execute('SELECT id FROM tenants ORDER BY id LIMIT 1').fetchone():
        try:
            conn.execute('INSERT INTO tenants(name,icon,created_at) VALUES(?,?,?)', ('ร้านของฉัน', '🍽️', now()))
            conn.commit()
        except INTEGRITY_ERRORS:
            conn.rollback()
    else:
        conn.commit()

def ensure_super_admin(conn):
    """Bootstrap the first platform admin without a shared default password.

    Existing installations are left untouched. Fresh production installs must set
    ZAABOS_ADMIN_USERNAME and ZAABOS_ADMIN_PASSWORD. Local SQLite development gets
    a one-time random password printed to the terminal instead of a known secret.
    """
    if conn.execute("SELECT 1 FROM users WHERE role='super_admin'").fetchone():
        conn.commit(); return
    username = (os.getenv('ZAABOS_ADMIN_USERNAME') or 'admin').strip()
    password = os.getenv('ZAABOS_ADMIN_PASSWORD')
    if not password:
        if IS_POSTGRES:
            app.logger.warning('No super admin exists. Set ZAABOS_ADMIN_USERNAME and ZAABOS_ADMIN_PASSWORD, then redeploy once to bootstrap it.')
            conn.commit(); return
        password = secrets.token_urlsafe(18)
        print(f'[ZaabOS local bootstrap] username={username} temporary_password={password}')
    if len(password) < 12:
        if IS_POSTGRES:
            app.logger.error('ZAABOS_ADMIN_PASSWORD must be at least 12 characters; super admin was not created.')
            conn.commit(); return
    try:
        conn.execute('INSERT INTO users(tenant_id,username,password_hash,display_name,role,must_change_password,created_at) VALUES(NULL,?,?,?,?,1,?)',
            (username, hash_password(password), 'ผู้ดูแลระบบ', 'super_admin', now()))
        conn.commit()
    except INTEGRITY_ERRORS:
        conn.rollback()

def create_tenant_indexes(conn):
    for stmt in (
        'CREATE INDEX IF NOT EXISTS idx_branches_tenant ON branches(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_tables_tenant ON dining_tables(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_menu_items_tenant ON menu_items(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_orders_tenant_branch ON orders(tenant_id,branch_id)',
        'CREATE INDEX IF NOT EXISTS idx_menu_items_tenant_branch ON menu_items(tenant_id,branch_id)',
        'CREATE INDEX IF NOT EXISTS idx_tables_tenant_branch ON dining_tables(tenant_id,branch_id)',
        'CREATE INDEX IF NOT EXISTS idx_payments_tenant_branch ON payments(tenant_id,branch_id)',
        'CREATE INDEX IF NOT EXISTS idx_refunds_tenant_branch ON refunds(tenant_id,branch_id)',
    ):
        conn.execute(stmt)

def ensure_migration_ledger(conn):
    if IS_POSTGRES:
        conn.execute('''CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)''')
    else:
        conn.execute('''CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)''')
    conn.commit()


def record_migration(conn, version, name):
    row = conn.execute('SELECT 1 FROM schema_migrations WHERE version=?', (version,)).fetchone()
    if not row:
        conn.execute('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)', (version,name,now()))
        conn.commit()

def ensure_schema_migrations(conn):
    """Additive, idempotent column adds for installs that already have data —
    executescript's CREATE TABLE IF NOT EXISTS only helps on a fresh DB, so any
    new column on an existing table needs to be added here instead."""
    ensure_migration_ledger(conn)
    if IS_POSTGRES:
        # Multi-tenant order numbers: legacy schema made order_no globally
        # unique, which caused Tenant B's ...0001 to collide with Tenant A's.
        # Keep numbering independent per tenant while preserving all rows.
        conn.execute('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_no_key')
        conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_tenant_order_no ON orders(tenant_id, order_no)')
        conn.execute('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS kitchen_sent_at TIMESTAMP')
        conn.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount DOUBLE PRECISION NOT NULL DEFAULT 0')
        conn.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_received DOUBLE PRECISION')
        conn.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_count INTEGER')
        conn.execute('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS cost_price DOUBLE PRECISION NOT NULL DEFAULT 0')
        conn.execute('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS track_stock INTEGER NOT NULL DEFAULT 0')
        conn.execute('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stock_qty INTEGER')
        conn.execute('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5')
        conn.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT')
        conn.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TEXT')
        conn.execute('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cancelled_quantity INTEGER NOT NULL DEFAULT 0')
        conn.execute("ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cancellation_reason TEXT NOT NULL DEFAULT ''")
        conn.execute('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cancelled_at TEXT')
        conn.execute('''CREATE TABLE IF NOT EXISTS payments (
            id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL,
            order_id INTEGER NOT NULL, amount DOUBLE PRECISION NOT NULL, payment_method TEXT NOT NULL,
            cash_received DOUBLE PRECISION, reference TEXT NOT NULL DEFAULT '', paid_by_user_id INTEGER,
            paid_at TEXT NOT NULL, FOREIGN KEY(order_id) REFERENCES orders(id))''')
        conn.execute('''CREATE TABLE IF NOT EXISTS daily_closings (
            id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL,
            closing_date TEXT NOT NULL, opening_cash DOUBLE PRECISION NOT NULL DEFAULT 0, cash_out DOUBLE PRECISION NOT NULL DEFAULT 0,
            expected_cash DOUBLE PRECISION NOT NULL DEFAULT 0, counted_cash DOUBLE PRECISION NOT NULL DEFAULT 0,
            difference DOUBLE PRECISION NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', closed_by_user_id INTEGER,
            closed_at TEXT NOT NULL, UNIQUE(tenant_id,branch_id,closing_date))''')
        conn.execute('''CREATE TABLE IF NOT EXISTS refunds (
            id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL,
            order_id INTEGER NOT NULL, payment_id INTEGER, amount DOUBLE PRECISION NOT NULL, reason TEXT NOT NULL DEFAULT '',
            refunded_by_user_id INTEGER, refunded_at TEXT NOT NULL, FOREIGN KEY(order_id) REFERENCES orders(id))''')
        conn.commit()
    else:
        oi_cols = [r[1] for r in conn.execute('PRAGMA table_info(order_items)').fetchall()]
        if 'kitchen_sent_at' not in oi_cols:
            conn.execute('ALTER TABLE order_items ADD COLUMN kitchen_sent_at TEXT')
        o_cols = [r[1] for r in conn.execute('PRAGMA table_info(orders)').fetchall()]
        if 'tax_amount' not in o_cols:
            conn.execute('ALTER TABLE orders ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0')
        if 'cash_received' not in o_cols:
            conn.execute('ALTER TABLE orders ADD COLUMN cash_received REAL')
        if 'guest_count' not in o_cols:
            conn.execute('ALTER TABLE orders ADD COLUMN guest_count INTEGER')
        mi_cols = [r[1] for r in conn.execute('PRAGMA table_info(menu_items)').fetchall()]
        if 'cost_price' not in mi_cols:
            conn.execute('ALTER TABLE menu_items ADD COLUMN cost_price REAL NOT NULL DEFAULT 0')
        if 'track_stock' not in mi_cols:
            conn.execute('ALTER TABLE menu_items ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 0')
        if 'stock_qty' not in mi_cols:
            conn.execute('ALTER TABLE menu_items ADD COLUMN stock_qty INTEGER')
        if 'low_stock_threshold' not in mi_cols:
            conn.execute('ALTER TABLE menu_items ADD COLUMN low_stock_threshold INTEGER NOT NULL DEFAULT 5')
        if 'payment_method' not in o_cols: conn.execute('ALTER TABLE orders ADD COLUMN payment_method TEXT')
        if 'paid_at' not in o_cols: conn.execute('ALTER TABLE orders ADD COLUMN paid_at TEXT')
        if 'cancelled_quantity' not in oi_cols: conn.execute('ALTER TABLE order_items ADD COLUMN cancelled_quantity INTEGER NOT NULL DEFAULT 0')
        if 'cancellation_reason' not in oi_cols: conn.execute("ALTER TABLE order_items ADD COLUMN cancellation_reason TEXT NOT NULL DEFAULT ''")
        if 'cancelled_at' not in oi_cols: conn.execute('ALTER TABLE order_items ADD COLUMN cancelled_at TEXT')
        conn.execute('''CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL,
            order_id INTEGER NOT NULL, amount REAL NOT NULL, payment_method TEXT NOT NULL,
            cash_received REAL, reference TEXT NOT NULL DEFAULT '', paid_by_user_id INTEGER,
            paid_at TEXT NOT NULL, FOREIGN KEY(order_id) REFERENCES orders(id))''')
        conn.execute('''CREATE TABLE IF NOT EXISTS daily_closings (
            id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL,
            closing_date TEXT NOT NULL, opening_cash REAL NOT NULL DEFAULT 0, cash_out REAL NOT NULL DEFAULT 0,
            expected_cash REAL NOT NULL DEFAULT 0, counted_cash REAL NOT NULL DEFAULT 0, difference REAL NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '', closed_by_user_id INTEGER, closed_at TEXT NOT NULL,
            UNIQUE(tenant_id,branch_id,closing_date))''')
        conn.execute('''CREATE TABLE IF NOT EXISTS refunds (
            id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL,
            order_id INTEGER NOT NULL, payment_id INTEGER, amount REAL NOT NULL, reason TEXT NOT NULL DEFAULT '',
            refunded_by_user_id INTEGER, refunded_at TEXT NOT NULL, FOREIGN KEY(order_id) REFERENCES orders(id))''')
        conn.commit()
    record_migration(conn, 10, 'production_safety_foundation')
    # Round 11: DB-level concurrency invariants.
    # Migration 21 owns active-payment uniqueness. Do not recreate the legacy
    # full unique index because reopened bills retain reversed payment history.
    conn.execute('CREATE INDEX IF NOT EXISTS idx_refunds_tenant_order ON refunds(tenant_id,order_id)')
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_closing_tenant_branch_date ON daily_closings(tenant_id,branch_id,closing_date)')
    conn.commit()
    record_migration(conn, 11, 'concurrency_and_recovery_hardening')
    record_migration(conn, 12, 'production_acceptance_security')
    record_migration(conn, 13, 'launch_readiness_recovery')
    # Round 14B: richer restaurant modifiers. Existing groups remain single-choice.
    if IS_POSTGRES:
        conn.execute("ALTER TABLE menu_option_groups ADD COLUMN IF NOT EXISTS selection_type TEXT NOT NULL DEFAULT 'single'")
        conn.execute('ALTER TABLE menu_option_groups ADD COLUMN IF NOT EXISTS min_select INTEGER NOT NULL DEFAULT 0')
        conn.execute('ALTER TABLE menu_option_groups ADD COLUMN IF NOT EXISTS max_select INTEGER NOT NULL DEFAULT 1')
        conn.execute('ALTER TABLE menu_options ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1')
    else:
        mog_cols=[r[1] for r in conn.execute('PRAGMA table_info(menu_option_groups)').fetchall()]
        mo_cols=[r[1] for r in conn.execute('PRAGMA table_info(menu_options)').fetchall()]
        if 'selection_type' not in mog_cols: conn.execute("ALTER TABLE menu_option_groups ADD COLUMN selection_type TEXT NOT NULL DEFAULT 'single'")
        if 'min_select' not in mog_cols: conn.execute('ALTER TABLE menu_option_groups ADD COLUMN min_select INTEGER NOT NULL DEFAULT 0')
        if 'max_select' not in mog_cols: conn.execute('ALTER TABLE menu_option_groups ADD COLUMN max_select INTEGER NOT NULL DEFAULT 1')
        if 'active' not in mo_cols: conn.execute('ALTER TABLE menu_options ADD COLUMN active INTEGER NOT NULL DEFAULT 1')
    conn.commit()
    # Round 14A: restaurant operations — shifts, cash drawer and critical-operation reasons.
    idcol = 'INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY' if IS_POSTGRES else 'INTEGER PRIMARY KEY AUTOINCREMENT'
    money = 'DOUBLE PRECISION' if IS_POSTGRES else 'REAL'
    conn.execute(f'''CREATE TABLE IF NOT EXISTS work_shifts (
        id {idcol}, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, opened_by_user_id INTEGER NOT NULL,
        closed_by_user_id INTEGER, opened_at TEXT NOT NULL, closed_at TEXT, opening_cash {money} NOT NULL DEFAULT 0,
        counted_cash {money}, expected_cash {money}, difference {money}, status TEXT NOT NULL DEFAULT 'open',
        notes TEXT NOT NULL DEFAULT '')''')
    conn.execute(f'''CREATE TABLE IF NOT EXISTS cash_movements (
        id {idcol}, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, shift_id INTEGER NOT NULL,
        movement_type TEXT NOT NULL, amount {money} NOT NULL, reason TEXT NOT NULL, created_by_user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL, FOREIGN KEY(shift_id) REFERENCES work_shifts(id))''')
    conn.execute(f'''CREATE TABLE IF NOT EXISTS operation_reasons (
        id {idcol}, tenant_id INTEGER NOT NULL, operation_type TEXT NOT NULL, label TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)''')
    conn.execute(f'''CREATE TABLE IF NOT EXISTS critical_operations (
        id {idcol}, tenant_id INTEGER NOT NULL, branch_id INTEGER, operation_type TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT '', entity_id INTEGER, reason_id INTEGER, reason_text TEXT NOT NULL DEFAULT '',
        performed_by_user_id INTEGER NOT NULL, approved_by_user_id INTEGER, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)''')
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_open_shift_user_branch ON work_shifts(tenant_id,branch_id,opened_by_user_id) WHERE status='open'")
    conn.execute('CREATE INDEX IF NOT EXISTS idx_cash_movements_shift ON cash_movements(tenant_id,shift_id,created_at)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_critical_ops_tenant_created ON critical_operations(tenant_id,created_at)')
    conn.commit()
    record_migration(conn, 14, 'restaurant_operations_foundation')
    record_migration(conn, 15, 'restaurant_menu_modifiers')
    record_migration(conn, 16, 'critical_operations_approval')
    # Round 14D: pricing, promotions, service charge and tax.
    if IS_POSTGRES:
        conn.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount DOUBLE PRECISION NOT NULL DEFAULT 0')
        conn.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_charge_amount DOUBLE PRECISION NOT NULL DEFAULT 0')
        conn.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_label TEXT NOT NULL DEFAULT ''")
        conn.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS promotion_id INTEGER')
    else:
        o14=[r[1] for r in conn.execute('PRAGMA table_info(orders)').fetchall()]
        if 'discount_amount' not in o14: conn.execute('ALTER TABLE orders ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0')
        if 'service_charge_amount' not in o14: conn.execute('ALTER TABLE orders ADD COLUMN service_charge_amount REAL NOT NULL DEFAULT 0')
        if 'discount_label' not in o14: conn.execute("ALTER TABLE orders ADD COLUMN discount_label TEXT NOT NULL DEFAULT ''")
        if 'promotion_id' not in o14: conn.execute('ALTER TABLE orders ADD COLUMN promotion_id INTEGER')
    conn.execute(f"CREATE TABLE IF NOT EXISTS pricing_settings (id {idcol}, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, tax_rate {money} NOT NULL DEFAULT 0, service_charge_rate {money} NOT NULL DEFAULT 0, updated_by_user_id INTEGER, updated_at TEXT NOT NULL, UNIQUE(tenant_id,branch_id))")
    conn.execute(f"CREATE TABLE IF NOT EXISTS promotions (id {idcol}, tenant_id INTEGER NOT NULL, branch_id INTEGER, code TEXT NOT NULL, name TEXT NOT NULL, discount_type TEXT NOT NULL DEFAULT 'percent', discount_value {money} NOT NULL DEFAULT 0, min_spend {money} NOT NULL DEFAULT 0, max_discount {money}, starts_at TEXT, ends_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_by_user_id INTEGER, created_at TEXT NOT NULL)")
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS uq_promotions_tenant_code ON promotions(tenant_id,code)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_promotions_tenant_branch ON promotions(tenant_id,branch_id,active)')
    conn.commit()
    # Round 14E: fulfilment workflow for takeaway/delivery/pre-orders.
    if IS_POSTGRES:
        conn.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for TEXT')
        conn.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'pending'")
        conn.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee DOUBLE PRECISION NOT NULL DEFAULT 0')
        conn.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending'")
        conn.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_name TEXT NOT NULL DEFAULT ''")
        conn.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_phone TEXT NOT NULL DEFAULT ''")
        conn.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_note TEXT NOT NULL DEFAULT ''")
    else:
        o18=[r[1] for r in conn.execute('PRAGMA table_info(orders)').fetchall()]
        if 'scheduled_for' not in o18: conn.execute('ALTER TABLE orders ADD COLUMN scheduled_for TEXT')
        if 'fulfillment_status' not in o18: conn.execute("ALTER TABLE orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'pending'")
        if 'delivery_fee' not in o18: conn.execute('ALTER TABLE orders ADD COLUMN delivery_fee REAL NOT NULL DEFAULT 0')
        if 'delivery_status' not in o18: conn.execute("ALTER TABLE orders ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'")
        if 'driver_name' not in o18: conn.execute("ALTER TABLE orders ADD COLUMN driver_name TEXT NOT NULL DEFAULT ''")
        if 'driver_phone' not in o18: conn.execute("ALTER TABLE orders ADD COLUMN driver_phone TEXT NOT NULL DEFAULT ''")
        if 'delivery_note' not in o18: conn.execute("ALTER TABLE orders ADD COLUMN delivery_note TEXT NOT NULL DEFAULT ''")
    conn.execute('CREATE INDEX IF NOT EXISTS idx_orders_tenant_branch_scheduled ON orders(tenant_id,branch_id,scheduled_for)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_orders_tenant_delivery_status ON orders(tenant_id,delivery_status)')
    conn.commit()
    record_migration(conn, 17, 'pricing_promotions_service_tax')
    record_migration(conn, 18, 'fulfillment_delivery_preorder')
    record_migration(conn, 19, 'independent_audit_fixes')
    # Round 14G: UTC persistence + restaurant-local business dates + refund-to-shift attribution.
    if IS_POSTGRES:
        conn.execute('ALTER TABLE refunds ADD COLUMN IF NOT EXISTS shift_id INTEGER')
    else:
        r20=[r[1] for r in conn.execute('PRAGMA table_info(refunds)').fetchall()]
        if 'shift_id' not in r20: conn.execute('ALTER TABLE refunds ADD COLUMN shift_id INTEGER')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_refunds_tenant_shift ON refunds(tenant_id,shift_id)')
    conn.commit()
    record_migration(conn, 20, 'timezone_flexible_shift_refund_attribution')
    # Round 14H.1: auditable payment reversal / reopen-bill support.
    if IS_POSTGRES:
        conn.execute('ALTER TABLE payments ADD COLUMN IF NOT EXISTS reversed_at TEXT')
        conn.execute('ALTER TABLE payments ADD COLUMN IF NOT EXISTS reversed_by_user_id INTEGER')
        conn.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS reversal_reason TEXT NOT NULL DEFAULT ''")
        conn.execute('ALTER TABLE payments ADD COLUMN IF NOT EXISTS reversed_shift_id INTEGER')
        conn.execute('DROP INDEX IF EXISTS uq_payments_tenant_order')
        # Split payments allow multiple active payment rows per order; never recreate the legacy one-payment index.
    else:
        pcols=[r[1] for r in conn.execute('PRAGMA table_info(payments)').fetchall()]
        if 'reversed_at' not in pcols: conn.execute('ALTER TABLE payments ADD COLUMN reversed_at TEXT')
        if 'reversed_by_user_id' not in pcols: conn.execute('ALTER TABLE payments ADD COLUMN reversed_by_user_id INTEGER')
        if 'reversal_reason' not in pcols: conn.execute("ALTER TABLE payments ADD COLUMN reversal_reason TEXT NOT NULL DEFAULT ''")
        if 'reversed_shift_id' not in pcols: conn.execute('ALTER TABLE payments ADD COLUMN reversed_shift_id INTEGER')
        conn.execute('DROP INDEX IF EXISTS uq_payments_tenant_order')
        # Split payments allow multiple active payment rows per order; never recreate the legacy one-payment index.
    conn.execute('CREATE INDEX IF NOT EXISTS idx_payments_reversed_shift ON payments(tenant_id,reversed_shift_id)')
    conn.commit()
    record_migration(conn, 21, 'pos_workspace_payment_reversal')

    # Round 15 — Restaurant Core Complete
    # Split payments intentionally allow multiple active payment rows per order.
    conn.execute('DROP INDEX IF EXISTS uq_payments_tenant_order_active')
    money15 = 'DOUBLE PRECISION' if IS_POSTGRES else 'REAL'
    id15 = 'INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY' if IS_POSTGRES else 'INTEGER PRIMARY KEY AUTOINCREMENT'
    conn.execute(f"""CREATE TABLE IF NOT EXISTS kitchen_stations (
        id {id15}, tenant_id INTEGER NOT NULL, branch_id INTEGER, name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)""")
    conn.execute('CREATE INDEX IF NOT EXISTS idx_kitchen_stations_tenant_branch ON kitchen_stations(tenant_id,branch_id,active)')
    if IS_POSTGRES:
        conn.execute('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS kitchen_station_id INTEGER')
    else:
        c15=[r[1] for r in conn.execute('PRAGMA table_info(menu_items)').fetchall()]
        if 'kitchen_station_id' not in c15: conn.execute('ALTER TABLE menu_items ADD COLUMN kitchen_station_id INTEGER')
    conn.execute(f"""CREATE TABLE IF NOT EXISTS ingredients (
        id {id15}, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, name TEXT NOT NULL,
        unit TEXT NOT NULL DEFAULT 'unit', stock_qty {money15} NOT NULL DEFAULT 0,
        low_stock_threshold {money15} NOT NULL DEFAULT 0, cost_per_unit {money15} NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
    conn.execute('CREATE INDEX IF NOT EXISTS idx_ingredients_tenant_branch ON ingredients(tenant_id,branch_id,active)')
    conn.execute(f"""CREATE TABLE IF NOT EXISTS recipes (
        id {id15}, tenant_id INTEGER NOT NULL, menu_item_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL,
        quantity {money15} NOT NULL, created_at TEXT NOT NULL)""")
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS uq_recipe_menu_ingredient ON recipes(tenant_id,menu_item_id,ingredient_id)')
    conn.execute(f"""CREATE TABLE IF NOT EXISTS inventory_movements (
        id {id15}, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL,
        movement_type TEXT NOT NULL, quantity {money15} NOT NULL, reason TEXT NOT NULL DEFAULT '',
        order_id INTEGER, created_by_user_id INTEGER, created_at TEXT NOT NULL)""")
    conn.execute('CREATE INDEX IF NOT EXISTS idx_inventory_movements_tenant_branch ON inventory_movements(tenant_id,branch_id,created_at)')
    conn.commit()
    record_migration(conn, 22, 'restaurant_core_complete')
    # Round 15.1 — acceptance hardening
    conn.execute('DROP INDEX IF EXISTS uq_refunds_tenant_order')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_refunds_tenant_order ON refunds(tenant_id,order_id)')
    conn.commit()
    record_migration(conn, 23, 'round15_acceptance_hardening')
    # Round 16 — production audit & financial safety
    conn.execute('CREATE INDEX IF NOT EXISTS idx_order_items_order_active ON order_items(order_id,cancelled_quantity)')
    conn.commit()
    record_migration(conn, 24, 'production_financial_safety')
    # Round 17 — Restaurant Operations Complete
    id17 = 'INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY' if IS_POSTGRES else 'INTEGER PRIMARY KEY AUTOINCREMENT'
    conn.execute(f"""CREATE TABLE IF NOT EXISTS inventory_counts (
        id {id17}, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL,
        system_qty DOUBLE PRECISION NOT NULL, counted_qty DOUBLE PRECISION NOT NULL,
        difference DOUBLE PRECISION NOT NULL, note TEXT NOT NULL DEFAULT '',
        counted_by_user_id INTEGER, counted_at TEXT NOT NULL)""")
    conn.execute('CREATE INDEX IF NOT EXISTS idx_inventory_counts_tenant_branch ON inventory_counts(tenant_id,branch_id,counted_at)')
    conn.execute(f"""CREATE TABLE IF NOT EXISTS kitchen_print_jobs (
        id {id17}, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, order_id INTEGER NOT NULL,
        station_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, printed_at TEXT)""")
    conn.execute('CREATE INDEX IF NOT EXISTS idx_kitchen_print_jobs_queue ON kitchen_print_jobs(tenant_id,branch_id,status,created_at)')
    conn.commit()
    record_migration(conn, 25, 'restaurant_operations_complete')
    # Round 18 — SaaS Commercial Layer
    tenant_cols = {'plan_code': "TEXT NOT NULL DEFAULT 'starter'", 'subscription_status': "TEXT NOT NULL DEFAULT 'trialing'",
        'trial_ends_at':'TEXT','current_period_end':'TEXT','max_branches':'INTEGER NOT NULL DEFAULT 1',
        'max_users':'INTEGER NOT NULL DEFAULT 5','subscription_note':"TEXT NOT NULL DEFAULT ''"}
    # Migration 26 owns subscription-column upgrades for existing databases.
    if IS_POSTGRES:
        existing_tenant_cols = {r['column_name'] for r in conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tenants'"
        ).fetchall()}
    else:
        existing_tenant_cols = {r['name'] for r in conn.execute('PRAGMA table_info(tenants)').fetchall()}
    for col, ddl in tenant_cols.items():
        if col not in existing_tenant_cols:
            conn.execute(f'ALTER TABLE tenants ADD COLUMN {col} {ddl}')
    id18 = 'INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY' if IS_POSTGRES else 'INTEGER PRIMARY KEY AUTOINCREMENT'
    conn.execute(f"""CREATE TABLE IF NOT EXISTS saas_plans (
        id {id18}, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, max_branches INTEGER NOT NULL,
        max_users INTEGER NOT NULL, monthly_price DOUBLE PRECISION NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)""")
    for code,name,branches,users,price in (('starter','Starter',1,5,0),('growth','Growth',3,15,0),('pro','Pro',10,50,0)):
        try: conn.execute('INSERT INTO saas_plans(code,name,max_branches,max_users,monthly_price,created_at) VALUES(?,?,?,?,?,?)',(code,name,branches,users,price,now()))
        except INTEGRITY_ERRORS:
            if IS_POSTGRES: conn.rollback()
    conn.execute('CREATE INDEX IF NOT EXISTS idx_tenants_subscription ON tenants(active,subscription_status,trial_ends_at,current_period_end)')
    conn.commit()
    record_migration(conn, 26, 'saas_commercial_layer')
    # Round 20 — Offline POS + Safe Sync
    if IS_POSTGRES:
        order_cols = {r['column_name'] for r in conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'"
        ).fetchall()}
    else:
        order_cols = {r['name'] for r in conn.execute('PRAGMA table_info(orders)').fetchall()}
    if 'client_request_id' not in order_cols:
        conn.execute('ALTER TABLE orders ADD COLUMN client_request_id TEXT')
    if 'client_device_id' not in order_cols:
        conn.execute('ALTER TABLE orders ADD COLUMN client_device_id TEXT')
    if 'offline_created_at' not in order_cols:
        conn.execute('ALTER TABLE orders ADD COLUMN offline_created_at TEXT')
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_tenant_client_request ON orders(tenant_id,client_request_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_orders_tenant_device ON orders(tenant_id,client_device_id,created_at)')
    conn.commit()
    record_migration(conn, 27, 'offline_pos_safe_sync')







def init_db():
    if IS_POSTGRES:
        conn = PGConn(os.getenv('DATABASE_URL'))
        conn.executescript((BASE / 'schema_postgres.sql').read_text())
        ensure_default_tenant(conn)
        ensure_super_admin(conn)
        ensure_schema_migrations(conn)
        create_tenant_indexes(conn)
        conn.commit()
        conn.close()
        return
    conn = sqlite3.connect(DB)
    conn.execute('PRAGMA foreign_keys=ON')
    conn.executescript((BASE / 'schema.sql').read_text())
    create_tenant_indexes(conn)
    ensure_default_tenant(conn)
    ensure_super_admin(conn)
    ensure_schema_migrations(conn)
    conn.commit(); conn.close()

# ---------- auth helpers (same pattern as CASHFLOW 24) ----------

def get_current_user(conn):
    uid = session.get('user_id')
    if not uid: return None
    u = conn.execute('SELECT * FROM users WHERE id=? AND active=1', (uid,)).fetchone()
    return dict(u) if u else None

def tenant_active(conn, tenant_id):
    if tenant_id is None: return True
    row=conn.execute('SELECT * FROM tenants WHERE id=?',(tenant_id,)).fetchone()
    if not row or not row['active']: return False
    status=(row['subscription_status'] or 'active') if 'subscription_status' in row.keys() else 'active'
    if status in ('suspended','canceled','expired','past_due'): return False
    cutoff=row['trial_ends_at'] if status=='trialing' else row['current_period_end']
    if cutoff:
        try:
            end=datetime.fromisoformat(str(cutoff).replace('Z','+00:00'))
            if end.tzinfo is None:end=end.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc)>end:return False
        except Exception: pass
    return True

def effective_tenant_id(conn, user):
    if user['role'] == 'super_admin':
        tid = session.get('active_tenant_id')
        if tid in (None, ''):
            row = conn.execute('SELECT id FROM tenants WHERE active=1 ORDER BY id LIMIT 1').fetchone()
            tid = row['id'] if row else None
            session['active_tenant_id'] = tid
        return None if tid == 'all' else tid
    return user['tenant_id']

def login_required(f):
    @functools.wraps(f)
    def wrapper(*a, **kw):
        conn = db()
        user = get_current_user(conn)
        if not user:
            session.clear()
            return jsonify(error='กรุณาเข้าสู่ระบบ'), 401
        if user['role'] != 'super_admin' and not tenant_active(conn, user['tenant_id']):
            session.clear()
            return jsonify(error='ร้านนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ'), 403
        if request.method in ('POST', 'PUT', 'DELETE'):
            token = request.headers.get('X-CSRF-Token')
            if not token or token != session.get('csrf_token'):
                return jsonify(error='คำขอไม่ถูกต้อง กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง'), 403
        g.user = user
        g.tenant_id = effective_tenant_id(conn, user)
        return f(*a, **kw)
    return wrapper

def role_required(*roles):
    def deco(f):
        @functools.wraps(f)
        def wrapper(*a, **kw):
            if g.user['role'] != 'super_admin' and g.user['role'] not in roles:
                return jsonify(error='คุณไม่มีสิทธิ์ทำรายการนี้'), 403
            return f(*a, **kw)
        return wrapper
    return deco

def super_admin_required(f):
    @functools.wraps(f)
    def wrapper(*a, **kw):
        if g.user['role'] != 'super_admin':
            return jsonify(error='เฉพาะผู้ดูแลระบบเท่านั้น'), 403
        return f(*a, **kw)
    return wrapper

def require_tenant():
    if g.tenant_id is None:
        return jsonify(error='กรุณาเลือกร้านก่อนทำรายการนี้'), 400
    return None

def log_action(action, detail='', tenant_id=None):
    conn = db()
    tid = tenant_id if tenant_id is not None else g.get('tenant_id')
    conn.execute('INSERT INTO audit_logs(tenant_id,user_id,action,detail,created_at) VALUES(?,?,?,?,?)',
        (tid, g.user['id'] if g.get('user') else None, action, detail, now()))

def gen_qr_token():
    return secrets.token_urlsafe(12)

def gen_order_no(conn, tenant_id):
    """Return the next daily order number inside one tenant.

    Do not use COUNT(): if an older order was removed, COUNT can point at an
    already-used suffix. Reading the highest fixed-width number also makes the
    retry path advance correctly after a concurrent insert commits.
    """
    today = restaurant_now().strftime('%Y%m%d')
    prefix = f'Z-{today}-'
    row = conn.execute(
        "SELECT order_no FROM orders WHERE tenant_id=? AND order_no LIKE ? ORDER BY order_no DESC LIMIT 1",
        (tenant_id, prefix + '%')
    ).fetchone()
    seq = 1
    if row and row['order_no']:
        try:
            seq = int(str(row['order_no']).rsplit('-', 1)[1]) + 1
        except (ValueError, IndexError):
            seq = 1
    return f'{prefix}{seq:04d}'

MAX_ORDER_NO_RETRIES = 5

def insert_order_row(conn, tenant_id, insert_sql, build_params):
    """Runs the INSERT for a new order, regenerating order_no and retrying if two
    requests land on the same order_no at once (a COUNT-then-INSERT race — two
    staff/customers confirming an order in the same instant can both compute the
    same next sequence number). Returns (order_no, cursor)."""
    for attempt in range(MAX_ORDER_NO_RETRIES):
        order_no = gen_order_no(conn, tenant_id)
        try:
            cur = conn.execute(insert_sql, build_params(order_no))
            return order_no, cur
        except INTEGRITY_ERRORS:
            conn.rollback()
            if attempt == MAX_ORDER_NO_RETRIES - 1:
                raise

# =====================================================================
# Static pages
# =====================================================================

@app.get('/favicon.ico')
def favicon_root():
    resp = send_from_directory(app.static_folder, 'favicon.ico', mimetype='image/x-icon')
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp

@app.get('/apple-touch-icon.png')
def apple_touch_icon_root():
    resp = send_from_directory(app.static_folder, 'zaabos-icon-192.png', mimetype='image/png')
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.get('/sw.js')
def service_worker():
    resp=send_from_directory(app.static_folder,'sw.js',mimetype='application/javascript')
    resp.headers['Service-Worker-Allowed']='/'
    resp.headers['Cache-Control']='no-cache, no-store, must-revalidate'
    return resp

@app.get('/offline')
def offline_page():
    return render_template('offline.html')

@app.get('/')
def index():
    return render_template('index.html')

@app.get('/order/<qr_token>')
def order_page_table(qr_token):
    return render_template('order.html')

@app.get('/order')
def order_page_generic():
    return render_template('order.html')

@app.get('/track')
def track_page():
    return render_template('track.html')

@app.get('/kitchen')
def kitchen_page():
    return render_template('kitchen.html')

# Production health probes. They expose no tenant/business data.
@app.get('/api/admin/production-readiness')
@login_required
@super_admin_required
def production_readiness():
    checks = {
        'database': 'postgresql' if IS_POSTGRES else 'sqlite',
        'secret_key_env': bool(os.environ.get('ZAABOS_SECRET_KEY') or os.environ.get('SECRET_KEY')),
        'admin_password_env': bool(os.environ.get('ZAABOS_ADMIN_PASSWORD')),
        'https_expected': bool(IS_POSTGRES or os.environ.get('RAILWAY_ENVIRONMENT')),
        'backup_dir_configured': bool(os.environ.get('ZAABOS_BACKUP_DIR')),
    }
    # Backup directory alone is not counted as disaster recovery: production
    # needs provider/off-site backups and a tested restore procedure.
    warnings = []
    if IS_POSTGRES and not checks['secret_key_env']:
        warnings.append('ตั้ง ZAABOS_SECRET_KEY แบบคงที่ใน Railway เพื่อไม่ให้ session เปลี่ยนเมื่อ redeploy')
    if IS_POSTGRES and not checks['backup_dir_configured']:
        warnings.append('ยังไม่ได้กำหนด ZAABOS_BACKUP_DIR; และควรมี off-site/provider PostgreSQL backup แยกจาก app')
    return jsonify(ok=True, checks=checks, warnings=warnings)

@app.get('/api/system/timezone')
def system_timezone():
    return jsonify(timezone=RESTAURANT_TIMEZONE, now_utc=now(), now_local=restaurant_now().isoformat(timespec='seconds'))

@app.get('/healthz')
def healthz():
    return jsonify(ok=True, service='zaabos')

@app.get('/readyz')
def readyz():
    try:
        conn = db()
        conn.execute('SELECT 1 AS ok').fetchone()
        row = conn.execute('SELECT MAX(version) AS version FROM schema_migrations').fetchone()
        return jsonify(ok=True, database='ok', schema_version=(row['version'] if row else None))
    except Exception:
        app.logger.exception('readiness check failed')
        return jsonify(ok=False, database='error'), 503

# =====================================================================
# Auth routes
# =====================================================================

@app.post('/api/login')
def login():
    d = request.get_json() or {}
    username = (d.get('username') or '').strip(); password = d.get('password') or ''
    if not username or not password: return jsonify(error='กรุณาใส่ชื่อผู้ใช้และรหัสผ่าน'), 400
    conn = db()
    user = conn.execute('SELECT * FROM users WHERE username=? AND active=1', (username,)).fetchone()
    if user and user['locked_until'] and user['locked_until'] > now():
        return jsonify(error='ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่'), 429
    if not user or not verify_password(user['password_hash'], password):
        if user:
            attempts = (user['failed_attempts'] or 0) + 1
            locked = None
            if attempts >= 8:
                locked = (datetime.now() + timedelta(minutes=5)).isoformat(timespec='seconds')
            conn.execute('UPDATE users SET failed_attempts=?,locked_until=? WHERE id=?', (attempts, locked, user['id']))
            conn.commit()
        return jsonify(error='ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'), 401
    if user['role'] != 'super_admin' and not tenant_active(conn, user['tenant_id']):
        return jsonify(error='ร้านนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ'), 403
    conn.execute('UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=?', (user['id'],))
    session.clear(); session.permanent = True
    session['user_id'] = user['id']; session['csrf_token'] = secrets.token_hex(16)
    g.user = dict(user); g.tenant_id = effective_tenant_id(conn, dict(user))
    log_action('login'); conn.commit()
    return me()

@app.post('/api/logout')
def logout():
    conn = db(); user = get_current_user(conn)
    if user:
        g.user = user; g.tenant_id = user['tenant_id'] if user['role'] != 'super_admin' else session.get('active_tenant_id')
        if g.tenant_id == 'all': g.tenant_id = None
        log_action('logout'); conn.commit()
    session.clear()
    return jsonify(ok=True)

@app.get('/api/me')
def me():
    conn = db(); user = get_current_user(conn)
    if not user: return jsonify(error='ยังไม่ได้เข้าสู่ระบบ'), 401
    if not session.get('csrf_token'): session['csrf_token'] = secrets.token_hex(16)
    tenant_id = effective_tenant_id(conn, user)
    scope = 'all' if (user['role'] == 'super_admin' and session.get('active_tenant_id') == 'all') else 'tenant'
    tenant = None
    if tenant_id:
        t = conn.execute('SELECT * FROM tenants WHERE id=?', (tenant_id,)).fetchone()
        tenant = dict(t) if t else None
    resp = dict(id=user['id'], username=user['username'], display_name=user['display_name'], role=user['role'],
        csrf_token=session['csrf_token'], tenant_id=tenant_id, tenant=tenant, scope=scope,
        must_change_password=bool(user['must_change_password']))
    if user['role'] == 'super_admin':
        resp['tenants'] = [dict(x) for x in conn.execute('SELECT id,name,icon FROM tenants WHERE active=1 ORDER BY name')]
    return jsonify(resp)

@app.post('/api/change-password')
@login_required
def change_password():
    d = request.get_json() or {}
    current = d.get('current_password') or ''; new = d.get('new_password') or ''
    conn = db()
    user = conn.execute('SELECT * FROM users WHERE id=?', (g.user['id'],)).fetchone()
    if not verify_password(user['password_hash'], current):
        return jsonify(error='รหัสผ่านเดิมไม่ถูกต้อง'), 400
    if len(new) < 10: return jsonify(error='รหัสผ่านใหม่ต้องยาวอย่างน้อย 10 ตัวอักษร'), 400
    conn.execute('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?', (hash_password(new), user['id']))
    log_action('change_password'); conn.commit()
    return jsonify(ok=True)

@app.post('/api/change-username')
@login_required
def change_username():
    d = request.get_json() or {}
    new_username = (d.get('new_username') or '').strip()
    password = d.get('password') or ''
    conn = db()
    user = conn.execute('SELECT * FROM users WHERE id=?', (g.user['id'],)).fetchone()
    if not verify_password(user['password_hash'], password):
        return jsonify(error='รหัสผ่านไม่ถูกต้อง'), 400
    if len(new_username) < 3:
        return jsonify(error='ชื่อผู้ใช้ต้องยาวอย่างน้อย 3 ตัวอักษร'), 400
    dupe = conn.execute('SELECT 1 FROM users WHERE username=? AND id!=?', (new_username, user['id'])).fetchone()
    if dupe:
        return jsonify(error='ชื่อผู้ใช้นี้มีคนใช้แล้ว กรุณาใช้ชื่ออื่น'), 400
    try:
        conn.execute('UPDATE users SET username=? WHERE id=?', (new_username, user['id']))
    except INTEGRITY_ERRORS:
        return jsonify(error='ชื่อผู้ใช้นี้มีคนใช้แล้ว กรุณาใช้ชื่ออื่น'), 400
    log_action('change_username', detail=f'{user["username"]} -> {new_username}')
    conn.commit()
    return jsonify(ok=True, username=new_username)

# =====================================================================
# Tenants (super_admin only) — one tenant = one restaurant customer of ZaabOS
# =====================================================================

@app.get('/api/tenants')
@login_required
@super_admin_required
def list_tenants():
    conn = db()
    rows=conn.execute("""SELECT t.*,
      (SELECT COUNT(*) FROM branches b WHERE b.tenant_id=t.id AND b.active=1) branch_count,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id AND u.active=1) user_count
      FROM tenants t ORDER BY t.name""").fetchall()
    return jsonify(tenants=[dict(x) for x in rows])

@app.post('/api/tenants')
@login_required
@super_admin_required
def add_tenant():
    d = request.get_json() or {}
    name = (d.get('name') or '').strip()
    owner_username = (d.get('owner_username') or '').strip()
    owner_display = (d.get('owner_display') or '').strip()
    owner_password = d.get('owner_password') or ''
    if not name or not owner_username or not owner_display or not owner_password:
        return jsonify(error='กรุณากรอกข้อมูลให้ครบ'), 400
    if len(owner_password) < 10: return jsonify(error='รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร'), 400
    conn=db(); plan_code=(d.get('plan_code') or 'starter').strip()
    plan=conn.execute('SELECT * FROM saas_plans WHERE code=? AND active=1',(plan_code,)).fetchone()
    if not plan:return jsonify(error='แพ็กเกจไม่ถูกต้อง'),400
    try: trial_days=max(0,min(90,int(d.get('trial_days',14))))
    except: trial_days=14
    trial_end=(datetime.now(timezone.utc)+timedelta(days=trial_days)).isoformat(timespec='seconds') if trial_days else None
    status='trialing' if trial_days else 'active'
    cur=conn.execute('INSERT INTO tenants(name,icon,plan_code,subscription_status,trial_ends_at,max_branches,max_users,created_at) VALUES(?,?,?,?,?,?,?,?)',
        (name,'🍽️',plan_code,status,trial_end,plan['max_branches'],plan['max_users'],now()))
    tenant_id=cur.lastrowid
    try:
        conn.execute('INSERT INTO users(tenant_id,username,password_hash,display_name,role,must_change_password,created_at) VALUES(?,?,?,?,?,?,?)',
            (tenant_id, owner_username, hash_password(owner_password), owner_display, 'owner', 1, now()))
    except INTEGRITY_ERRORS:
        conn.rollback()
        return jsonify(error='ชื่อผู้ใช้นี้มีคนใช้แล้ว'), 400
    # every new tenant starts with one branch so it isn't an empty shell
    conn.execute('INSERT INTO branches(tenant_id,name,icon,created_at) VALUES(?,?,?,?)', (tenant_id, name, '🏠', now()))
    log_action('add_tenant', detail=name, tenant_id=tenant_id)
    conn.commit()
    return jsonify(ok=True, id=tenant_id)


@app.get('/api/saas/plans')
@login_required
@super_admin_required
def saas_plans():
    return jsonify(plans=[dict(x) for x in db().execute('SELECT * FROM saas_plans WHERE active=1 ORDER BY max_branches,max_users').fetchall()])

@app.put('/api/tenants/<int:tid>/subscription')
@login_required
@super_admin_required
def update_tenant_subscription(tid):
    d=request.get_json() or {}; conn=db(); tenant=conn.execute('SELECT * FROM tenants WHERE id=?',(tid,)).fetchone()
    if not tenant:return jsonify(error='ไม่พบร้าน'),404
    plan_code=(d.get('plan_code') or tenant['plan_code'] or 'starter').strip()
    plan=conn.execute('SELECT * FROM saas_plans WHERE code=? AND active=1',(plan_code,)).fetchone()
    if not plan:return jsonify(error='แพ็กเกจไม่ถูกต้อง'),400
    status=d.get('subscription_status') or tenant['subscription_status'] or 'active'
    if status not in ('trialing','active','past_due','suspended','canceled','expired'):return jsonify(error='สถานะ subscription ไม่ถูกต้อง'),400
    trial_ends=d.get('trial_ends_at') if 'trial_ends_at' in d else tenant['trial_ends_at']
    period_end=d.get('current_period_end') if 'current_period_end' in d else tenant['current_period_end']
    max_branches=int(d.get('max_branches') or plan['max_branches']); max_users=int(d.get('max_users') or plan['max_users'])
    if max_branches<1 or max_users<1:return jsonify(error='Limit ต้องมากกว่า 0'),400
    note=(d.get('subscription_note') if 'subscription_note' in d else tenant['subscription_note']) or ''
    conn.execute('UPDATE tenants SET plan_code=?,subscription_status=?,trial_ends_at=?,current_period_end=?,max_branches=?,max_users=?,subscription_note=? WHERE id=?',
      (plan_code,status,trial_ends or None,period_end or None,max_branches,max_users,note[:500],tid))
    log_action('update_subscription',detail=f'tenant={tid} plan={plan_code} status={status}',tenant_id=tid);conn.commit();return jsonify(ok=True)

@app.post('/api/tenants/<int:tid>/reactivate')
@login_required
@super_admin_required
def reactivate_tenant(tid):
    conn=db()
    if not conn.execute('SELECT 1 FROM tenants WHERE id=?',(tid,)).fetchone():return jsonify(error='ไม่พบร้าน'),404
    conn.execute("UPDATE tenants SET active=1,subscription_status=CASE WHEN subscription_status='suspended' THEN 'active' ELSE subscription_status END WHERE id=?",(tid,))
    log_action('reactivate_tenant',detail=str(tid),tenant_id=tid);conn.commit();return jsonify(ok=True)

@app.get('/api/admin/saas-summary')
@login_required
@super_admin_required
def saas_summary():
    r=db().execute("""SELECT COUNT(*) total,SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) enabled,
      SUM(CASE WHEN subscription_status='trialing' THEN 1 ELSE 0 END) trialing,
      SUM(CASE WHEN subscription_status='active' THEN 1 ELSE 0 END) subscribed,
      SUM(CASE WHEN subscription_status IN ('past_due','suspended','expired','canceled') OR active=0 THEN 1 ELSE 0 END) attention FROM tenants""").fetchone()
    return jsonify(dict(r))

@app.delete('/api/tenants/<int:tid>')
@login_required
@super_admin_required
def archive_tenant(tid):
    conn = db()
    conn.execute('UPDATE tenants SET active=0 WHERE id=?', (tid,))
    log_action('archive_tenant', detail=str(tid))
    conn.commit()
    return jsonify(ok=True)

@app.post('/api/switch-tenant')
@login_required
def switch_tenant():
    if g.user['role'] != 'super_admin': return jsonify(error='ไม่มีสิทธิ์'), 403
    d = request.get_json() or {}; tid = d.get('tenant_id'); conn = db()
    if tid == 'all':
        session['active_tenant_id'] = 'all'
    else:
        try: tid = int(tid)
        except (TypeError, ValueError): return jsonify(error='ข้อมูลไม่ถูกต้อง'), 400
        if not conn.execute('SELECT 1 FROM tenants WHERE id=?', (tid,)).fetchone():
            return jsonify(error='ไม่พบร้าน'), 404
        session['active_tenant_id'] = tid
    return jsonify(ok=True)

# =====================================================================
# Branches
# =====================================================================

@app.get('/api/branches')
@login_required
def list_branches():
    conn = db()
    if g.tenant_id is None:
        return jsonify(branches=[])
    rows = conn.execute('SELECT * FROM branches WHERE tenant_id=? AND active=1 ORDER BY id', (g.tenant_id,)).fetchall()
    return jsonify(branches=[dict(x) for x in rows])

@app.post('/api/branches')
@login_required
@role_required('owner')
def add_branch():
    err = require_tenant()
    if err: return err
    d = request.get_json() or {}
    name = (d.get('name') or '').strip()
    if not name: return jsonify(error='กรุณาใส่ชื่อสาขา'), 400
    conn=db(); tenant=conn.execute('SELECT max_branches FROM tenants WHERE id=?'+(' FOR UPDATE' if IS_POSTGRES else ''),(g.tenant_id,)).fetchone()
    used=conn.execute('SELECT COUNT(*) c FROM branches WHERE tenant_id=? AND active=1',(g.tenant_id,)).fetchone()['c']
    if tenant and used>=int(tenant['max_branches'] or 1):return jsonify(error=f"แพ็กเกจนี้รองรับสูงสุด {tenant['max_branches']} สาขา กรุณาอัปเกรดแพ็กเกจ"),409
    cur = conn.execute('INSERT INTO branches(tenant_id,name,icon,created_at) VALUES(?,?,?,?)',
        (g.tenant_id, name, d.get('icon') or '🏠', now()))
    log_action('add_branch', detail=name)
    conn.commit()
    return jsonify(ok=True, id=cur.lastrowid)

@app.put('/api/branches/<int:bid>')
@login_required
@role_required('owner')
def edit_branch(bid):
    conn = db()
    old = conn.execute('SELECT * FROM branches WHERE id=? AND tenant_id=?', (bid, g.tenant_id)).fetchone()
    if not old: return jsonify(error='ไม่พบสาขา'), 404
    d = request.get_json() or {}
    name = (d.get('name') or old['name']).strip()
    icon = d.get('icon') or old['icon']
    conn.execute('UPDATE branches SET name=?,icon=? WHERE id=?', (name, icon, bid))
    log_action('edit_branch', detail=str(bid))
    conn.commit()
    return jsonify(ok=True)

@app.delete('/api/branches/<int:bid>')
@login_required
@role_required('owner')
def archive_branch(bid):
    conn = db()
    conn.execute('UPDATE branches SET active=0 WHERE id=? AND tenant_id=?', (bid, g.tenant_id))
    log_action('archive_branch', detail=str(bid))
    conn.commit()
    return jsonify(ok=True)

# =====================================================================
# Tables (dining tables) — each has a unique QR token
# =====================================================================

@app.get('/api/tables')
@login_required
def list_tables():
    conn = db()
    if g.tenant_id is None: return jsonify(tables=[])
    branch_id = request.args.get('branch_id')
    q = 'SELECT * FROM dining_tables WHERE tenant_id=? AND active=1'
    args = [g.tenant_id]
    if branch_id: q += ' AND branch_id=?'; args.append(branch_id)
    q += ' ORDER BY id'
    rows = conn.execute(q, args).fetchall()
    return jsonify(tables=[dict(x) for x in rows])

@app.post('/api/tables')
@login_required
@role_required('owner', 'manager')
def add_table():
    err = require_tenant()
    if err: return err
    d = request.get_json() or {}
    name = (d.get('name') or '').strip()
    branch_id = d.get('branch_id')
    if not name or not branch_id: return jsonify(error='กรุณาใส่ชื่อโต๊ะและเลือกสาขา'), 400
    conn = db()
    branch = conn.execute('SELECT 1 FROM branches WHERE id=? AND tenant_id=?', (branch_id, g.tenant_id)).fetchone()
    if not branch: return jsonify(error='ไม่พบสาขา'), 404
    token = gen_qr_token()
    cur = conn.execute('INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,created_at) VALUES(?,?,?,?,?)',
        (g.tenant_id, branch_id, name, token, now()))
    log_action('add_table', detail=name)
    conn.commit()
    return jsonify(ok=True, id=cur.lastrowid, qr_token=token)

@app.post('/api/tables/bulk')
@login_required
@role_required('owner', 'manager')
def add_tables_bulk():
    """Quickly create N numbered tables at once (โต๊ะ 1..N) for a branch."""
    err = require_tenant()
    if err: return err
    d = request.get_json() or {}
    branch_id = d.get('branch_id')
    count = d.get('count')
    try:
        count = int(count)
    except (TypeError, ValueError):
        return jsonify(error='จำนวนโต๊ะไม่ถูกต้อง'), 400
    if not branch_id or count < 1 or count > 200:
        return jsonify(error='กรุณาเลือกสาขาและระบุจำนวนโต๊ะ (1-200)'), 400
    conn = db()
    branch = conn.execute('SELECT 1 FROM branches WHERE id=? AND tenant_id=?', (branch_id, g.tenant_id)).fetchone()
    if not branch: return jsonify(error='ไม่พบสาขา'), 404
    existing = conn.execute('SELECT COUNT(*) AS c FROM dining_tables WHERE branch_id=?', (branch_id,)).fetchone()['c']
    created = []
    for i in range(1, count + 1):
        token = gen_qr_token()
        cur = conn.execute('INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,created_at) VALUES(?,?,?,?,?)',
            (g.tenant_id, branch_id, f'โต๊ะ {existing + i}', token, now()))
        created.append(cur.lastrowid)
    log_action('add_tables_bulk', detail=f'{count} tables')
    conn.commit()
    return jsonify(ok=True, created=len(created))

@app.put('/api/tables/<int:tbid>')
@login_required
@role_required('owner', 'manager')
def edit_table(tbid):
    conn = db()
    old = conn.execute('SELECT * FROM dining_tables WHERE id=? AND tenant_id=?', (tbid, g.tenant_id)).fetchone()
    if not old: return jsonify(error='ไม่พบโต๊ะ'), 404
    d = request.get_json() or {}
    name = (d.get('name') or old['name']).strip()
    conn.execute('UPDATE dining_tables SET name=? WHERE id=?', (name, tbid))
    log_action('edit_table', detail=str(tbid))
    conn.commit()
    return jsonify(ok=True)

@app.delete('/api/tables/<int:tbid>')
@login_required
@role_required('owner', 'manager')
def archive_table(tbid):
    conn = db()
    conn.execute('UPDATE dining_tables SET active=0 WHERE id=? AND tenant_id=?', (tbid, g.tenant_id))
    log_action('archive_table', detail=str(tbid))
    conn.commit()
    return jsonify(ok=True)

# =====================================================================
# Menu: categories, items, option groups/options
# =====================================================================

@app.get('/api/menu-categories')
@login_required
def list_menu_categories():
    conn = db()
    if g.tenant_id is None: return jsonify(categories=[])
    branch_id = request.args.get('branch_id')
    q = 'SELECT * FROM menu_categories WHERE tenant_id=? AND active=1'
    args = [g.tenant_id]
    if branch_id: q += ' AND branch_id=?'; args.append(branch_id)
    q += ' ORDER BY sort_order,id'
    rows = conn.execute(q, args).fetchall()
    return jsonify(categories=[dict(x) for x in rows])

@app.post('/api/menu-categories')
@login_required
@role_required('owner', 'manager')
def add_menu_category():
    err = require_tenant()
    if err: return err
    d = request.get_json() or {}
    name = (d.get('name') or '').strip(); branch_id = d.get('branch_id')
    if not name or not branch_id: return jsonify(error='กรุณาใส่ชื่อหมวดหมู่และเลือกสาขา'), 400
    conn = db()
    branch = conn.execute('SELECT id FROM branches WHERE id=? AND tenant_id=? AND active=1', (branch_id, g.tenant_id)).fetchone()
    if not branch: return jsonify(error='สาขาไม่ถูกต้องหรือไม่ได้อยู่ในร้านนี้'), 400
    cur = conn.execute('INSERT INTO menu_categories(tenant_id,branch_id,name,icon,sort_order,created_at) VALUES(?,?,?,?,?,?)',
        (g.tenant_id, branch_id, name, d.get('icon') or '🍜', d.get('sort_order') or 0, now()))
    log_action('add_menu_category', detail=name)
    conn.commit()
    return jsonify(ok=True, id=cur.lastrowid)

@app.put('/api/menu-categories/<int:cid>')
@login_required
@role_required('owner', 'manager')
def edit_menu_category(cid):
    conn = db()
    old = conn.execute('SELECT * FROM menu_categories WHERE id=? AND tenant_id=?', (cid, g.tenant_id)).fetchone()
    if not old: return jsonify(error='ไม่พบหมวดหมู่'), 404
    d = request.get_json() or {}
    conn.execute('UPDATE menu_categories SET name=?,icon=?,sort_order=? WHERE id=?',
        ((d.get('name') or old['name']).strip(), d.get('icon') or old['icon'], d.get('sort_order', old['sort_order']), cid))
    log_action('edit_menu_category', detail=str(cid))
    conn.commit()
    return jsonify(ok=True)

@app.delete('/api/menu-categories/<int:cid>')
@login_required
@role_required('owner', 'manager')
def archive_menu_category(cid):
    conn = db()
    conn.execute('UPDATE menu_categories SET active=0 WHERE id=? AND tenant_id=?', (cid, g.tenant_id))
    log_action('archive_menu_category', detail=str(cid))
    conn.commit()
    return jsonify(ok=True)

def _menu_item_with_options(conn, item):
    d = dict(item)
    groups = conn.execute('SELECT * FROM menu_option_groups WHERE menu_item_id=? ORDER BY sort_order,id', (item['id'],)).fetchall()
    d['option_groups'] = []
    for grp in groups:
        gd = dict(grp)
        opts = conn.execute('SELECT * FROM menu_options WHERE group_id=? AND active=1 ORDER BY sort_order,id', (grp['id'],)).fetchall()
        gd['options'] = [dict(o) for o in opts]
        d['option_groups'].append(gd)
    return d

@app.get('/api/menu-items')
@login_required
def list_menu_items():
    conn = db()
    if g.tenant_id is None: return jsonify(items=[])
    branch_id = request.args.get('branch_id')
    q = 'SELECT * FROM menu_items WHERE tenant_id=? AND active=1'
    args = [g.tenant_id]
    if branch_id: q += ' AND branch_id=?'; args.append(branch_id)
    q += ' ORDER BY sort_order,id'
    rows = conn.execute(q, args).fetchall()
    return jsonify(items=[_menu_item_with_options(conn, r) for r in rows])

def _parse_stock_fields(d, old):
    """Validates cost_price/track_stock/stock_qty/low_stock_threshold from a menu-item
    payload. old=None on create (fields optional, sensible defaults); old=the existing
    menu_items row on edit (a field not sent keeps its current value)."""
    def _get(key, default):
        return d.get(key, old[key] if old is not None else default)
    try:
        cost_price = float(_get('cost_price', 0) or 0)
        if cost_price < 0: raise ValueError()
    except (TypeError, ValueError):
        raise ValueError('ต้นทุนไม่ถูกต้อง')
    track_stock = 1 if _get('track_stock', False) else 0
    if track_stock:
        stock_qty_raw = _get('stock_qty', 0)
        try:
            stock_qty = int(stock_qty_raw) if stock_qty_raw not in (None, '') else 0
            if stock_qty < 0: raise ValueError()
        except (TypeError, ValueError):
            raise ValueError('จำนวนสต็อกไม่ถูกต้อง')
    else:
        stock_qty = None
    try:
        low_stock_threshold = int(_get('low_stock_threshold', 5) or 0)
        if low_stock_threshold < 0: raise ValueError()
    except (TypeError, ValueError):
        raise ValueError('เกณฑ์แจ้งเตือนสต็อกไม่ถูกต้อง')
    return cost_price, track_stock, stock_qty, low_stock_threshold

@app.post('/api/menu-items')
@login_required
@role_required('owner', 'manager')
def add_menu_item():
    err = require_tenant()
    if err: return err
    d = request.get_json() or {}
    name = (d.get('name') or '').strip(); branch_id = d.get('branch_id')
    if not name or not branch_id: return jsonify(error='กรุณาใส่ชื่อเมนูและเลือกสาขา'), 400
    try:
        base_price = float(d.get('base_price') or 0)
    except (TypeError, ValueError):
        return jsonify(error='ราคาไม่ถูกต้อง'), 400
    if not _valid_image_data_uri(d.get('image_url')):
        return jsonify(error='รูปภาพไม่ถูกต้องหรือมีขนาดใหญ่เกินไป'), 400
    try:
        cost_price, track_stock, stock_qty, low_stock_threshold = _parse_stock_fields(d, None)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    conn = db()
    branch = conn.execute('SELECT id FROM branches WHERE id=? AND tenant_id=? AND active=1', (branch_id, g.tenant_id)).fetchone()
    if not branch: return jsonify(error='สาขาไม่ถูกต้องหรือไม่ได้อยู่ในร้านนี้'), 400
    category_id = d.get('category_id')
    if category_id not in (None, ''):
        category = conn.execute('SELECT id FROM menu_categories WHERE id=? AND tenant_id=? AND branch_id=? AND active=1', (category_id, g.tenant_id, branch_id)).fetchone()
        if not category: return jsonify(error='หมวดหมู่ไม่ถูกต้องหรือไม่ได้อยู่ในสาขานี้'), 400
    else:
        category_id = None
    station_id=d.get('kitchen_station_id')
    if station_id not in (None,''):
        station=conn.execute('SELECT id FROM kitchen_stations WHERE id=? AND tenant_id=? AND active=1 AND (branch_id IS NULL OR branch_id=?)',(station_id,g.tenant_id,branch_id)).fetchone()
        if not station:return jsonify(error='สถานีครัวไม่ถูกต้อง'),400
    else: station_id=None
    cur = conn.execute('''INSERT INTO menu_items(tenant_id,branch_id,category_id,name,description,base_price,image_url,sort_order,
        cost_price,track_stock,stock_qty,low_stock_threshold,kitchen_station_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (g.tenant_id, branch_id, category_id, name, d.get('description') or '', base_price,
         d.get('image_url'), d.get('sort_order') or 0, cost_price, track_stock, stock_qty, low_stock_threshold, station_id, now()))
    item_id = cur.lastrowid
    _save_option_groups(conn, item_id, d.get('option_groups') or [])
    log_action('add_menu_item', detail=name)
    conn.commit()
    return jsonify(ok=True, id=item_id)

def _save_option_groups(conn, item_id, groups):
    """Replace an item's option groups/options wholesale — simplest correct
    approach for a small admin form (a handful of groups/options per item)."""
    old_groups = conn.execute('SELECT id FROM menu_option_groups WHERE menu_item_id=?', (item_id,)).fetchall()
    for og in old_groups:
        conn.execute('DELETE FROM menu_options WHERE group_id=?', (og['id'],))
    conn.execute('DELETE FROM menu_option_groups WHERE menu_item_id=?', (item_id,))
    for gi, grp in enumerate(groups):
        gname = (grp.get('name') or '').strip()
        if not gname: continue
        selection_type = 'multiple' if grp.get('selection_type') == 'multiple' else 'single'
        try: min_select = max(0, int(grp.get('min_select', 1 if grp.get('required') else 0) or 0))
        except (TypeError, ValueError): min_select = 0
        try: max_select = max(1, int(grp.get('max_select', 1) or 1))
        except (TypeError, ValueError): max_select = 1
        if selection_type == 'single': max_select = 1; min_select = min(min_select, 1)
        if grp.get('required') and min_select < 1: min_select = 1
        if min_select > max_select: min_select = max_select
        cur = conn.execute('INSERT INTO menu_option_groups(menu_item_id,name,required,sort_order,selection_type,min_select,max_select) VALUES(?,?,?,?,?,?,?)',
            (item_id, gname, 1 if min_select > 0 else 0, gi, selection_type, min_select, max_select))
        gid = cur.lastrowid
        for oi, opt in enumerate(grp.get('options') or []):
            oname = (opt.get('name') or '').strip()
            if not oname: continue
            try:
                delta = float(opt.get('price_delta') or 0)
            except (TypeError, ValueError):
                delta = 0
            conn.execute('INSERT INTO menu_options(group_id,name,price_delta,sort_order) VALUES(?,?,?,?)',
                (gid, oname, delta, oi))

@app.put('/api/menu-items/<int:mid>')
@login_required
@role_required('owner', 'manager')
def edit_menu_item(mid):
    conn = db()
    old = conn.execute('SELECT * FROM menu_items WHERE id=? AND tenant_id=?', (mid, g.tenant_id)).fetchone()
    if not old: return jsonify(error='ไม่พบเมนู'), 404
    d = request.get_json() or {}
    try:
        base_price = float(d.get('base_price', old['base_price']))
    except (TypeError, ValueError):
        return jsonify(error='ราคาไม่ถูกต้อง'), 400
    if 'image_url' in d and not _valid_image_data_uri(d.get('image_url')):
        return jsonify(error='รูปภาพไม่ถูกต้องหรือมีขนาดใหญ่เกินไป'), 400
    try:
        cost_price, track_stock, stock_qty, low_stock_threshold = _parse_stock_fields(d, old)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    # switching stock tracking on with no stock sent yet keeps whatever count was
    # already there instead of silently resetting it to 0
    if track_stock and 'stock_qty' not in d and old['track_stock']:
        stock_qty = old['stock_qty']
    category_id = d.get('category_id', old['category_id'])
    if category_id not in (None, ''):
        category = conn.execute('SELECT id FROM menu_categories WHERE id=? AND tenant_id=? AND branch_id=? AND active=1', (category_id, g.tenant_id, old['branch_id'])).fetchone()
        if not category: return jsonify(error='หมวดหมู่ไม่ถูกต้องหรือไม่ได้อยู่ในสาขานี้'), 400
    else:
        category_id = None
    station_id=d.get('kitchen_station_id',old['kitchen_station_id'])
    if station_id not in (None,''):
        station=conn.execute('SELECT id FROM kitchen_stations WHERE id=? AND tenant_id=? AND active=1 AND (branch_id IS NULL OR branch_id=?)',(station_id,g.tenant_id,old['branch_id'])).fetchone()
        if not station:return jsonify(error='สถานีครัวไม่ถูกต้อง'),400
    else: station_id=None
    conn.execute('''UPDATE menu_items SET name=?,description=?,base_price=?,category_id=?,image_url=?,
        sold_out=?,sort_order=?,cost_price=?,track_stock=?,stock_qty=?,low_stock_threshold=?,kitchen_station_id=? WHERE id=?''',
        ((d.get('name') or old['name']).strip(), d.get('description', old['description']), base_price,
         category_id, d.get('image_url', old['image_url']),
         1 if d.get('sold_out') else 0, d.get('sort_order', old['sort_order']),
         cost_price, track_stock, stock_qty, low_stock_threshold, station_id, mid))
    if 'option_groups' in d:
        _save_option_groups(conn, mid, d.get('option_groups') or [])
    log_action('edit_menu_item', detail=str(mid))
    conn.commit()
    return jsonify(ok=True)

@app.put('/api/menu-items/<int:mid>/stock-adjust')
@login_required
@role_required('owner', 'manager', 'staff')
def adjust_menu_item_stock(mid):
    """Quick restock/adjust action from the menu grid — add or remove units
    without opening the full edit form. delta can be negative (e.g. correcting
    a miscount)."""
    conn = db()
    old = conn.execute('SELECT * FROM menu_items WHERE id=? AND tenant_id=?', (mid, g.tenant_id)).fetchone()
    if not old: return jsonify(error='ไม่พบเมนู'), 404
    if not old['track_stock']: return jsonify(error='เมนูนี้ไม่ได้เปิดใช้การนับสต็อก'), 400
    d = request.get_json() or {}
    try:
        delta = int(d.get('delta'))
    except (TypeError, ValueError):
        return jsonify(error='จำนวนไม่ถูกต้อง'), 400
    new_qty = max(0, (old['stock_qty'] or 0) + delta)
    conn.execute('UPDATE menu_items SET stock_qty=? WHERE id=?', (new_qty, mid))
    log_action('adjust_stock', detail=f'{mid}: {delta:+d} -> {new_qty}')
    conn.commit()
    return jsonify(ok=True, stock_qty=new_qty)

@app.put('/api/menu-items/<int:mid>/sold-out')
@login_required
@role_required('owner', 'manager', 'staff')
def toggle_sold_out(mid):
    """Lighter-weight endpoint for the common day-to-day action (mark an item
    sold out / back in stock) so staff don't need full menu-edit rights."""
    conn = db()
    old = conn.execute('SELECT * FROM menu_items WHERE id=? AND tenant_id=?', (mid, g.tenant_id)).fetchone()
    if not old: return jsonify(error='ไม่พบเมนู'), 404
    d = request.get_json() or {}
    conn.execute('UPDATE menu_items SET sold_out=? WHERE id=?', (1 if d.get('sold_out') else 0, mid))
    conn.commit()
    return jsonify(ok=True)

@app.delete('/api/menu-items/<int:mid>')
@login_required
@role_required('owner', 'manager')
def archive_menu_item(mid):
    conn = db()
    conn.execute('UPDATE menu_items SET active=0 WHERE id=? AND tenant_id=?', (mid, g.tenant_id))
    log_action('archive_menu_item', detail=str(mid))
    conn.commit()
    return jsonify(ok=True)

# =====================================================================
# Bootstrap (admin SPA hydration)
# =====================================================================

@app.get('/api/bootstrap')
@login_required
def bootstrap():
    conn = db()
    if g.tenant_id is None:
        return jsonify(branches=[], tables=[], categories=[], items=[])
    branches = [dict(x) for x in conn.execute('SELECT * FROM branches WHERE tenant_id=? AND active=1 ORDER BY id', (g.tenant_id,))]
    tables = [dict(x) for x in conn.execute('SELECT * FROM dining_tables WHERE tenant_id=? AND active=1 ORDER BY id', (g.tenant_id,))]
    categories = [dict(x) for x in conn.execute('SELECT * FROM menu_categories WHERE tenant_id=? AND active=1 ORDER BY sort_order,id', (g.tenant_id,))]
    items_rows = conn.execute('SELECT * FROM menu_items WHERE tenant_id=? AND active=1 ORDER BY sort_order,id', (g.tenant_id,)).fetchall()
    items = [_menu_item_with_options(conn, r) for r in items_rows]
    return jsonify(branches=branches, tables=tables, categories=categories, items=items)

# =====================================================================
# Orders — public (customer QR ordering, no login) + staff-side management
# =====================================================================

def _order_with_items(conn, order):
    d = dict(order)
    items = conn.execute('SELECT * FROM order_items WHERE order_id=? ORDER BY id', (order['id'],)).fetchall()
    d['items'] = []
    for it in items:
        item_d = dict(it)
        opts = conn.execute('SELECT * FROM order_item_options WHERE order_item_id=? ORDER BY id', (it['id'],)).fetchall()
        item_d['options'] = [dict(o) for o in opts]
        d['items'].append(item_d)
    # Receipt/report clients need the real active payment legs, especially for split payment.
    try:
        pays = conn.execute('SELECT id,amount,payment_method,cash_received,reference,paid_at FROM payments WHERE tenant_id=? AND order_id=? AND reversed_at IS NULL ORDER BY id',
                            (order['tenant_id'], order['id'])).fetchall()
        d['payments'] = [dict(x) for x in pays]
    except Exception:
        # Fresh/legacy bootstrap may call this before payment reversal columns exist.
        d['payments'] = []
    return d

def _validate_and_price_cart(conn, tenant_id, branch_id, cart):
    """Recompute prices server-side from the real menu — never trust client-sent
    totals. Returns (order_items_to_insert, total) or raises ValueError(msg)."""
    if not cart:
        raise ValueError('ตะกร้าว่างเปล่า กรุณาเลือกเมนูก่อนสั่ง')
    prepared = []
    total = Decimal('0.00')
    for line in cart:
        menu_item_id = line.get('menu_item_id')
        qty = line.get('quantity') or 1
        try:
            qty = int(qty)
        except (TypeError, ValueError):
            raise ValueError('จำนวนสินค้าไม่ถูกต้อง')
        if qty < 1 or qty > 50:
            raise ValueError('จำนวนสินค้าต่อรายการต้องอยู่ระหว่าง 1-50')
        item = conn.execute('SELECT * FROM menu_items WHERE id=? AND tenant_id=? AND branch_id=? AND active=1',
            (menu_item_id, tenant_id, branch_id)).fetchone()
        if not item:
            raise ValueError('พบเมนูที่ไม่ถูกต้องในตะกร้า กรุณาโหลดหน้าใหม่')
        if item['sold_out']:
            raise ValueError(f'"{item["name"]}" หมดแล้ว กรุณาเอาออกจากตะกร้า')
        unit_price = money_decimal(item['base_price'])
        chosen_options = []
        groups = conn.execute('SELECT * FROM menu_option_groups WHERE menu_item_id=?', (menu_item_id,)).fetchall()
        selected = line.get('selected_options') or {}  # {group_id: option_id | [option_ids]}
        for grp in groups:
            raw = selected.get(str(grp['id'])) if str(grp['id']) in selected else selected.get(grp['id'])
            opt_ids = raw if isinstance(raw, list) else ([] if raw in (None, '') else [raw])
            # Deduplicate IDs so a tampered client cannot charge/add the same modifier twice.
            opt_ids = list(dict.fromkeys(str(x) for x in opt_ids))
            selection_type = grp['selection_type'] if 'selection_type' in grp.keys() else 'single'
            min_select = int(grp['min_select'] if 'min_select' in grp.keys() else (1 if grp['required'] else 0))
            max_select = int(grp['max_select'] if 'max_select' in grp.keys() else 1)
            if selection_type == 'single': max_select = 1
            if len(opt_ids) < min_select:
                raise ValueError(f'กรุณาเลือก "{grp["name"]}" อย่างน้อย {min_select} รายการ สำหรับเมนู {item["name"]}')
            if len(opt_ids) > max_select:
                raise ValueError(f'เลือก "{grp["name"]}" ได้ไม่เกิน {max_select} รายการ')
            for opt_id in opt_ids:
                opt = conn.execute('SELECT * FROM menu_options WHERE id=? AND group_id=? AND active=1', (opt_id, grp['id'])).fetchone()
                if not opt:
                    raise ValueError('ตัวเลือกเมนูไม่ถูกต้องหรือปิดใช้งานแล้ว กรุณาโหลดหน้าใหม่')
                price_delta = money_decimal(opt['price_delta'])
                unit_price = money_decimal(unit_price + price_delta)
                chosen_options.append({'group_name': grp['name'], 'option_name': opt['name'], 'price_delta': money_float(price_delta)})
        line_total = money_decimal(unit_price * qty)
        total = money_decimal(total + line_total)
        prepared.append({
            'menu_item_id': menu_item_id, 'item_name': item['name'], 'quantity': qty,
            'unit_price': money_float(unit_price), 'line_total': money_float(line_total),
            'notes': (line.get('notes') or '').strip()[:300], 'options': chosen_options,
        })
    return prepared, money_float(total)


def _apply_recipe_inventory(conn, tenant_id, menu_item_id, qty, movement_type, order_id=None, user_id=None):
    """Apply recipe ingredient movement. Negative qty consumes; positive restores."""
    rows=conn.execute("""SELECT r.ingredient_id,r.quantity,i.branch_id
        FROM recipes r JOIN ingredients i ON i.id=r.ingredient_id
        WHERE r.tenant_id=? AND r.menu_item_id=? AND i.active=1""",(tenant_id,menu_item_id)).fetchall()
    ts=now()
    for r in rows:
        delta=float(r['quantity'] or 0)*float(qty)
        conn.execute('UPDATE ingredients SET stock_qty=stock_qty+?,updated_at=? WHERE id=? AND tenant_id=?',
                     (delta,ts,r['ingredient_id'],tenant_id))
        conn.execute("""INSERT INTO inventory_movements(tenant_id,branch_id,ingredient_id,movement_type,quantity,reason,order_id,created_by_user_id,created_at)
                        VALUES(?,?,?,?,?,?,?,?,?)""",
                     (tenant_id,r['branch_id'],r['ingredient_id'],movement_type,delta,
                      'อัตโนมัติจากออเดอร์' if order_id else 'ปรับสต็อก',order_id,user_id,ts))

def _decrement_stock(conn, tenant_id, menu_item_id, qty):
    """Deducts stock when an order is placed, for menu items that opted into
    stock tracking. Clamped at 0 rather than blocking the sale — an owner who
    wants a hard stop still has the existing sold_out toggle for that."""
    if not menu_item_id: return
    # CASE/WHEN instead of MAX(0, ...) — Postgres only has MAX() as an
    # aggregate, not a 2-argument scalar like SQLite does, so MAX(0, expr)
    # blew up in production with "function max(integer, integer) does not
    # exist" on every order containing a stock-tracked item. CASE/WHEN is
    # portable ANSI SQL that behaves identically on both.
    conn.execute('''UPDATE menu_items SET stock_qty =
        CASE WHEN COALESCE(stock_qty,0) - ? < 0 THEN 0 ELSE COALESCE(stock_qty,0) - ? END
        WHERE id=? AND track_stock=1''', (qty, qty, menu_item_id))
    _apply_recipe_inventory(conn, tenant_id, menu_item_id, -float(qty), 'sale', user_id=getattr(g,'user',{}).get('id') if getattr(g,'user',None) else None)

def _restore_stock(conn, tenant_id, menu_item_id, qty):
    if not menu_item_id or qty <= 0: return
    conn.execute('UPDATE menu_items SET stock_qty=COALESCE(stock_qty,0)+? WHERE id=? AND track_stock=1', (qty, menu_item_id))
    _apply_recipe_inventory(conn, tenant_id, menu_item_id, float(qty), 'restore', user_id=getattr(g,'user',{}).get('id') if getattr(g,'user',None) else None)

def _recalculate_order_total(conn, oid):
    row = conn.execute('SELECT COALESCE(SUM((quantity-COALESCE(cancelled_quantity,0))*unit_price),0) AS total FROM order_items WHERE order_id=?', (oid,)).fetchone()
    total = money_float(max(0, float(row['total'] or 0)))
    conn.execute('UPDATE orders SET total_amount=?,updated_at=? WHERE id=?', (total, now(), oid))
    return total

PHONE_RE_MIN, PHONE_RE_MAX = 8, 12  # digits, covers Lao/Thai mobile numbers

def _valid_phone(phone):
    digits = ''.join(ch for ch in (phone or '') if ch.isdigit())
    return PHONE_RE_MIN <= len(digits) <= PHONE_RE_MAX

@app.get('/api/public/menu')
def public_menu():
    """Customer-facing menu. table=<qr_token> auto-resolves the table (and its
    branch/tenant); otherwise branch_id must be given directly (takeaway/delivery
    QR that isn't tied to one physical table)."""
    conn = db()
    table_token = request.args.get('table')
    branch_id = request.args.get('branch_id')
    table = None
    if table_token:
        table = conn.execute('SELECT * FROM dining_tables WHERE qr_token=? AND active=1', (table_token,)).fetchone()
        if not table:
            return jsonify(error='ไม่พบโต๊ะนี้ QR อาจไม่ถูกต้องหรือถูกปิดใช้งาน'), 404
        branch_id = table['branch_id']
        tenant_id = table['tenant_id']
    elif branch_id:
        branch = conn.execute('SELECT * FROM branches WHERE id=? AND active=1', (branch_id,)).fetchone()
        if not branch:
            return jsonify(error='ไม่พบสาขานี้'), 404
        tenant_id = branch['tenant_id']
    else:
        return jsonify(error='ไม่พบข้อมูลร้าน กรุณาสแกน QR ใหม่อีกครั้ง'), 400
    tenant = conn.execute('SELECT * FROM tenants WHERE id=? AND active=1', (tenant_id,)).fetchone()
    if not tenant or not tenant_active(conn, tenant_id):
        return jsonify(error='ร้านนี้ปิดให้บริการชั่วคราว'), 404
    categories = [dict(x) for x in conn.execute('SELECT * FROM menu_categories WHERE tenant_id=? AND branch_id=? AND active=1 ORDER BY sort_order,id', (tenant_id, branch_id))]
    items_rows = conn.execute('SELECT * FROM menu_items WHERE tenant_id=? AND branch_id=? AND active=1 ORDER BY sort_order,id', (tenant_id, branch_id)).fetchall()
    items = [_menu_item_with_options(conn, r) for r in items_rows]
    return jsonify(
        tenant=dict(name=tenant['name'], icon=tenant['icon'], currency=tenant['currency']),
        branch_id=branch_id,
        table=dict(id=table['id'], name=table['name']) if table else None,
        categories=categories, items=items,
    )

@app.get('/api/public/tables')
def public_tables():
    """Used only by the generic-QR (no table auto-detected) fallback flow, so the
    customer can explicitly pick their table before confirming — never exposes
    QR tokens, just id+name for the picker."""
    conn = db()
    branch_id = request.args.get('branch_id')
    if not branch_id:
        return jsonify(error='ไม่พบข้อมูลสาขา'), 400
    branch = conn.execute('SELECT tenant_id FROM branches WHERE id=? AND active=1', (branch_id,)).fetchone()
    if not branch:
        return jsonify(error='ไม่พบสาขานี้'), 404
    if not tenant_active(conn, branch['tenant_id']):
        return jsonify(error='ร้านนี้ปิดให้บริการชั่วคราว'), 404
    rows = conn.execute('SELECT id,name FROM dining_tables WHERE tenant_id=? AND branch_id=? AND active=1 ORDER BY id', (branch['tenant_id'], branch_id)).fetchall()
    return jsonify(tables=[dict(x) for x in rows])

def _fulfillment_fields(d, order_type, public=False):
    scheduled=(d.get('scheduled_for') or '').strip()[:40] or None
    # ISO-like datetime-local value; deliberately keep timezone interpretation at the branch/UI layer.
    if scheduled and ('T' not in scheduled or len(scheduled) < 16):
        raise ValueError('วันเวลารับ/จัดส่งล่วงหน้าไม่ถูกต้อง')
    try:
        fee=float(d.get('delivery_fee') or 0) if (order_type=='delivery' and not public) else 0.0
    except (TypeError,ValueError):
        raise ValueError('ค่าจัดส่งไม่ถูกต้อง')
    if fee < 0 or fee > 100000000: raise ValueError('ค่าจัดส่งไม่ถูกต้อง')
    return scheduled, fee

@app.post('/api/public/orders')
def public_create_order():
    d = request.get_json() or {}
    conn = db()
    branch_id = d.get('branch_id')
    order_type = d.get('order_type') or 'dine_in'
    if order_type not in ('dine_in', 'takeaway', 'delivery'):
        return jsonify(error='ประเภทออเดอร์ไม่ถูกต้อง'), 400
    branch = conn.execute('SELECT * FROM branches WHERE id=? AND active=1', (branch_id,)).fetchone()
    if not branch:
        return jsonify(error='ไม่พบสาขา กรุณาสแกน QR ใหม่'), 400
    tenant_id = branch['tenant_id']
    if not tenant_active(conn, tenant_id):
        return jsonify(error='ร้านนี้ปิดให้บริการชั่วคราว'), 404

    table_id = None
    table_name = None
    table_token = d.get('table_token')
    if table_token:
        table = conn.execute('SELECT * FROM dining_tables WHERE qr_token=? AND branch_id=? AND active=1', (table_token, branch_id)).fetchone()
        if not table:
            return jsonify(error='ไม่พบโต๊ะนี้'), 400
        table_id, table_name = table['id'], table['name']
    elif order_type == 'dine_in':
        # No table QR was scanned (generic QR / walk-in) — the customer MUST
        # pick their table explicitly before the order can be confirmed.
        table_id_raw = d.get('table_id')
        if not table_id_raw:
            return jsonify(error='กรุณาเลือกโต๊ะก่อนยืนยันออเดอร์'), 400
        table = conn.execute('SELECT * FROM dining_tables WHERE id=? AND branch_id=? AND active=1', (table_id_raw, branch_id)).fetchone()
        if not table:
            return jsonify(error='โต๊ะที่เลือกไม่ถูกต้อง'), 400
        table_id, table_name = table['id'], table['name']

    # name is a courtesy field, not required — same as the staff-side take-order
    # flow, which has always defaulted to 'ลูกค้า' when left blank
    customer_name = (d.get('customer_name') or '').strip()[:100] or 'ลูกค้า'
    customer_phone = (d.get('customer_phone') or '').strip()
    customer_phone_confirm = (d.get('customer_phone_confirm') or '').strip()
    customer_address = (d.get('customer_address') or '').strip()[:500] if order_type == 'delivery' else None

    if order_type == 'delivery':
        if not _valid_phone(customer_phone):
            return jsonify(error='เบอร์โทรไม่ถูกต้อง กรุณากรอกเบอร์ให้ครบถ้วน'), 400
        if customer_phone != customer_phone_confirm:
            return jsonify(error='เบอร์โทรทั้งสองช่องไม่ตรงกัน กรุณาตรวจสอบอีกครั้ง'), 400
        if not customer_address:
            return jsonify(error='กรุณากรอกที่อยู่จัดส่ง'), 400
    elif customer_phone and not _valid_phone(customer_phone):
        return jsonify(error='เบอร์โทรไม่ถูกต้อง'), 400

    try:
        scheduled_for, delivery_fee = _fulfillment_fields(d, order_type, public=True)
        prepared_items, total = _validate_and_price_cart(conn, tenant_id, branch_id, d.get('cart') or [])
    except ValueError as e:
        return jsonify(error=str(e)), 400

    try:
        order_no, cur = insert_order_row(conn, tenant_id,
            '''INSERT INTO orders(tenant_id,branch_id,order_no,order_type,table_id,table_name_snapshot,
            customer_name,customer_phone,customer_address,total_amount,scheduled_for,delivery_fee,notes,placed_by,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            lambda order_no: (tenant_id, branch_id, order_no, order_type, table_id, table_name, customer_name, customer_phone,
             customer_address, total, scheduled_for, delivery_fee, (d.get('notes') or '').strip()[:500], 'customer', now(), now()))
        order_id = cur.lastrowid
        if not order_id:
            raise RuntimeError('public order insert did not return an id')
        for it in prepared_items:
            oi_cur = conn.execute('''INSERT INTO order_items(order_id,menu_item_id,item_name_snapshot,quantity,unit_price,line_total,notes,kitchen_sent_at)
                VALUES(?,?,?,?,?,?,?,?)''', (order_id, it['menu_item_id'], it['item_name'], it['quantity'], it['unit_price'], it['line_total'], it['notes'], None))
            oi_id = oi_cur.lastrowid
            if not oi_id:
                raise RuntimeError('public order item insert did not return an id')
            for opt in it['options']:
                conn.execute('INSERT INTO order_item_options(order_item_id,group_name_snapshot,option_name_snapshot,price_delta_snapshot) VALUES(?,?,?,?)',
                    (oi_id, opt['group_name'], opt['option_name'], opt['price_delta']))
            _decrement_stock(conn, tenant_id, it['menu_item_id'], it['quantity'])
        conn.commit()
        return jsonify(ok=True, order_no=order_no, order_id=order_id, total_amount=total)
    except Exception:
        conn.rollback()
        app.logger.exception('public_create_order failed')
        return jsonify(error='บันทึกออเดอร์ไม่สำเร็จ กรุณาลองอีกครั้ง หากยังเกิดปัญหาให้แจ้งพนักงาน'), 500

@app.post('/api/public/orders/track')
def public_track_order():
    d = request.get_json(silent=True) or {}
    order_no = (d.get('order_no') or '').strip()
    phone = (d.get('phone') or '').strip()
    if not order_no or not phone:
        return jsonify(error='กรุณากรอกเลขที่ออเดอร์และเบอร์โทร'), 400
    conn = db()
    matches = conn.execute(
        'SELECT * FROM orders WHERE order_no=? AND customer_phone=? ORDER BY id DESC LIMIT 2',
        (order_no, phone)
    ).fetchall()
    if not matches:
        return jsonify(error='ไม่พบออเดอร์ กรุณาตรวจสอบเลขที่ออเดอร์และเบอร์โทรอีกครั้ง'), 404
    if len(matches) > 1:
        # Same order number is valid in different tenants. Never guess and leak
        # another shop's order data through the public tracker.
        return jsonify(error='พบเลขออเดอร์ซ้ำในหลายร้าน กรุณาเปิดหน้าติดตามจากลิงก์ของร้านที่สั่ง'), 409
    if not tenant_active(conn, matches[0]['tenant_id']):
        return jsonify(error='ร้านนี้ปิดให้บริการชั่วคราว'), 404
    return jsonify(order=_order_with_items(conn, matches[0]))

# ---------- staff-side order management ----------

@app.get('/api/orders')
@login_required
def list_orders():
    conn = db()
    if g.tenant_id is None: return jsonify(orders=[])
    status = request.args.get('status')
    branch_id = request.args.get('branch_id')
    if branch_id not in (None, ''):
        try: branch_id = int(branch_id)
        except (TypeError, ValueError): return jsonify(error='branch_id ไม่ถูกต้อง'), 400
    q = '''SELECT orders.*, u.display_name AS created_by_name
           FROM orders LEFT JOIN users u ON u.id = orders.created_by_user_id
           WHERE orders.tenant_id=?'''
    args = [g.tenant_id]
    if status: q += ' AND orders.status=?'; args.append(status)
    if branch_id: q += ' AND orders.branch_id=?'; args.append(branch_id)
    q += ' ORDER BY orders.id DESC LIMIT 200'
    rows = conn.execute(q, args).fetchall()
    return jsonify(orders=[_order_with_items(conn, r) for r in rows])

@app.get('/api/kitchen/orders')
@login_required
@role_required('owner', 'manager', 'staff')
def kitchen_orders():
    """Kitchen-only queue. Only orders with at least one item that has actually
    been sent to the kitchen are returned. This keeps draft/unsent items off KDS."""
    conn = db()
    if g.tenant_id is None: return jsonify(orders=[])
    branch_id = request.args.get('branch_id')
    station_id = request.args.get('station_id')
    q = '''SELECT DISTINCT o.* FROM orders o
           JOIN order_items oi ON oi.order_id=o.id
           LEFT JOIN menu_items mi ON mi.id=oi.menu_item_id AND mi.tenant_id=o.tenant_id
           WHERE o.tenant_id=? AND o.status IN ('received','preparing','ready')
             AND oi.kitchen_sent_at IS NOT NULL'''
    args=[g.tenant_id]
    if branch_id:
        q += ' AND o.branch_id=?'; args.append(branch_id)
    if station_id:
        q += ' AND mi.kitchen_station_id=?'; args.append(station_id)
    q += ' ORDER BY o.id ASC LIMIT 200'
    rows=conn.execute(q,args).fetchall()
    orders=[]
    for r in rows:
        od=_order_with_items(conn,r)
        if station_id:
            filtered=[]
            for it in od['items']:
                mi=conn.execute('SELECT kitchen_station_id FROM menu_items WHERE id=? AND tenant_id=?',(it['menu_item_id'],g.tenant_id)).fetchone()
                if mi and str(mi['kitchen_station_id'])==str(station_id): filtered.append(it)
            od['items']=filtered
        orders.append(od)
    return jsonify(orders=orders)

@app.post('/api/orders')
@login_required
@role_required('owner', 'manager', 'staff')
def staff_create_order():
    """Staff places an order on the customer's behalf (walk-in / assisted order)."""
    err = require_tenant()
    if err: return err
    d = request.get_json() or {}
    branch_id = d.get('branch_id')
    order_type = d.get('order_type') or 'dine_in'
    if order_type not in ('dine_in', 'takeaway', 'delivery'):
        return jsonify(error='ประเภทออเดอร์ไม่ถูกต้อง'), 400
    conn = db()
    # Round 22.1 — initialize offline/idempotency metadata before order INSERT.
    client_request_id = (d.get('client_request_id') or '').strip()[:100] or None
    client_device_id = (d.get('client_device_id') or '').strip()[:100] or None
    offline_created_at = (d.get('offline_created_at') or '').strip()[:80] or None

    # Safe retry: return the same server order before stock/order mutation.
    if client_request_id:
        existing = conn.execute(
            'SELECT id,order_no,total_amount FROM orders WHERE tenant_id=? AND client_request_id=?',
            (g.tenant_id, client_request_id)
        ).fetchone()
        if existing:
            return jsonify(ok=True, idempotent=True, order_id=existing['id'],
                           order_no=existing['order_no'], total_amount=existing['total_amount'])

    branch = conn.execute('SELECT 1 FROM branches WHERE id=? AND tenant_id=?', (branch_id, g.tenant_id)).fetchone()
    if not branch: return jsonify(error='ไม่พบสาขา'), 400

    table_id, table_name = None, None
    if order_type == 'dine_in':
        table_id_raw = d.get('table_id')
        if not table_id_raw:
            return jsonify(error='กรุณาเลือกโต๊ะก่อนยืนยันออเดอร์'), 400
        table = conn.execute('SELECT * FROM dining_tables WHERE id=? AND tenant_id=? AND branch_id=?', (table_id_raw, g.tenant_id, branch_id)).fetchone()
        if not table: return jsonify(error='โต๊ะที่เลือกไม่ถูกต้อง'), 400
        table_id, table_name = table['id'], table['name']

    customer_name = (d.get('customer_name') or 'ลูกค้า').strip()[:100]
    customer_phone = (d.get('customer_phone') or '').strip()
    customer_address = (d.get('customer_address') or '').strip()[:500] if order_type == 'delivery' else None
    if order_type == 'delivery' and not _valid_phone(customer_phone):
        return jsonify(error='เบอร์โทรไม่ถูกต้อง'), 400

    guest_count = d.get('guest_count')
    if guest_count not in (None, ''):
        try:
            guest_count = int(guest_count)
            if guest_count < 1 or guest_count > 200: raise ValueError()
        except (TypeError, ValueError):
            return jsonify(error='จำนวนลูกค้าไม่ถูกต้อง'), 400
    else:
        guest_count = None

    try:
        scheduled_for, delivery_fee = _fulfillment_fields(d, order_type, public=False)
        prepared_items, total = _validate_and_price_cart(conn, g.tenant_id, branch_id, d.get('cart') or [])
    except ValueError as e:
        return jsonify(error=str(e)), 400

    try:
        order_no, cur = insert_order_row(conn, g.tenant_id,
            '''INSERT INTO orders(tenant_id,branch_id,order_no,order_type,table_id,table_name_snapshot,
            customer_name,customer_phone,customer_address,total_amount,guest_count,scheduled_for,delivery_fee,notes,placed_by,created_by_user_id,created_at,updated_at,
            client_request_id,client_device_id,offline_created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            lambda order_no: (g.tenant_id, branch_id, order_no, order_type, table_id, table_name, customer_name, customer_phone,
             customer_address, total, guest_count, scheduled_for, delivery_fee, (d.get('notes') or '').strip()[:500], 'staff', g.user['id'], now(), now(),
             client_request_id, client_device_id, offline_created_at))
        order_id = cur.lastrowid
        if not order_id:
            raise RuntimeError('order insert did not return an id')
        for it in prepared_items:
            oi_cur = conn.execute('''INSERT INTO order_items(order_id,menu_item_id,item_name_snapshot,quantity,unit_price,line_total,notes,kitchen_sent_at)
                VALUES(?,?,?,?,?,?,?,?)''', (order_id, it['menu_item_id'], it['item_name'], it['quantity'], it['unit_price'], it['line_total'], it['notes'], None))
            oi_id = oi_cur.lastrowid
            if not oi_id:
                raise RuntimeError('order item insert did not return an id')
            for opt in it['options']:
                conn.execute('INSERT INTO order_item_options(order_item_id,group_name_snapshot,option_name_snapshot,price_delta_snapshot) VALUES(?,?,?,?)',
                    (oi_id, opt['group_name'], opt['option_name'], opt['price_delta']))
            _decrement_stock(conn, g.tenant_id, it['menu_item_id'], it['quantity'])
        log_action('staff_create_order', detail=order_no)
        conn.commit()
        return jsonify(ok=True, order_no=order_no, order_id=order_id, total_amount=total)
    except INTEGRITY_ERRORS:
        conn.rollback()
        if client_request_id:
            existing = conn.execute('SELECT id,order_no,total_amount FROM orders WHERE tenant_id=? AND client_request_id=?',
                                    (g.tenant_id, client_request_id)).fetchone()
            if existing:
                return jsonify(ok=True, idempotent=True, order_id=existing['id'], order_no=existing['order_no'],
                               total_amount=existing['total_amount'])
        app.logger.exception('staff_create_order integrity failure')
        return jsonify(error='บันทึกออเดอร์ไม่สำเร็จ กรุณาลองอีกครั้ง'), 409
    except Exception:
        conn.rollback()
        app.logger.exception('staff_create_order failed')
        return jsonify(error='บันทึกออเดอร์ไม่สำเร็จ กรุณาลองอีกครั้ง'), 500

@app.put('/api/orders/<int:oid>/status')
@login_required
@role_required('owner', 'manager', 'staff')
def update_order_status(oid):
    conn = db()
    order = conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?', (oid, g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'), 404
    d = request.get_json() or {}
    status = d.get('status')
    if status not in ORDER_STATUSES:
        return jsonify(error='สถานะไม่ถูกต้อง'), 400
    current = order['status']
    if status == current: return jsonify(ok=True)
    if status not in STATUS_TRANSITIONS.get(current, set()):
        return jsonify(error=f'ไม่สามารถเปลี่ยนสถานะจาก {current} เป็น {status} ได้'), 409
    if status == 'cancelled':
        reason=(d.get('reason') or '').strip()[:300]
        if len(reason)<2: return jsonify(error='กรุณาระบุเหตุผลการยกเลิกออเดอร์'),400
        approved_by, approval_err = _critical_approval(conn,d)
        if approval_err: return approval_err
        rows = conn.execute('SELECT * FROM order_items WHERE order_id=?', (oid,)).fetchall()
        for it in rows:
            remaining = max(0, int(it['quantity']) - int(it['cancelled_quantity'] or 0))
            _restore_stock(conn, g.tenant_id, it['menu_item_id'], remaining)
            conn.execute('UPDATE order_items SET cancelled_quantity=quantity,cancelled_at=COALESCE(cancelled_at,?) WHERE id=?', (now(), it['id']))
    conn.execute('UPDATE orders SET status=?,updated_at=? WHERE id=?', (status, now(), oid))
    if status == 'cancelled': _record_critical(conn,'cancel_order',order['branch_id'],'order',oid,reason,approved_by,f'{current} -> cancelled')
    log_action('update_order_status', detail=f'{oid}: {current} -> {status}')
    conn.commit()
    return jsonify(ok=True)

@app.put('/api/orders/<int:oid>/send-to-kitchen')
@login_required
@role_required('owner', 'manager', 'staff')
def send_order_items_to_kitchen(oid):
    """Flags the selected order_items as (re-)sent to the kitchen. Does not
    change order/payment status — this is purely a notify/highlight action for
    the kitchen display board, independent of payment and pricing."""
    conn = db()
    order = conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?', (oid, g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'), 404
    d = request.get_json() or {}
    item_ids = d.get('item_ids') or []
    if not isinstance(item_ids, list) or not item_ids:
        return jsonify(error='กรุณาเลือกรายการอาหารอย่างน้อย 1 รายการ'), 400
    try:
        item_ids = [int(x) for x in item_ids]
    except (TypeError, ValueError):
        return jsonify(error='รายการอาหารไม่ถูกต้อง'), 400
    rows = conn.execute('SELECT id,quantity,cancelled_quantity,kitchen_sent_at FROM order_items WHERE order_id=?', (oid,)).fetchall()
    by_id = {r['id']: r for r in rows}
    item_ids = [i for i in item_ids if i in by_id and int(by_id[i]['quantity']) > int(by_id[i]['cancelled_quantity'] or 0)]
    if not item_ids:
        return jsonify(error='รายการอาหารไม่ถูกต้องหรือถูกยกเลิกแล้ว'), 400
    resend = bool(d.get('resend'))
    if not resend:
        item_ids = [i for i in item_ids if not by_id[i]['kitchen_sent_at']]
        if not item_ids:
            return jsonify(error='รายการที่เลือกส่งเข้าครัวแล้ว'), 409
    ts = now()
    for iid in item_ids:
        conn.execute('UPDATE order_items SET kitchen_sent_at=? WHERE id=?', (ts, iid))
    # Server-side kitchen print queue: create one job per station touched by this send.
    placeholders=','.join('?' for _ in item_ids)
    station_rows=conn.execute(f'''SELECT DISTINCT mi.kitchen_station_id AS station_id
        FROM order_items oi LEFT JOIN menu_items mi ON mi.id=oi.menu_item_id AND mi.tenant_id=?
        WHERE oi.order_id=? AND oi.id IN ({placeholders})''', [g.tenant_id,oid,*item_ids]).fetchall()
    station_ids=[r['station_id'] for r in station_rows] or [None]
    for station_id in station_ids:
        conn.execute('''INSERT INTO kitchen_print_jobs(tenant_id,branch_id,order_id,station_id,status,attempts,last_error,created_at)
                        VALUES(?,?,?,?,?,?,?,?)''',
                     (g.tenant_id,order['branch_id'],oid,station_id,'pending',0,'',ts))
    log_action('send_order_items_to_kitchen', detail=f'{oid}: {item_ids}')
    conn.commit()
    return jsonify(ok=True, sent_at=ts, item_ids=item_ids)

# ---------- Round 14D: pricing / promotions / service charge / tax ----------
def _pricing_settings(conn, branch_id):
    row=conn.execute('SELECT * FROM pricing_settings WHERE tenant_id=? AND branch_id=?',(g.tenant_id,branch_id)).fetchone()
    return dict(row) if row else {'tax_rate':0,'service_charge_rate':0}

def _active_promotion(conn, code, branch_id, subtotal):
    code=(code or '').strip().upper()
    if not code: return None
    promo=conn.execute('SELECT * FROM promotions WHERE tenant_id=? AND UPPER(code)=? AND active=1 AND (branch_id IS NULL OR branch_id=?) LIMIT 1',(g.tenant_id,code,branch_id)).fetchone()
    if not promo: raise ValueError('ไม่พบโปรโมชั่นหรือโปรโมชั่นไม่เปิดใช้งาน')
    ts=now()
    if promo['starts_at'] and ts < promo['starts_at']: raise ValueError('โปรโมชั่นนี้ยังไม่เริ่ม')
    if promo['ends_at'] and ts > promo['ends_at']: raise ValueError('โปรโมชั่นนี้หมดอายุแล้ว')
    if subtotal < float(promo['min_spend'] or 0): raise ValueError('ยอดสั่งซื้อยังไม่ถึงขั้นต่ำของโปรโมชั่น')
    return promo

@app.get('/api/pricing/settings')
@login_required
@role_required('owner','manager','staff')
def get_pricing_settings():
    bid=request.args.get('branch_id',type=int) or getattr(g,'branch_id',None)
    conn=db(); br=conn.execute('SELECT id FROM branches WHERE id=? AND tenant_id=?',(bid,g.tenant_id)).fetchone()
    if not br: return jsonify(error='ไม่พบสาขา'),404
    return jsonify(_pricing_settings(conn,bid))

@app.put('/api/pricing/settings')
@login_required
@role_required('owner','manager')
def put_pricing_settings():
    d=request.get_json() or {}; bid=int(d.get('branch_id') or getattr(g,'branch_id',None) or 0)
    try: tax=float(d.get('tax_rate') or 0); svc=float(d.get('service_charge_rate') or 0)
    except (TypeError,ValueError): return jsonify(error='อัตราไม่ถูกต้อง'),400
    if not (0<=tax<=100 and 0<=svc<=100): return jsonify(error='อัตราต้องอยู่ระหว่าง 0–100%'),400
    conn=db(); br=conn.execute('SELECT id FROM branches WHERE id=? AND tenant_id=?',(bid,g.tenant_id)).fetchone()
    if not br: return jsonify(error='ไม่พบสาขา'),404
    ts=now(); old=conn.execute('SELECT id FROM pricing_settings WHERE tenant_id=? AND branch_id=?',(g.tenant_id,bid)).fetchone()
    if old: conn.execute('UPDATE pricing_settings SET tax_rate=?,service_charge_rate=?,updated_by_user_id=?,updated_at=? WHERE id=?',(tax,svc,g.user['id'],ts,old['id']))
    else: conn.execute('INSERT INTO pricing_settings(tenant_id,branch_id,tax_rate,service_charge_rate,updated_by_user_id,updated_at) VALUES(?,?,?,?,?,?)',(g.tenant_id,bid,tax,svc,g.user['id'],ts))
    log_action('pricing_settings_updated',detail=f'branch={bid} tax={tax} service={svc}'); conn.commit(); return jsonify(ok=True)

@app.get('/api/promotions')
@login_required
@role_required('owner','manager')
def list_promotions():
    conn=db(); return jsonify([dict(x) for x in conn.execute('SELECT * FROM promotions WHERE tenant_id=? ORDER BY active DESC,id DESC',(g.tenant_id,)).fetchall()])

@app.post('/api/promotions')
@login_required
@role_required('owner','manager')
def create_promotion():
    d=request.get_json() or {}; code=(d.get('code') or '').strip().upper()[:40]; name=(d.get('name') or '').strip()[:120]; typ=(d.get('discount_type') or 'percent').strip()
    if not code or not name or typ not in ('percent','fixed'): return jsonify(error='ข้อมูลโปรโมชั่นไม่ถูกต้อง'),400
    try:
        value=float(d.get('discount_value') or 0); minimum=float(d.get('min_spend') or 0); maxd=d.get('max_discount'); maxd=float(maxd) if maxd not in (None,'') else None
    except (TypeError,ValueError): return jsonify(error='จำนวนเงิน/ส่วนลดไม่ถูกต้อง'),400
    if value<=0 or minimum<0 or (typ=='percent' and value>100) or (maxd is not None and maxd<0): return jsonify(error='ค่าของโปรโมชั่นไม่ถูกต้อง'),400
    bid=d.get('branch_id'); bid=int(bid) if bid not in (None,'') else None; conn=db()
    if bid and not conn.execute('SELECT id FROM branches WHERE id=? AND tenant_id=?',(bid,g.tenant_id)).fetchone(): return jsonify(error='ไม่พบสาขา'),404
    try:
        cur=conn.execute('INSERT INTO promotions(tenant_id,branch_id,code,name,discount_type,discount_value,min_spend,max_discount,starts_at,ends_at,active,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(g.tenant_id,bid,code,name,typ,value,minimum,maxd,d.get('starts_at') or None,d.get('ends_at') or None,1,g.user['id'],now()))
        conn.commit(); return jsonify(ok=True,id=cur.lastrowid)
    except INTEGRITY_ERRORS:
        conn.rollback(); return jsonify(error='รหัสโปรโมชั่นนี้มีอยู่แล้ว'),409

@app.delete('/api/promotions/<int:pid>')
@login_required
@role_required('owner','manager')
def disable_promotion(pid):
    conn=db(); row=conn.execute('SELECT id FROM promotions WHERE id=? AND tenant_id=?',(pid,g.tenant_id)).fetchone()
    if not row: return jsonify(error='ไม่พบโปรโมชั่น'),404
    conn.execute('UPDATE promotions SET active=0 WHERE id=? AND tenant_id=?',(pid,g.tenant_id)); conn.commit(); return jsonify(ok=True)

@app.put('/api/orders/<int:oid>/fulfillment')
@login_required
@role_required('owner','manager','staff')
def update_order_fulfillment(oid):
    conn=db(); order=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?',(oid,g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'),404
    d=request.get_json() or {}
    allowed={'pending','confirmed','ready','out_for_delivery','delivered','picked_up','cancelled'}
    status=(d.get('fulfillment_status') or '').strip()
    if status not in allowed: return jsonify(error='สถานะรับ/จัดส่งไม่ถูกต้อง'),400
    if order['order_type']=='dine_in': return jsonify(error='ออเดอร์ทานที่ร้านไม่ใช้สถานะจัดส่ง'),409
    if status=='out_for_delivery' and order['order_type']!='delivery': return jsonify(error='สถานะกำลังจัดส่งใช้ได้เฉพาะเดลิเวอรี่'),400
    driver_name=(d.get('driver_name') or order['driver_name'] or '').strip()[:100]
    driver_phone=(d.get('driver_phone') or order['driver_phone'] or '').strip()[:50]
    note=(d.get('delivery_note') or order['delivery_note'] or '').strip()[:300]
    delivery_status=status if order['order_type']=='delivery' else order['delivery_status']
    conn.execute('UPDATE orders SET fulfillment_status=?,delivery_status=?,driver_name=?,driver_phone=?,delivery_note=?,updated_at=? WHERE id=? AND tenant_id=?',
                 (status,delivery_status,driver_name,driver_phone,note,now(),oid,g.tenant_id))
    log_action('update_fulfillment',detail=f'{oid}: {status}')
    conn.commit(); return jsonify(ok=True,status=status)

@app.put('/api/orders/<int:oid>/payment')
@login_required
@role_required('owner','manager','staff')
def update_order_payment(oid):
    """Payment 2.0: one atomic checkout may contain one or many payment methods."""
    conn=db(); order=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?',(oid,g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'),404
    d=request.get_json() or {}
    if d.get('payment_status')!='paid': return jsonify(error='ใช้ขั้นตอนคืนเงิน/เปิดบิลกลับสำหรับการย้อนการชำระ'),400
    if order['status']=='cancelled' or order['payment_status']=='paid': return jsonify(error='บิลนี้ไม่สามารถชำระซ้ำได้'),409
    def money(v, default=0):
        x=money_decimal(default if v in (None,'') else v)
        if x < 0 or x > Decimal('1000000000'): raise ValueError('จำนวนเงินไม่ถูกต้อง')
        return x
    try:
        subtotal=money_decimal(order['total_amount']); delivery=money_decimal(order['delivery_fee'])
        settings=_pricing_settings(conn,order['branch_id']); discount=Decimal('0.00'); label=''; promotion_id=None
        code=(d.get('promotion_code') or '').strip()
        if code:
            promo=_active_promotion(conn,code,order['branch_id'],subtotal); promotion_id=promo['id']; label=promo['name']
            discount=(subtotal*money_decimal(promo['discount_value'])/Decimal('100')) if promo['discount_type']=='percent' else money_decimal(promo['discount_value'])
            if promo['max_discount'] is not None: discount=min(discount,money_decimal(promo['max_discount']))
        manual=money(d.get('discount_amount'),0)
        if manual>0:
            approved_by,err=_critical_approval(conn,d)
            if err:return err
            discount+=manual; label=(d.get('discount_reason') or 'ส่วนลดพิเศษ')[:120]
            _record_critical(conn,'discount',order['branch_id'],'order',oid,label,approved_by,f'manual_discount={manual}')
        discount=min(money_decimal(discount),subtotal); base=max(Decimal('0.00'),subtotal-discount)
        service=money_decimal(base*Decimal(str(settings.get('service_charge_rate') or 0))/Decimal('100'))
        tax=money_decimal((base+service)*Decimal(str(settings.get('tax_rate') or 0))/Decimal('100'))
        due=money_decimal(base+service+tax+delivery)
        parts=d.get('payments')
        if not parts:
            parts=[{'method':d.get('payment_method'),'amount':due,'cash_received':d.get('cash_received'),'reference':d.get('reference')}]
        if not isinstance(parts,list) or not parts: raise ValueError('กรุณาระบุการชำระเงิน')
        normalized=[]; total=Decimal('0.00'); cash_received_total=Decimal('0.00')
        # If the first part omits amount, it means "remaining balance".
        explicit_total=money_sum(money(p.get('amount')) for p in parts[1:]) if len(parts)>1 else Decimal('0.00')
        for idx,p in enumerate(parts):
            method=(p.get('method') or '').strip()
            if method not in PAYMENT_METHODS: raise ValueError('วิธีชำระเงินไม่ถูกต้อง')
            raw=p.get('amount')
            amount=money_decimal(max(Decimal('0.00'),due-explicit_total)) if idx==0 and len(parts)>1 and raw in (None,'',0,0.0) else money(raw)
            if amount<=0: raise ValueError('ยอดแต่ละช่องทางต้องมากกว่า 0')
            cr=money(p.get('cash_received'),amount) if method=='cash' else None
            if method=='cash' and cr<amount: raise ValueError('เงินสดที่รับมาต้องไม่น้อยกว่ายอดเงินสด')
            normalized.append((method,amount,cr,(p.get('reference') or '')[:120]))
            total=money_decimal(total+amount)
            if cr: cash_received_total+=cr
        if total != due: raise ValueError(f'ยอดชำระรวมต้องเท่ากับ {due:.2f}')
    except (ValueError,TypeError) as e:return jsonify(error=str(e)),400
    ts=now()
    claimed=conn.execute("""UPDATE orders SET payment_status='paid',payment_method=?,tax_amount=?,service_charge_amount=?,discount_amount=?,discount_label=?,promotion_id=?,cash_received=?,paid_at=?,updated_at=?,status='completed'
        WHERE id=? AND tenant_id=? AND payment_status='unpaid' AND status<>'cancelled'""",
        ('split' if len(normalized)>1 else normalized[0][0],money_float(tax),money_float(service),money_float(discount),label,promotion_id,money_float(cash_received_total) if cash_received_total else None,ts,ts,oid,g.tenant_id))
    if getattr(claimed,'rowcount',1)!=1: conn.rollback(); return jsonify(error='บิลถูกเปลี่ยนจากอุปกรณ์อื่น กรุณารีเฟรช'),409
    try:
        for method,amount,cr,ref in normalized:
            conn.execute("""INSERT INTO payments(tenant_id,branch_id,order_id,amount,payment_method,cash_received,reference,paid_by_user_id,paid_at)
                            VALUES(?,?,?,?,?,?,?,?,?)""",(g.tenant_id,order['branch_id'],oid,money_float(amount),method,money_float(cr) if cr is not None else None,ref,g.user['id'],ts))
        log_action('payment_completed',detail=f'{oid}: split={len(normalized)} due={due}'); conn.commit()
    except Exception:
        conn.rollback(); app.logger.exception('payment 2.0 failed'); return jsonify(error='บันทึกการชำระเงินไม่สำเร็จ'),500
    change=money_sum(max(Decimal('0.00'),(cr or Decimal('0.00'))-amount) for method,amount,cr,_ in normalized if method=='cash')
    return jsonify(ok=True,amount=money_float(due),payments=[{'method':x[0],'amount':money_float(x[1])} for x in normalized],change=money_float(change))

@app.post('/api/orders/<int:oid>/reopen')
@login_required
@role_required('owner','manager','staff')
def reopen_paid_order(oid):
    """Reverse the active payment without deleting history, then reopen the bill for correction."""
    conn=db(); order=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?',(oid,g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'),404
    if order['payment_status']!='paid': return jsonify(error='เปิดบิลใหม่ได้เฉพาะออเดอร์ที่ชำระแล้ว'),409
    refunded=conn.execute('SELECT id FROM refunds WHERE tenant_id=? AND order_id=? LIMIT 1',(g.tenant_id,oid)).fetchone()
    if refunded: return jsonify(error='บิลนี้มีการคืนเงินแล้ว ไม่สามารถเปิดบิลเดิมกลับมาแก้ไขได้'),409
    payments=conn.execute('SELECT * FROM payments WHERE tenant_id=? AND order_id=? AND reversed_at IS NULL ORDER BY id',(g.tenant_id,oid)).fetchall()
    if not payments: return jsonify(error='ไม่พบรายการชำระเงินที่ใช้งานอยู่'),409
    d=request.get_json() or {}; reason=(d.get('reason') or '').strip()[:300]
    if len(reason)<2: return jsonify(error='กรุณาเลือกเหตุผลการเปิดบิลกลับมาแก้ไข'),400
    approved_by, approval_err=_critical_approval(conn,d)
    if approval_err: return approval_err
    shift_id=None
    if any(p['payment_method']=='cash' for p in payments):
        sh=conn.execute("SELECT id FROM work_shifts WHERE tenant_id=? AND branch_id=? AND opened_by_user_id=? AND status='open' ORDER BY id DESC LIMIT 1",(g.tenant_id,order['branch_id'],g.user['id'])).fetchone()
        if not sh: return jsonify(error='กรุณาเปิดกะก่อนเปิดบิลเงินสดกลับมาแก้ไข เพื่อให้ยอดเงินในลิ้นชักตรง'),409
        shift_id=sh['id']
    ts=now()
    claimed=conn.execute("UPDATE payments SET reversed_at=?,reversed_by_user_id=?,reversal_reason=?,reversed_shift_id=? WHERE tenant_id=? AND order_id=? AND reversed_at IS NULL",(ts,g.user['id'],reason,shift_id,g.tenant_id,oid))
    if getattr(claimed,'rowcount',len(payments))<1: conn.rollback(); return jsonify(error='รายการชำระถูกเปลี่ยนจากอุปกรณ์อื่นแล้ว กรุณารีเฟรช'),409
    conn.execute("""UPDATE orders SET payment_status='unpaid',payment_method=NULL,cash_received=NULL,paid_at=NULL,
                 tax_amount=0,service_charge_amount=0,discount_amount=0,discount_label='',promotion_id=NULL,status='served',updated_at=?
                 WHERE id=? AND tenant_id=?""",(ts,oid,g.tenant_id))
    _record_critical(conn,'reopen_paid_order',order['branch_id'],'order',oid,reason,approved_by,f'payments={len(payments)} amount={sum(float(p["amount"]) for p in payments)}')
    log_action('reopen_paid_order',detail=f'{oid}: payments={len(payments)} reason={reason}')
    conn.commit(); return jsonify(ok=True,order_id=oid,table_id=order['table_id'])

@app.post('/api/orders/<int:oid>/items')
@login_required
@role_required('owner','manager','staff')
def add_order_items(oid):
    conn=db(); order=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?',(oid,g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'),404
    if order['status'] in ('completed','cancelled') or order['payment_status']=='paid': return jsonify(error='ออเดอร์นี้ปิดแล้ว ไม่สามารถเพิ่มรายการได้'),409
    d=request.get_json() or {}
    try: prepared,_=_validate_and_price_cart(conn,g.tenant_id,order['branch_id'],d.get('items') or [])
    except ValueError as e: return jsonify(error=str(e)),400
    ids=[]
    for it in prepared:
        cur=conn.execute('INSERT INTO order_items(order_id,menu_item_id,item_name_snapshot,quantity,unit_price,line_total,notes,kitchen_sent_at) VALUES(?,?,?,?,?,?,?,?)',
            (oid,it['menu_item_id'],it['item_name'],it['quantity'],it['unit_price'],it['line_total'],it['notes'],None))
        iid=cur.lastrowid; ids.append(iid)
        for op in it['options']:
            conn.execute('INSERT INTO order_item_options(order_item_id,group_name_snapshot,option_name_snapshot,price_delta_snapshot) VALUES(?,?,?,?)',(iid,op['group_name'],op['option_name'],op['price_delta']))
        _decrement_stock(conn,g.tenant_id,it['menu_item_id'],it['quantity'])
    total=_recalculate_order_total(conn,oid); log_action('add_order_items',detail=f'{oid}: {ids}'); conn.commit()
    return jsonify(ok=True,item_ids=ids,total_amount=total)

@app.put('/api/orders/<int:oid>/items/<int:iid>/cancel')
@login_required
@role_required('owner','manager','staff')
def cancel_order_item(oid,iid):
    conn=db(); order=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?',(oid,g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'),404
    if order['payment_status']=='paid' or order['status'] in ('completed','cancelled'): return jsonify(error='ออเดอร์นี้ปิดแล้ว'),409
    item_sql='SELECT * FROM order_items WHERE id=? AND order_id=?' + (' FOR UPDATE' if IS_POSTGRES else '')
    it=conn.execute(item_sql,(iid,oid)).fetchone()
    if not it: return jsonify(error='ไม่พบรายการ'),404
    d=request.get_json() or {}; remaining=max(0,int(it['quantity'])-int(it['cancelled_quantity'] or 0))
    reason=(d.get('reason') or '').strip()[:300]
    if len(reason)<2: return jsonify(error='กรุณาระบุเหตุผลการยกเลิกรายการ'),400
    approved_by, approval_err = _critical_approval(conn,d)
    if approval_err: return approval_err
    try: qty=int(d.get('quantity') or remaining)
    except: return jsonify(error='จำนวนไม่ถูกต้อง'),400
    if qty<1 or qty>remaining: return jsonify(error='จำนวนยกเลิกไม่ถูกต้อง'),400
    new_cancel=int(it['cancelled_quantity'] or 0)+qty
    conn.execute('UPDATE order_items SET cancelled_quantity=?,cancellation_reason=?,cancelled_at=? WHERE id=?',(new_cancel,reason[:200],now(),iid))
    _restore_stock(conn,g.tenant_id,it['menu_item_id'],qty); total=_recalculate_order_total(conn,oid)
    _record_critical(conn,'cancel_item',order['branch_id'],'order_item',iid,reason,approved_by,f'order={oid} qty={qty}')
    log_action('cancel_order_item',detail=f'{oid}/{iid}: {qty} / {reason}'); conn.commit()
    return jsonify(ok=True,total_amount=total,cancelled_quantity=new_cancel)

@app.put('/api/orders/<int:oid>/items/<int:iid>/quantity')
@login_required
@role_required('owner','manager','staff')
def update_order_item_quantity(oid,iid):
    """Change the active quantity of an open order item and keep stock in sync."""
    conn=db(); order=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?',(oid,g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'),404
    if order['payment_status']=='paid' or order['status'] in ('completed','cancelled'): return jsonify(error='ออเดอร์นี้ปิดแล้ว'),409
    it=conn.execute('SELECT * FROM order_items WHERE id=? AND order_id=?',(iid,oid)).fetchone()
    if not it: return jsonify(error='ไม่พบรายการ'),404
    d=request.get_json() or {}
    try: new_active=int(d.get('quantity'))
    except: return jsonify(error='จำนวนไม่ถูกต้อง'),400
    if new_active < 1 or new_active > 99: return jsonify(error='จำนวนต้องอยู่ระหว่าง 1-99'),400
    cancelled=int(it['cancelled_quantity'] or 0); old_active=max(0,int(it['quantity'])-cancelled)
    delta=new_active-old_active
    approved_by = None
    reason = ''
    if delta < 0:
        reason=(d.get('reason') or '').strip()
        if len(reason) < 2: return jsonify(error='กรุณาระบุเหตุผลในการลดจำนวนสินค้า'), 400
        approved_by, approval_err = _critical_approval(conn, d)
        if approval_err: return approval_err
    if delta>0: _decrement_stock(conn,g.tenant_id,it['menu_item_id'],delta)
    elif delta<0: _restore_stock(conn,g.tenant_id,it['menu_item_id'],-delta)
    new_total_qty=new_active+cancelled
    conn.execute('UPDATE order_items SET quantity=?,line_total=? WHERE id=?',(new_total_qty,new_total_qty*float(it['unit_price']),iid))
    total=_recalculate_order_total(conn,oid)
    if delta < 0:
        _record_critical(conn,'reduce_item_quantity',order['branch_id'],'order_item',iid,reason,approved_by,f'order={oid} {old_active}->{new_active}')
    log_action('update_order_item_quantity',detail=f'{oid}/{iid}: {old_active}->{new_active}' + (f' / {reason}' if reason else ''))
    conn.commit(); return jsonify(ok=True,total_amount=total,quantity=new_active)

@app.put('/api/orders/<int:oid>/move-table')
@login_required
@role_required('owner','manager','staff')
def move_order_table(oid):
    conn=db(); order=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?',(oid,g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'),404
    if order['order_type']!='dine_in' or order['status'] in ('completed','cancelled'): return jsonify(error='ออเดอร์นี้ไม่สามารถย้ายโต๊ะได้'),409
    try: table_id=int((request.get_json() or {}).get('table_id'))
    except: return jsonify(error='กรุณาเลือกโต๊ะปลายทาง'),400
    table_sql='SELECT * FROM dining_tables WHERE id=? AND tenant_id=? AND branch_id=? AND active=1' + (' FOR UPDATE' if IS_POSTGRES else '')
    tb=conn.execute(table_sql,(table_id,g.tenant_id,order['branch_id'])).fetchone()
    if not tb: return jsonify(error='โต๊ะปลายทางไม่ถูกต้อง'),400
    occupied=conn.execute("SELECT id FROM orders WHERE tenant_id=? AND branch_id=? AND table_id=? AND id<>? AND status NOT IN ('completed','cancelled') LIMIT 1",(g.tenant_id,order['branch_id'],table_id,oid)).fetchone()
    if occupied: return jsonify(error='โต๊ะปลายทางมีออเดอร์อยู่ กรุณาปิดหรือรวมออเดอร์ก่อน'),409
    conn.execute('UPDATE orders SET table_id=?,table_name_snapshot=?,updated_at=? WHERE id=?',(table_id,tb['name'],now(),oid))
    log_action('move_order_table',detail=f'{oid}: {order["table_id"]} -> {table_id}'); conn.commit(); return jsonify(ok=True)

# ---------- Round 14C: critical operations / manager approval ----------
def _critical_approval(conn, payload):
    # Staff must provide manager/owner credentials; managers approve their own critical action.
    if g.user['role'] in ('owner','manager','super_admin'):
        return g.user['id'], None
    username=(payload.get('approval_username') or '').strip()
    password=payload.get('approval_password') or ''
    if not username or not password:
        return None, (jsonify(error='รายการนี้ต้องได้รับอนุมัติจาก Owner/Manager'), 403)
    approver=conn.execute("SELECT * FROM users WHERE tenant_id=? AND username=? AND active=1 AND role IN ('owner','manager') LIMIT 1",(g.tenant_id,username)).fetchone()
    if not approver or not verify_password(approver['password_hash'],password):
        return None, (jsonify(error='ข้อมูลผู้อนุมัติไม่ถูกต้อง'), 403)
    return approver['id'], None

def _record_critical(conn, operation_type, branch_id=None, entity_type='', entity_id=None, reason_text='', approved_by=None, detail=''):
    conn.execute('''INSERT INTO critical_operations(tenant_id,branch_id,operation_type,entity_type,entity_id,reason_text,performed_by_user_id,approved_by_user_id,detail,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?)''',
                 (g.tenant_id,branch_id,operation_type,entity_type,entity_id,(reason_text or '')[:300],g.user['id'],approved_by,(detail or '')[:1000],now()))

@app.get('/api/operations/reasons')
@login_required
@role_required('owner','manager','staff')
def list_operation_reasons():
    typ=(request.args.get('operation_type') or '').strip()
    conn=db(); q='SELECT * FROM operation_reasons WHERE tenant_id=? AND active=1'; args=[g.tenant_id]
    if typ: q+=' AND operation_type=?'; args.append(typ)
    q+=' ORDER BY operation_type,sort_order,id'
    return jsonify([dict(x) for x in conn.execute(q,args).fetchall()])

@app.post('/api/operations/reasons')
@login_required
@role_required('owner','manager')
def create_operation_reason():
    d=request.get_json() or {}; typ=(d.get('operation_type') or '').strip()[:50]; label=(d.get('label') or '').strip()[:120]
    if typ not in ('cancel_item','cancel_order','refund','discount','cash_in','cash_out') or not label:
        return jsonify(error='ประเภทหรือเหตุผลไม่ถูกต้อง'),400
    conn=db(); cur=conn.execute('INSERT INTO operation_reasons(tenant_id,operation_type,label,active,sort_order,created_at) VALUES(?,?,?,?,?,?)',(g.tenant_id,typ,label,1,int(d.get('sort_order') or 0),now())); conn.commit()
    return jsonify(ok=True,id=cur.lastrowid)

# ---------- production completion: refund/void + merge bills ----------

@app.post('/api/orders/<int:oid>/refund')
@login_required
@role_required('owner','manager')
def refund_order(oid):
    """Partial refund across active payment rows; preserves every payment/refund for audit."""
    conn=db(); lock_suffix=' FOR UPDATE' if IS_POSTGRES else ''; order=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?'+lock_suffix,(oid,g.tenant_id)).fetchone()
    if not order or order['payment_status']!='paid': return jsonify(error='คืนเงินได้เฉพาะบิลที่ชำระแล้ว'),409
    payments=conn.execute('SELECT * FROM payments WHERE order_id=? AND tenant_id=? AND reversed_at IS NULL ORDER BY id',(oid,g.tenant_id)).fetchall()
    if not payments:return jsonify(error='ไม่พบข้อมูลการชำระเงิน'),409
    paid=money_sum(p['amount'] for p in payments)
    refunded=money_decimal(conn.execute('SELECT COALESCE(SUM(amount),0) t FROM refunds WHERE order_id=? AND tenant_id=?',(oid,g.tenant_id)).fetchone()['t'] or 0)
    d=request.get_json() or {}; reason=(d.get('reason') or '').strip()[:300]
    try: amount=money_decimal(d.get('amount') if d.get('amount') not in (None,'') else (paid-refunded))
    except:return jsonify(error='ยอดคืนเงินไม่ถูกต้อง'),400
    if len(reason)<2 or amount<=0 or amount>(paid-refunded):return jsonify(error='เหตุผลหรือยอดคืนเงินไม่ถูกต้อง'),400
    approved_by,err=_critical_approval(conn,d)
    if err:return err
    cash_active=any(p['payment_method']=='cash' for p in payments)
    sh=conn.execute("SELECT id FROM work_shifts WHERE tenant_id=? AND branch_id=? AND opened_by_user_id=? AND status='open' ORDER BY id DESC LIMIT 1",(g.tenant_id,order['branch_id'],g.user['id'])).fetchone()
    if cash_active and not sh:return jsonify(error='กรุณาเปิดกะก่อนคืนเงินจากบิลที่มีเงินสด'),409
    # Attribute refund to payment rows in order until requested amount is covered.
    left=amount; ts=now()
    try:
        for p in payments:
            if left<=Decimal('0.00'): break
            already=money_decimal(conn.execute('SELECT COALESCE(SUM(amount),0) t FROM refunds WHERE tenant_id=? AND payment_id=?',(g.tenant_id,p['id'])).fetchone()['t'] or 0)
            available=max(Decimal('0.00'),money_decimal(p['amount'])-already)
            part=min(left,available)
            if part<=0: continue
            conn.execute('INSERT INTO refunds(tenant_id,branch_id,order_id,payment_id,amount,reason,refunded_by_user_id,refunded_at,shift_id) VALUES(?,?,?,?,?,?,?,?,?)',
                         (g.tenant_id,order['branch_id'],oid,p['id'],money_float(part),reason,g.user['id'],ts,sh['id'] if sh and p['payment_method']=='cash' else None))
            left-=part
        _record_critical(conn,'refund',order['branch_id'],'order',oid,reason,approved_by,f'amount={amount}')
        log_action('payment_refunded',detail=f'{oid}: {amount} / {reason}'); conn.commit()
    except Exception:
        conn.rollback(); app.logger.exception('partial refund failed'); return jsonify(error='คืนเงินไม่สำเร็จ'),500
    return jsonify(ok=True,amount=money_float(amount),total_refunded=money_float(refunded+amount),remaining_refundable=money_float(max(Decimal('0.00'),paid-refunded-amount)))

@app.post('/api/orders/<int:source_id>/merge')
@login_required
@role_required('owner','manager','staff')
def merge_orders(source_id):
    """Merge one open unpaid order into another order in the same tenant/branch."""
    conn=db(); d=request.get_json() or {}
    try: target_id=int(d.get('target_order_id'))
    except: return jsonify(error='กรุณาเลือกบิลปลายทาง'),400
    if target_id==source_id: return jsonify(error='ไม่สามารถรวมบิลเดียวกันได้'),400
    lock_suffix=' FOR UPDATE' if IS_POSTGRES else ''
    source=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?'+lock_suffix,(source_id,g.tenant_id)).fetchone()
    target=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?',(target_id,g.tenant_id)).fetchone()
    if not source or not target: return jsonify(error='ไม่พบบิลต้นทางหรือปลายทาง'),404
    if source['branch_id']!=target['branch_id']: return jsonify(error='รวมบิลข้ามสาขาไม่ได้'),409
    for o in (source,target):
        if o['payment_status']!='unpaid' or o['status'] in ('completed','cancelled'):
            return jsonify(error='รวมได้เฉพาะบิลที่ยังเปิดและยังไม่ชำระ'),409
    conn.execute('UPDATE order_items SET order_id=? WHERE order_id=?',(target_id,source_id))
    total=_recalculate_order_total(conn,target_id)
    _recalculate_order_total(conn,source_id)
    conn.execute("UPDATE orders SET status='cancelled',notes=CASE WHEN notes='' THEN ? ELSE notes || ? END,updated_at=? WHERE id=?",
                 (f'รวมเข้าบิล #{target["order_no"]}',f' | รวมเข้าบิล #{target["order_no"]}',now(),source_id))
    log_action('merge_orders',detail=f'{source_id} -> {target_id}')
    conn.commit(); return jsonify(ok=True,target_order_id=target_id,total_amount=total)

@app.post('/api/orders/<int:source_id>/split')
@login_required
@role_required('owner','manager','staff')
def split_order(source_id):
    """Split selected active quantities into a new bill OR transfer them into an existing unpaid bill.
    Inventory is not changed because the same sold items are only being reassigned between bills.
    """
    conn=db(); d=request.get_json() or {}
    lock_suffix=' FOR UPDATE' if IS_POSTGRES else ''
    source=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?'+lock_suffix,(source_id,g.tenant_id)).fetchone()
    if not source: return jsonify(error='ไม่พบบิลต้นทาง'),404
    if source['payment_status']!='unpaid' or source['status'] in ('completed','cancelled'):
        return jsonify(error='ย้ายรายการได้เฉพาะบิลที่ยังเปิดและยังไม่ชำระ'),409

    target=None
    target_id=d.get('target_order_id')
    if target_id not in (None,''):
        try: target_id=int(target_id)
        except (TypeError,ValueError): return jsonify(error='บิลปลายทางไม่ถูกต้อง'),400
        if target_id==source_id: return jsonify(error='บิลต้นทางและปลายทางต้องไม่ใช่บิลเดียวกัน'),400
        target=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?'+lock_suffix,(target_id,g.tenant_id)).fetchone()
        if not target: return jsonify(error='ไม่พบบิลปลายทาง'),404
        if target['branch_id']!=source['branch_id']:
            return jsonify(error='ย้ายรายการข้ามสาขาไม่ได้'),409
        if target['payment_status']!='unpaid' or target['status'] in ('completed','cancelled'):
            return jsonify(error='ย้ายรายการได้เฉพาะไปยังบิลที่ยังเปิดและยังไม่ชำระ'),409
        if source['order_type']!='dine_in' or target['order_type']!='dine_in':
            return jsonify(error='การย้ายรายการระหว่างโต๊ะใช้ได้กับออเดอร์ทานที่ร้านเท่านั้น'),409

    req=d.get('items') or []
    if not isinstance(req,list) or not req: return jsonify(error='กรุณาเลือกรายการที่ต้องการย้าย'),400
    selections=[]; seen=set()
    for x in req:
        try: iid=int(x.get('item_id')); qty=int(x.get('quantity'))
        except (TypeError,ValueError,AttributeError): return jsonify(error='รายการหรือจำนวนไม่ถูกต้อง'),400
        if iid in seen: return jsonify(error='มีรายการซ้ำ'),400
        seen.add(iid)
        it=conn.execute('SELECT * FROM order_items WHERE id=? AND order_id=?'+lock_suffix,(iid,source_id)).fetchone()
        if not it: return jsonify(error='ไม่พบรายการในบิลต้นทาง'),404
        active=max(0,int(it['quantity'] or 0)-int(it['cancelled_quantity'] or 0))
        if qty<1 or qty>active: return jsonify(error='จำนวนที่ย้ายไม่ถูกต้อง'),400
        selections.append((it,qty,active))

    total_active=int(conn.execute('SELECT COALESCE(SUM(quantity-COALESCE(cancelled_quantity,0)),0) q FROM order_items WHERE order_id=?',(source_id,)).fetchone()['q'] or 0)
    if sum(q for _,q,_ in selections)>=total_active:
        return jsonify(error='ต้องเหลืออย่างน้อย 1 รายการในบิลเดิม ถ้าจะย้ายทั้งบิลให้ใช้เมนูย้ายโต๊ะหรือรวมบิล'),409

    ts=now()
    try:
        if target:
            destination_id=target['id']; destination_no=target['order_no']
        else:
            destination_no,cur=insert_order_row(conn,g.tenant_id,
              """INSERT INTO orders(tenant_id,branch_id,order_no,order_type,table_id,table_name_snapshot,customer_name,customer_phone,customer_address,total_amount,guest_count,scheduled_for,delivery_fee,fulfillment_status,delivery_status,driver_name,driver_phone,delivery_note,status,notes,placed_by,created_by_user_id,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
              lambda n:(g.tenant_id,source['branch_id'],n,source['order_type'],source['table_id'],source['table_name_snapshot'],source['customer_name'],source['customer_phone'],source['customer_address'],0,None,source['scheduled_for'],0,source['fulfillment_status'],source['delivery_status'],source['driver_name'],source['driver_phone'],source['delivery_note'],source['status'],f'แยกจากบิล #{source["order_no"]}','staff',g.user['id'],ts,ts))
            destination_id=cur.lastrowid

        for it,qty,active in selections:
            cancelled=int(it['cancelled_quantity'] or 0)
            if qty==active and cancelled==0:
                conn.execute('UPDATE order_items SET order_id=? WHERE id=?',(destination_id,it['id']))
            else:
                remain=int(it['quantity'])-qty
                conn.execute('UPDATE order_items SET quantity=?,line_total=? WHERE id=?',(remain,remain*float(it['unit_price']),it['id']))
                nc=conn.execute("""INSERT INTO order_items(order_id,menu_item_id,item_name_snapshot,quantity,unit_price,line_total,notes,kitchen_sent_at,cancelled_quantity,cancellation_reason,cancelled_at)
                                  VALUES(?,?,?,?,?,?,?,?,?,?,?)""",(destination_id,it['menu_item_id'],it['item_name_snapshot'],qty,it['unit_price'],qty*float(it['unit_price']),it['notes'],it['kitchen_sent_at'],0,'',None))
                for op in conn.execute('SELECT * FROM order_item_options WHERE order_item_id=?',(it['id'],)).fetchall():
                    conn.execute('INSERT INTO order_item_options(order_item_id,group_name_snapshot,option_name_snapshot,price_delta_snapshot) VALUES(?,?,?,?)',(nc.lastrowid,op['group_name_snapshot'],op['option_name_snapshot'],op['price_delta_snapshot']))

        source_total=_recalculate_order_total(conn,source_id)
        destination_total=_recalculate_order_total(conn,destination_id)
        action='transfer_order_items' if target else 'split_order'
        log_action(action,detail=f'{source_id}->{destination_id}; items={len(selections)}')
        conn.commit()
        return jsonify(ok=True,
                       target_order_id=destination_id if target else None,
                       new_order_id=None if target else destination_id,
                       new_order_no=None if target else destination_no,
                       target_order_no=destination_no,
                       source_total=source_total,
                       target_total=destination_total,
                       new_total=destination_total)
    except Exception:
        conn.rollback(); app.logger.exception('split/transfer order items failed')
        return jsonify(error='ไม่สามารถย้ายรายการได้'),500


# ---------- Round 15: kitchen stations + ingredient inventory ----------
@app.get('/api/kitchen/stations')
@login_required
@role_required('owner','manager','staff')
def kitchen_stations_list():
    bid=request.args.get('branch_id',type=int)
    q='SELECT * FROM kitchen_stations WHERE tenant_id=? AND active=1'; args=[g.tenant_id]
    if bid:q+=' AND (branch_id IS NULL OR branch_id=?)';args.append(bid)
    q+=' ORDER BY sort_order,id'
    return jsonify([dict(x) for x in db().execute(q,args).fetchall()])

@app.post('/api/kitchen/stations')
@login_required
@role_required('owner','manager')
def kitchen_station_create():
    d=request.get_json() or {}; name=(d.get('name') or '').strip()[:80]; bid=d.get('branch_id')
    if not name:return jsonify(error='กรุณาระบุชื่อสถานี'),400
    conn=db(); branch_id=None
    if bid not in (None,''):
        try: branch_id=int(bid)
        except (TypeError,ValueError): return jsonify(error='สาขาไม่ถูกต้อง'),400
        if not conn.execute('SELECT 1 FROM branches WHERE id=? AND tenant_id=? AND active=1',(branch_id,g.tenant_id)).fetchone():
            return jsonify(error='สาขาไม่ถูกต้อง'),400
    cur=conn.execute('INSERT INTO kitchen_stations(tenant_id,branch_id,name,active,sort_order,created_at) VALUES(?,?,?,?,?,?)',
        (g.tenant_id,branch_id,name,1,int(d.get('sort_order') or 0),now())); conn.commit()
    return jsonify(ok=True,id=cur.lastrowid)

@app.get('/api/inventory/ingredients')
@login_required
@role_required('owner','manager','staff')
def ingredients_list():
    bid=request.args.get('branch_id',type=int)
    if not bid:return jsonify(error='กรุณาเลือกสาขา'),400
    rows=db().execute('SELECT * FROM ingredients WHERE tenant_id=? AND branch_id=? AND active=1 ORDER BY name',(g.tenant_id,bid)).fetchall()
    return jsonify([dict(x) for x in rows])

@app.post('/api/inventory/ingredients')
@login_required
@role_required('owner','manager')
def ingredient_create():
    d=request.get_json() or {}; name=(d.get('name') or '').strip()[:120]
    try: bid=int(d.get('branch_id')); qty=float(d.get('stock_qty') or 0); low=float(d.get('low_stock_threshold') or 0); cost=float(d.get('cost_per_unit') or 0)
    except:return jsonify(error='ข้อมูลวัตถุดิบไม่ถูกต้อง'),400
    if not name or qty<0 or low<0 or cost<0:return jsonify(error='ข้อมูลวัตถุดิบไม่ถูกต้อง'),400
    conn=db()
    if not conn.execute('SELECT 1 FROM branches WHERE id=? AND tenant_id=? AND active=1',(bid,g.tenant_id)).fetchone():
        return jsonify(error='สาขาไม่ถูกต้อง'),400
    ts=now(); cur=conn.execute('INSERT INTO ingredients(tenant_id,branch_id,name,unit,stock_qty,low_stock_threshold,cost_per_unit,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        (g.tenant_id,bid,name,(d.get('unit') or 'unit')[:30],qty,low,cost,1,ts,ts)); conn.commit()
    return jsonify(ok=True,id=cur.lastrowid)

@app.post('/api/inventory/ingredients/<int:iid>/adjust')
@login_required
@role_required('owner','manager')
def ingredient_adjust(iid):
    d=request.get_json() or {}; reason=(d.get('reason') or '').strip()[:300]
    try: delta=float(d.get('quantity') or 0)
    except:return jsonify(error='จำนวนไม่ถูกต้อง'),400
    if not delta or not reason:return jsonify(error='กรุณาระบุจำนวนและเหตุผล'),400
    conn=db(); ing_sql='SELECT * FROM ingredients WHERE id=? AND tenant_id=?' + (' FOR UPDATE' if IS_POSTGRES else '')
    ing=conn.execute(ing_sql,(iid,g.tenant_id)).fetchone()
    if not ing:return jsonify(error='ไม่พบวัตถุดิบ'),404
    old_qty=float(ing['stock_qty']); new=max(0,old_qty+delta); applied=new-old_qty; ts=now()
    conn.execute('UPDATE ingredients SET stock_qty=?,updated_at=? WHERE id=?',(new,ts,iid))
    conn.execute('INSERT INTO inventory_movements(tenant_id,branch_id,ingredient_id,movement_type,quantity,reason,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
        (g.tenant_id,ing['branch_id'],iid,'adjustment',applied,reason,g.user['id'],ts)); conn.commit()
    return jsonify(ok=True,stock_qty=new,applied_quantity=applied)

@app.get('/api/inventory/recipes/<int:mid>')
@login_required
@role_required('owner','manager')
def recipe_get(mid):
    rows=db().execute("""SELECT r.*,i.name ingredient_name,i.unit FROM recipes r JOIN ingredients i ON i.id=r.ingredient_id
        WHERE r.tenant_id=? AND r.menu_item_id=? ORDER BY i.name""",(g.tenant_id,mid)).fetchall()
    return jsonify([dict(x) for x in rows])

@app.put('/api/inventory/recipes/<int:mid>')
@login_required
@role_required('owner','manager')
def recipe_put(mid):
    d=request.get_json() or {}; items=d.get('items') or []; conn=db()
    menu=conn.execute('SELECT id FROM menu_items WHERE id=? AND tenant_id=?',(mid,g.tenant_id)).fetchone()
    if not menu:return jsonify(error='ไม่พบเมนู'),404
    try:
        conn.execute('DELETE FROM recipes WHERE tenant_id=? AND menu_item_id=?',(g.tenant_id,mid))
        for x in items:
            iid=int(x['ingredient_id']); qty=float(x['quantity'])
            if qty<=0:raise ValueError()
            if not conn.execute('SELECT id FROM ingredients WHERE id=? AND tenant_id=?',(iid,g.tenant_id)).fetchone():raise ValueError()
            conn.execute('INSERT INTO recipes(tenant_id,menu_item_id,ingredient_id,quantity,created_at) VALUES(?,?,?,?,?)',(g.tenant_id,mid,iid,qty,now()))
        conn.commit()
    except Exception:
        conn.rollback();return jsonify(error='สูตรวัตถุดิบไม่ถูกต้อง'),400
    return jsonify(ok=True)


# ---------- Round 17: complete restaurant operations ----------
@app.put('/api/kitchen/stations/<int:sid>')
@login_required
@role_required('owner','manager')
def kitchen_station_update(sid):
    d=request.get_json() or {}; conn=db()
    row=conn.execute('SELECT * FROM kitchen_stations WHERE id=? AND tenant_id=?',(sid,g.tenant_id)).fetchone()
    if not row:return jsonify(error='ไม่พบสถานี'),404
    name=(d.get('name') or row['name']).strip()[:80]; active=1 if d.get('active',bool(row['active'])) else 0
    conn.execute('UPDATE kitchen_stations SET name=?,active=?,sort_order=? WHERE id=?',(name,active,int(d.get('sort_order',row['sort_order']) or 0),sid));conn.commit()
    return jsonify(ok=True)

@app.get('/api/inventory/movements')
@login_required
@role_required('owner','manager')
def inventory_movements_list():
    bid=request.args.get('branch_id',type=int); limit=min(200,max(1,request.args.get('limit',50,type=int)))
    if not bid:return jsonify(error='กรุณาเลือกสาขา'),400
    rows=db().execute("""SELECT m.*,i.name ingredient_name,i.unit,u.display_name user_name
      FROM inventory_movements m JOIN ingredients i ON i.id=m.ingredient_id LEFT JOIN users u ON u.id=m.created_by_user_id
      WHERE m.tenant_id=? AND m.branch_id=? ORDER BY m.id DESC LIMIT ?""",(g.tenant_id,bid,limit)).fetchall()
    return jsonify([dict(x) for x in rows])

@app.post('/api/inventory/ingredients/<int:iid>/waste')
@login_required
@role_required('owner','manager')
def ingredient_waste(iid):
    d=request.get_json() or {}; reason=(d.get('reason') or '').strip()[:300]
    try: qty=float(d.get('quantity') or 0)
    except:return jsonify(error='จำนวนไม่ถูกต้อง'),400
    if qty<=0 or not reason:return jsonify(error='กรุณาระบุจำนวนและเหตุผล'),400
    conn=db(); ing=conn.execute('SELECT * FROM ingredients WHERE id=? AND tenant_id=?',(iid,g.tenant_id)).fetchone()
    if not ing:return jsonify(error='ไม่พบวัตถุดิบ'),404
    if qty>float(ing['stock_qty']):return jsonify(error='จำนวนทิ้งมากกว่าสต็อกคงเหลือ'),409
    ts=now(); new=float(ing['stock_qty'])-qty
    conn.execute('UPDATE ingredients SET stock_qty=?,updated_at=? WHERE id=?',(new,ts,iid))
    conn.execute('INSERT INTO inventory_movements(tenant_id,branch_id,ingredient_id,movement_type,quantity,reason,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
      (g.tenant_id,ing['branch_id'],iid,'waste',-qty,reason,g.user['id'],ts));conn.commit()
    return jsonify(ok=True,stock_qty=new)

@app.post('/api/inventory/ingredients/<int:iid>/count')
@login_required
@role_required('owner','manager')
def ingredient_stock_count(iid):
    d=request.get_json() or {}; note=(d.get('note') or '').strip()[:300]
    try: counted=float(d.get('counted_qty'))
    except:return jsonify(error='จำนวนตรวจนับไม่ถูกต้อง'),400
    if counted<0:return jsonify(error='จำนวนตรวจนับไม่ถูกต้อง'),400
    conn=db(); ing=conn.execute('SELECT * FROM ingredients WHERE id=? AND tenant_id=?',(iid,g.tenant_id)).fetchone()
    if not ing:return jsonify(error='ไม่พบวัตถุดิบ'),404
    system=float(ing['stock_qty']); diff=counted-system; ts=now()
    conn.execute('INSERT INTO inventory_counts(tenant_id,branch_id,ingredient_id,system_qty,counted_qty,difference,note,counted_by_user_id,counted_at) VALUES(?,?,?,?,?,?,?,?,?)',
      (g.tenant_id,ing['branch_id'],iid,system,counted,diff,note,g.user['id'],ts))
    conn.execute('UPDATE ingredients SET stock_qty=?,updated_at=? WHERE id=?',(counted,ts,iid))
    if abs(diff)>0.000001:
        conn.execute('INSERT INTO inventory_movements(tenant_id,branch_id,ingredient_id,movement_type,quantity,reason,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
          (g.tenant_id,ing['branch_id'],iid,'stock_count',diff,note or 'ปรับจากการตรวจนับ',g.user['id'],ts))
    conn.commit();return jsonify(ok=True,system_qty=system,counted_qty=counted,difference=diff)

@app.get('/api/inventory/counts')
@login_required
@role_required('owner','manager')
def inventory_counts_list():
    bid=request.args.get('branch_id',type=int)
    if not bid:return jsonify(error='กรุณาเลือกสาขา'),400
    rows=db().execute("""SELECT c.*,i.name ingredient_name,i.unit,u.display_name user_name
      FROM inventory_counts c JOIN ingredients i ON i.id=c.ingredient_id LEFT JOIN users u ON u.id=c.counted_by_user_id
      WHERE c.tenant_id=? AND c.branch_id=? ORDER BY c.id DESC LIMIT 100""",(g.tenant_id,bid)).fetchall()
    return jsonify([dict(x) for x in rows])

@app.get('/api/kitchen/print-jobs')
@login_required
@role_required('owner','manager','staff')
def kitchen_print_jobs_list():
    bid=request.args.get('branch_id',type=int); status=request.args.get('status') or 'pending'
    if not bid:return jsonify(error='กรุณาเลือกสาขา'),400
    rows=db().execute("""SELECT j.*,s.name station_name,o.order_no FROM kitchen_print_jobs j
      LEFT JOIN kitchen_stations s ON s.id=j.station_id JOIN orders o ON o.id=j.order_id
      WHERE j.tenant_id=? AND j.branch_id=? AND j.status=? ORDER BY j.id LIMIT 100""",(g.tenant_id,bid,status)).fetchall()
    return jsonify([dict(x) for x in rows])

@app.post('/api/kitchen/print-jobs/<int:jid>/result')
@login_required
@role_required('owner','manager','staff')
def kitchen_print_job_result(jid):
    d=request.get_json() or {}; ok=bool(d.get('ok')); conn=db()
    row=conn.execute('SELECT * FROM kitchen_print_jobs WHERE id=? AND tenant_id=?',(jid,g.tenant_id)).fetchone()
    if not row:return jsonify(error='ไม่พบงานพิมพ์'),404
    conn.execute("UPDATE kitchen_print_jobs SET status=?,attempts=attempts+1,last_error=?,printed_at=? WHERE id=?",
      ('printed' if ok else 'pending','' if ok else (d.get('error') or 'print failed')[:300],now() if ok else None,jid));conn.commit()
    return jsonify(ok=True)

# =====================================================================
# Users management (same pattern as CASHFLOW 24)
# =====================================================================

@app.get('/api/users')
@login_required
@role_required('owner')
def list_users():
    conn = db()
    rows = conn.execute('SELECT id,username,display_name,role,active FROM users WHERE tenant_id=? ORDER BY id', (g.tenant_id,)).fetchall()
    return jsonify([dict(x) for x in rows])

@app.post('/api/users')
@login_required
@role_required('owner')
def add_user():
    err = require_tenant()
    if err: return err
    d = request.get_json() or {}
    username = (d.get('username') or '').strip(); display_name = (d.get('display_name') or '').strip()
    password = d.get('password') or ''; role = d.get('role') or 'staff'
    if not username or not display_name or not password: return jsonify(error='กรุณาใส่ชื่อผู้ใช้ ชื่อที่แสดง และรหัสผ่าน'), 400
    if role not in ('owner', 'manager', 'staff'): return jsonify(error='สิทธิ์ไม่ถูกต้อง'), 400
    if len(password) < 10: return jsonify(error='รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร'), 400
    conn=db(); tenant=conn.execute('SELECT max_users FROM tenants WHERE id=?'+(' FOR UPDATE' if IS_POSTGRES else ''),(g.tenant_id,)).fetchone()
    used=conn.execute('SELECT COUNT(*) c FROM users WHERE tenant_id=? AND active=1',(g.tenant_id,)).fetchone()['c']
    if tenant and used>=int(tenant['max_users'] or 1):return jsonify(error=f"แพ็กเกจนี้รองรับสูงสุด {tenant['max_users']} ผู้ใช้ กรุณาอัปเกรดแพ็กเกจ"),409
    try:
        cur = conn.execute('INSERT INTO users(tenant_id,username,password_hash,display_name,role,must_change_password,created_at) VALUES(?,?,?,?,?,?,?)',
            (g.tenant_id, username, hash_password(password), display_name, role, 1, now()))
    except INTEGRITY_ERRORS:
        return jsonify(error='ชื่อผู้ใช้นี้มีคนใช้แล้ว'), 400
    log_action('add_user', detail=username)
    conn.commit()
    return jsonify(ok=True, id=cur.lastrowid)

@app.put('/api/users/<int:uid>')
@login_required
@role_required('owner')
def edit_user(uid):
    d = request.get_json() or {}; conn = db()
    old = conn.execute('SELECT * FROM users WHERE id=? AND tenant_id=?', (uid, g.tenant_id)).fetchone()
    if not old: return jsonify(error='ไม่พบผู้ใช้'), 404
    display_name = (d.get('display_name') or old['display_name']).strip()
    role = d.get('role') or old['role']
    if role not in ('owner', 'manager', 'staff'): return jsonify(error='สิทธิ์ไม่ถูกต้อง'), 400
    if uid == g.user['id'] and role != 'owner':
        return jsonify(error='ไม่สามารถลดสิทธิ์ตัวเองได้ ให้เจ้าของอีกคนทำแทน'), 400
    active = 1 if d.get('active', old['active']) else 0
    params = [display_name, role, active]
    sql = 'UPDATE users SET display_name=?,role=?,active=?'
    if d.get('password'):
        if len(d['password']) < 10: return jsonify(error='รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร'), 400
        sql += ',password_hash=?,must_change_password=1'; params.append(hash_password(d['password']))
    sql += ' WHERE id=?'; params.append(uid)
    conn.execute(sql, params)
    log_action('edit_user', detail=f'id={uid}'); conn.commit()
    return jsonify(ok=True)

@app.delete('/api/users/<int:uid>')
@login_required
@role_required('owner')
def deactivate_user(uid):
    if uid == g.user['id']: return jsonify(error='ปิดการใช้งานบัญชีตัวเองไม่ได้'), 400
    conn = db()
    conn.execute('UPDATE users SET active=0 WHERE id=? AND tenant_id=? AND active=1', (uid, g.tenant_id))
    log_action('deactivate_user', detail=str(uid))
    conn.commit()
    return jsonify(ok=True)

# =====================================================================
# Reports (sales summary) & expenses (รายรับ-รายจ่าย) — owner/manager only
# =====================================================================

DEFAULT_EXPENSE_CATEGORIES = ['ค่าวัตถุดิบ', 'ค่าเช่า', 'ค่าแรงพนักงาน', 'ค่าน้ำค่าไฟ', 'ค่าเดินทาง/ขนส่ง', 'อื่นๆ']

def _report_date_range():
    """from/to as YYYY-MM-DD; defaults to today when not given."""
    today = restaurant_today()
    frm = (request.args.get('from') or today)[:10]
    to = (request.args.get('to') or today)[:10]
    if frm > to: frm, to = to, frm
    return frm, to

@app.get('/api/reports/summary')
@login_required
@role_required('owner', 'manager')
def reports_summary():
    err = require_tenant()
    if err: return err
    conn = db()
    frm, to = _report_date_range()
    branch_id = request.args.get('branch_id')
    if branch_id not in (None, ''):
        try: branch_id = int(branch_id)
        except (TypeError, ValueError): return jsonify(error='branch_id ไม่ถูกต้อง'), 400

    range_start, range_end = local_range_bounds_utc(frm, to)
    q = '''SELECT COUNT(*) AS c, COALESCE(SUM(total_amount),0) AS subtotal, COALESCE(SUM(tax_amount),0) AS tax,
           COALESCE(SUM(discount_amount),0) AS discount, COALESCE(SUM(service_charge_amount),0) AS service, COALESCE(SUM(delivery_fee),0) AS delivery, COALESCE(SUM(guest_count),0) AS guests
           FROM orders WHERE tenant_id=? AND payment_status='paid' AND status!='cancelled' AND COALESCE(paid_at,created_at)>=? AND COALESCE(paid_at,created_at)<?'''
    args = [g.tenant_id, range_start, range_end]
    if branch_id: q += ' AND branch_id=?'; args.append(branch_id)
    row = conn.execute(q, args).fetchone()
    order_count = row['c'] or 0
    subtotal = row['subtotal'] or 0
    tax = row['tax'] or 0
    discount = row['discount'] or 0
    service = row['service'] or 0
    delivery = row['delivery'] or 0
    guests = row['guests'] or 0
    total_sales = subtotal - discount + service + tax + delivery

    ti_q = '''SELECT oi.item_name_snapshot AS name,
                     SUM(oi.quantity-COALESCE(oi.cancelled_quantity,0)) AS qty,
                     SUM((oi.quantity-COALESCE(oi.cancelled_quantity,0))*oi.unit_price) AS revenue
              FROM order_items oi JOIN orders o ON o.id=oi.order_id
              WHERE o.tenant_id=? AND o.payment_status='paid' AND o.status!='cancelled' AND COALESCE(o.paid_at,o.created_at)>=? AND COALESCE(o.paid_at,o.created_at)<?'''
    ti_args = [g.tenant_id, range_start, range_end]
    if branch_id: ti_q += ' AND o.branch_id=?'; ti_args.append(branch_id)
    ti_q += ' GROUP BY oi.item_name_snapshot ORDER BY qty DESC LIMIT 10'
    top_items = [dict(r) for r in conn.execute(ti_q, ti_args).fetchall()]

    ex_q = 'SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE tenant_id=? AND expense_date BETWEEN ? AND ?'
    ex_args = [g.tenant_id, frm, to]
    if branch_id: ex_q += ' AND branch_id=?'; ex_args.append(branch_id)
    expense_total = conn.execute(ex_q, ex_args).fetchone()['total'] or 0

    cat_q = ex_q.replace('COALESCE(SUM(amount),0) AS total', 'category, COALESCE(SUM(amount),0) AS total') + ' GROUP BY category ORDER BY total DESC'
    expense_by_category = [dict(r) for r in conn.execute(cat_q, ex_args).fetchall()]

    pay_q = '''SELECT payment_method, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM payments
               WHERE tenant_id=? AND reversed_at IS NULL AND paid_at>=? AND paid_at<?'''
    pay_args=[g.tenant_id,range_start,range_end]
    if branch_id: pay_q += ' AND branch_id=?'; pay_args.append(branch_id)
    pay_q += ' GROUP BY payment_method ORDER BY total DESC'
    payment_breakdown=[dict(r) for r in conn.execute(pay_q,pay_args).fetchall()]
    refund_q="SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM refunds WHERE tenant_id=? AND refunded_at>=? AND refunded_at<?"
    refund_args=[g.tenant_id,range_start,range_end]
    if branch_id: refund_q += ' AND branch_id=?'; refund_args.append(branch_id)
    refund_row=conn.execute(refund_q,refund_args).fetchone(); refund_total=float(refund_row['total'] or 0)
    open_q="SELECT COUNT(*) AS c, COALESCE(SUM(total_amount-discount_amount+service_charge_amount+tax_amount+delivery_fee),0) AS total FROM orders WHERE tenant_id=? AND payment_status='unpaid' AND status!='cancelled'"
    open_args=[g.tenant_id]
    if branch_id: open_q+=' AND branch_id=?'; open_args.append(branch_id)
    open_row=conn.execute(open_q,open_args).fetchone()

    cancel_q = """SELECT c.operation_type,c.reason_text,c.created_at,c.entity_id,u.display_name AS performed_by_name
      FROM critical_operations c LEFT JOIN users u ON u.id=c.performed_by_user_id
      WHERE c.tenant_id=? AND c.operation_type IN ('cancel_order','cancel_item') AND c.created_at>=? AND c.created_at<?"""
    cancel_args=[g.tenant_id,range_start,range_end]
    if branch_id: cancel_q+=' AND c.branch_id=?'; cancel_args.append(branch_id)
    cancel_q+=' ORDER BY c.created_at DESC'
    cancel_rows=[dict(r) for r in conn.execute(cancel_q,cancel_args).fetchall()]
    reason_map={}
    for cr in cancel_rows:
        reason=(cr.get('reason_text') or 'ไม่ระบุเหตุผล').strip() or 'ไม่ระบุเหตุผล'
        x=reason_map.setdefault(reason,{'reason':reason,'count':0,'order_count':0,'item_count':0})
        x['count']+=1; x['order_count']+=1 if cr['operation_type']=='cancel_order' else 0; x['item_count']+=1 if cr['operation_type']=='cancel_item' else 0
    cancellation_analytics={'total':len(cancel_rows),'order_count':sum(x['operation_type']=='cancel_order' for x in cancel_rows),
      'item_count':sum(x['operation_type']=='cancel_item' for x in cancel_rows),
      'reasons':sorted(reason_map.values(),key=lambda x:(-x['count'],x['reason'])),'recent':cancel_rows[:30]}

    return jsonify(
        from_date=frm, to_date=to,
        order_count=order_count, subtotal=subtotal, discount=discount, service_charge=service, tax=tax, delivery_fee=delivery, guests=guests, total_sales=total_sales,
        top_items=top_items,
        expense_total=expense_total, expense_by_category=expense_by_category,
        net_profit=total_sales - refund_total - expense_total, net_after_recorded_expenses=total_sales - refund_total - expense_total, payment_breakdown=payment_breakdown,
        refund_total=refund_total, refund_count=refund_row['count'] or 0, net_sales=total_sales-refund_total,
        open_order_count=open_row['c'] or 0, open_order_total=open_row['total'] or 0,
        average_bill=(total_sales / order_count) if order_count else 0,
        cancellations=cancellation_analytics,
    )

@app.get('/api/daily-closing')
@login_required
@role_required('owner','manager')
def get_daily_closing():
    return jsonify(error='Daily Closing เดิมถูกยกเลิกแล้ว กรุณาใช้ กะ & เงินสด (Shift/Cash) ซึ่งเป็นแหล่งข้อมูลหลัก'),410

@app.post('/api/daily-closing')
@login_required
@role_required('owner','manager')
def save_daily_closing():
    return jsonify(error='Daily Closing เดิมถูกยกเลิกแล้ว กรุณาใช้ กะ & เงินสด (Shift/Cash) ซึ่งเป็นแหล่งข้อมูลหลัก'),410

# ---------- Round 14A: shifts / cash drawer / critical operations ----------
def _shift_live_summary(conn, sh, user_id):
    """Single source of truth for live shift totals and close-shift reconciliation."""
    tenant_id=sh['tenant_id']; branch_id=sh['branch_id']; opened_at=sh['opened_at']; shift_id=sh['id']
    pay_rows=conn.execute("""SELECT payment_method, COALESCE(SUM(amount),0) AS total, COUNT(*) AS payment_count
        FROM payments WHERE tenant_id=? AND branch_id=? AND paid_by_user_id=? AND paid_at>=? AND reversed_at IS NULL
        GROUP BY payment_method""",(tenant_id,branch_id,user_id,opened_at)).fetchall()
    payment_breakdown={str(r['payment_method'] or 'other'): money_float(r['total'] or 0) for r in pay_rows}
    gross_received=money_float(sum(money_decimal(r['total'] or 0) for r in pay_rows))
    bill_row=conn.execute("""SELECT COUNT(DISTINCT order_id) AS c FROM payments
        WHERE tenant_id=? AND branch_id=? AND paid_by_user_id=? AND paid_at>=? AND reversed_at IS NULL""",(tenant_id,branch_id,user_id,opened_at)).fetchone()
    refund_row=conn.execute("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS c FROM refunds WHERE tenant_id=? AND shift_id=?",(tenant_id,shift_id)).fetchone()
    refund_total=money_float(refund_row['total'] or 0)
    mv_rows=conn.execute("""SELECT movement_type, COALESCE(SUM(amount),0) AS total FROM cash_movements
        WHERE tenant_id=? AND shift_id=? GROUP BY movement_type""",(tenant_id,shift_id)).fetchall()
    cash_in=cash_out=0.0
    for r in mv_rows:
        if r['movement_type']=='cash_in': cash_in=money_float(r['total'] or 0)
        elif r['movement_type']=='cash_out': cash_out=money_float(r['total'] or 0)
    cash_sales=money_float(payment_breakdown.get('cash',0))
    cash_refunds=conn.execute("SELECT COALESCE(SUM(r.amount),0) AS total FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE r.tenant_id=? AND r.shift_id=? AND p.payment_method='cash'",(tenant_id,shift_id)).fetchone()['total'] or 0
    cash_reversals=conn.execute("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE tenant_id=? AND reversed_shift_id=? AND payment_method='cash' AND reversed_at IS NOT NULL AND paid_at<?",(tenant_id,shift_id,opened_at)).fetchone()['total'] or 0
    expected=money_float(money_decimal(sh['opening_cash'])+money_decimal(cash_sales)+money_decimal(cash_in)-money_decimal(cash_out)-money_decimal(cash_refunds)-money_decimal(cash_reversals))
    return dict(
        gross_received=gross_received, refund_total=refund_total, net_received=money_float(money_decimal(gross_received)-money_decimal(refund_total)),
        bill_count=int(bill_row['c'] or 0), payment_breakdown=payment_breakdown,
        cash_sales=cash_sales, cash_in=cash_in, cash_out=cash_out, cash_refunds=money_float(cash_refunds), cash_reversals=money_float(cash_reversals),
        expected_cash=expected, refund_count=int(refund_row['c'] or 0)
    )

@app.get('/api/operations/shift')
@login_required
@role_required('owner','manager','staff')
def current_shift():
    conn=db(); branch_id=request.args.get('branch_id')
    if not branch_id: return jsonify(error='กรุณาเลือกสาขา'),400
    branch=conn.execute('SELECT id FROM branches WHERE id=? AND tenant_id=?',(branch_id,g.tenant_id)).fetchone()
    if not branch: return jsonify(error='ไม่พบสาขา'),404
    sh=conn.execute("SELECT s.*,u.display_name AS opened_by_name FROM work_shifts s LEFT JOIN users u ON u.id=s.opened_by_user_id WHERE s.tenant_id=? AND s.branch_id=? AND s.opened_by_user_id=? AND s.status='open' ORDER BY s.id DESC LIMIT 1",(g.tenant_id,branch_id,g.user['id'])).fetchone()
    if not sh: return jsonify(shift=None,movements=[],summary=None)
    moves=conn.execute('SELECT * FROM cash_movements WHERE tenant_id=? AND shift_id=? ORDER BY id DESC',(g.tenant_id,sh['id'])).fetchall()
    summary=_shift_live_summary(conn,sh,g.user['id'])
    return jsonify(shift=dict(sh),movements=[dict(x) for x in moves],summary=summary)

@app.post('/api/operations/shift/open')
@login_required
@role_required('owner','manager','staff')
def open_shift():
    d=request.get_json() or {}; conn=db(); branch_id=d.get('branch_id')
    if not conn.execute('SELECT id FROM branches WHERE id=? AND tenant_id=?',(branch_id,g.tenant_id)).fetchone(): return jsonify(error='ไม่พบสาขา'),404
    try: opening=float(d.get('opening_cash',0) or 0)
    except: return jsonify(error='เงินเปิดกะไม่ถูกต้อง'),400
    if opening<0: return jsonify(error='เงินเปิดกะต้องไม่ติดลบ'),400
    old=conn.execute("SELECT id FROM work_shifts WHERE tenant_id=? AND branch_id=? AND opened_by_user_id=? AND status='open'",(g.tenant_id,branch_id,g.user['id'])).fetchone()
    if old: return jsonify(error='คุณมีกะที่ยังเปิดอยู่ในสาขานี้'),409
    try:
        cur=conn.execute("INSERT INTO work_shifts(tenant_id,branch_id,opened_by_user_id,opened_at,opening_cash,status,notes) VALUES(?,?,?,?,?,'open',?)",(g.tenant_id,branch_id,g.user['id'],now(),opening,(d.get('notes') or '')[:300]))
        log_action('shift_opened',detail=f'branch={branch_id} opening={opening}'); conn.commit()
    except INTEGRITY_ERRORS:
        conn.rollback(); return jsonify(error='มีกะนี้เปิดอยู่แล้ว กรุณารีเฟรช'),409
    return jsonify(ok=True,id=cur.lastrowid)

@app.post('/api/operations/cash-movement')
@login_required
@role_required('owner','manager','staff')
def add_cash_movement():
    d=request.get_json() or {}; conn=db(); branch_id=d.get('branch_id'); typ=d.get('movement_type')
    if typ not in ('cash_in','cash_out'): return jsonify(error='ประเภทเงินสดไม่ถูกต้อง'),400
    try: amount=float(d.get('amount',0) or 0)
    except: return jsonify(error='จำนวนเงินไม่ถูกต้อง'),400
    reason=(d.get('reason') or '').strip()[:300]
    if amount<=0 or not reason: return jsonify(error='กรุณาระบุจำนวนเงินและเหตุผล'),400
    sh=conn.execute("SELECT id FROM work_shifts WHERE tenant_id=? AND branch_id=? AND opened_by_user_id=? AND status='open' ORDER BY id DESC LIMIT 1",(g.tenant_id,branch_id,g.user['id'])).fetchone()
    if not sh: return jsonify(error='กรุณาเปิดกะก่อนทำรายการเงินสด'),409
    conn.execute('INSERT INTO cash_movements(tenant_id,branch_id,shift_id,movement_type,amount,reason,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)',(g.tenant_id,branch_id,sh['id'],typ,amount,reason,g.user['id'],now()))
    log_action(typ,detail=f'branch={branch_id} amount={amount} reason={reason}'); conn.commit(); return jsonify(ok=True)

@app.post('/api/operations/shift/close')
@login_required
@role_required('owner','manager','staff')
def close_shift():
    d=request.get_json() or {}; conn=db(); branch_id=d.get('branch_id')
    sh=conn.execute("SELECT * FROM work_shifts WHERE tenant_id=? AND branch_id=? AND opened_by_user_id=? AND status='open' ORDER BY id DESC LIMIT 1",(g.tenant_id,branch_id,g.user['id'])).fetchone()
    if not sh: return jsonify(error='ไม่พบกะที่เปิดอยู่'),409
    try: counted=float(d.get('counted_cash',0) or 0)
    except: return jsonify(error='ยอดเงินนับจริงไม่ถูกต้อง'),400
    if counted<0: return jsonify(error='ยอดเงินนับจริงต้องไม่ติดลบ'),400
    summary=_shift_live_summary(conn,sh,g.user['id'])
    cash_sales=summary['cash_sales']; cash_refunds=summary['cash_refunds']; cash_reversals=summary['cash_reversals']; expected=summary['expected_cash']
    counted=money_float(counted); diff=money_float(money_decimal(counted)-money_decimal(expected)); ts=now()
    claimed=conn.execute("UPDATE work_shifts SET status='closed',closed_by_user_id=?,closed_at=?,counted_cash=?,expected_cash=?,difference=?,notes=? WHERE id=? AND tenant_id=? AND status='open'",(g.user['id'],ts,counted,expected,diff,(d.get('notes') or sh['notes'] or '')[:300],sh['id'],g.tenant_id))
    if getattr(claimed,'rowcount',1)!=1: conn.rollback(); return jsonify(error='กะนี้ถูกปิดจากอุปกรณ์อื่นแล้ว'),409
    log_action('shift_closed',detail=f'branch={branch_id} expected={expected} counted={counted} diff={diff}'); conn.commit()
    return jsonify(ok=True,expected_cash=expected,counted_cash=counted,difference=diff,cash_sales=cash_sales,cash_refunds=cash_refunds,cash_reversals=cash_reversals)

@app.get('/api/operations/critical')
@login_required
@role_required('owner','manager')
def list_critical_operations():
    conn=db(); rows=conn.execute("SELECT c.*,u.display_name AS performed_by_name,a.display_name AS approved_by_name FROM critical_operations c LEFT JOIN users u ON u.id=c.performed_by_user_id LEFT JOIN users a ON a.id=c.approved_by_user_id WHERE c.tenant_id=? ORDER BY c.id DESC LIMIT 200",(g.tenant_id,)).fetchall()
    return jsonify([dict(x) for x in rows])

@app.get('/api/expenses')
@login_required
@role_required('owner', 'manager')
def list_expenses():
    err = require_tenant()
    if err: return err
    conn = db()
    frm, to = _report_date_range()
    branch_id = request.args.get('branch_id')
    q = '''SELECT expenses.*, u.display_name AS created_by_name FROM expenses
           LEFT JOIN users u ON u.id = expenses.created_by_user_id
           WHERE expenses.tenant_id=? AND expenses.expense_date BETWEEN ? AND ?'''
    args = [g.tenant_id, frm, to]
    if branch_id: q += ' AND expenses.branch_id=?'; args.append(branch_id)
    q += ' ORDER BY expenses.expense_date DESC, expenses.id DESC LIMIT 500'
    rows = conn.execute(q, args).fetchall()
    return jsonify(expenses=[dict(r) for r in rows])

@app.get('/api/expense-categories')
@login_required
@role_required('owner', 'manager')
def expense_categories():
    err = require_tenant()
    if err: return err
    conn = db()
    rows = conn.execute('SELECT DISTINCT category FROM expenses WHERE tenant_id=? ORDER BY category', (g.tenant_id,)).fetchall()
    existing = [r['category'] for r in rows]
    merged = list(DEFAULT_EXPENSE_CATEGORIES)
    for c in existing:
        if c not in merged: merged.append(c)
    return jsonify(categories=merged)

@app.post('/api/expenses')
@login_required
@role_required('owner', 'manager')
def add_expense():
    err = require_tenant()
    if err: return err
    d = request.get_json() or {}
    category = (d.get('category') or '').strip()[:100]
    if not category: return jsonify(error='กรุณาเลือกหรือกรอกหมวดรายจ่าย'), 400
    try:
        amount = float(d.get('amount'))
        if amount <= 0: raise ValueError()
    except (TypeError, ValueError):
        return jsonify(error='จำนวนเงินไม่ถูกต้อง'), 400
    expense_date = (d.get('expense_date') or restaurant_today())[:10]
    branch_id = d.get('branch_id') or None
    conn = db()
    if branch_id is not None:
        try: branch_id=int(branch_id)
        except (TypeError,ValueError): return jsonify(error='สาขาไม่ถูกต้อง'),400
        if not conn.execute('SELECT 1 FROM branches WHERE id=? AND tenant_id=? AND active=1',(branch_id,g.tenant_id)).fetchone():
            return jsonify(error='สาขาไม่ถูกต้อง'),400
    cur = conn.execute('''INSERT INTO expenses(tenant_id,branch_id,category,amount,note,expense_date,created_by_user_id,created_at)
        VALUES(?,?,?,?,?,?,?,?)''',
        (g.tenant_id, branch_id, category, amount, (d.get('note') or '').strip()[:300], expense_date, g.user['id'], now()))
    log_action('add_expense', detail=f'{category} {amount}')
    conn.commit()
    return jsonify(ok=True, id=cur.lastrowid)

@app.delete('/api/expenses/<int:eid>')
@login_required
@role_required('owner', 'manager')
def delete_expense(eid):
    conn = db()
    old = conn.execute('SELECT 1 FROM expenses WHERE id=? AND tenant_id=?', (eid, g.tenant_id)).fetchone()
    if not old: return jsonify(error='ไม่พบรายการ'), 404
    conn.execute('DELETE FROM expenses WHERE id=?', (eid,))
    log_action('delete_expense', detail=str(eid))
    conn.commit()
    return jsonify(ok=True)

# ---------- Round 19 branded error pages ----------
@app.errorhandler(404)
def branded_not_found(err):
    if request.path.startswith('/api/'): return jsonify(error='ไม่พบ API หรือข้อมูลที่ร้องขอ'),404
    return render_template('error.html',code=404,title='ไม่พบหน้านี้',message='ลิงก์นี้อาจถูกย้าย ลบ หรือพิมพ์ไม่ถูกต้อง',action='กลับหน้า ZaabOS'),404

@app.errorhandler(500)
def branded_server_error(err):
    if request.path.startswith('/api/'): return jsonify(error='ระบบขัดข้องชั่วคราว กรุณาลองใหม่'),500
    return render_template('error.html',code=500,title='ระบบขัดข้องชั่วคราว',message='ZaabOS กำลังมีปัญหาในการประมวลผล กรุณาลองใหม่อีกครั้ง',action='ลองอีกครั้ง'),500

@app.errorhandler(503)
def branded_unavailable(err):
    if request.path.startswith('/api/'): return jsonify(error='ระบบกำลังปรับปรุง กรุณาลองใหม่ภายหลัง'),503
    return render_template('error.html',code=503,title='กำลังปรับปรุงระบบ',message='บริการบางส่วนยังไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้งในอีกสักครู่',action='ลองอีกครั้ง'),503

# =====================================================================
# App bootstrap
# =====================================================================

with app.app_context():
    init_db()

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5300))
    app.run(host='0.0.0.0', port=port, debug=not IS_POSTGRES)
