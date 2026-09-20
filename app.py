from flask import Flask, render_template, request, jsonify, g, session, send_from_directory
import sqlite3, os, functools, secrets, shutil, random, string
from datetime import datetime, date, timedelta
from pathlib import Path
from werkzeug.security import generate_password_hash, check_password_hash

# ---------- dual SQLite/Postgres support (same pattern as CASHFLOW 24) ----------
IS_POSTGRES = bool(os.getenv('DATABASE_URL'))
try:
    import psycopg2, psycopg2.extras
except ImportError:
    psycopg2 = None

INTEGRITY_ERRORS = (sqlite3.IntegrityError,) + ((psycopg2.IntegrityError,) if psycopg2 else ())


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
        add_returning = pg_sql.strip()[:11].upper() == 'INSERT INTO' and 'RETURNING' not in pg_sql.upper()
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
    env_key = os.getenv('ZAABOS_SECRET_KEY')
    if env_key: return env_key
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
    'received': {'preparing','cancelled'},
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

def now(): return datetime.now().isoformat(timespec='seconds')

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
    if not conn.execute("SELECT 1 FROM users WHERE role='super_admin'").fetchone():
        try:
            conn.execute('INSERT INTO users(tenant_id,username,password_hash,display_name,role,must_change_password,created_at) VALUES(NULL,?,?,?,?,1,?)',
                ('admin', hash_password('changeme123'), 'ผู้ดูแลระบบ', 'super_admin', now()))
            conn.commit()
        except INTEGRITY_ERRORS:
            conn.rollback()
    else:
        conn.commit()

def create_tenant_indexes(conn):
    for stmt in (
        'CREATE INDEX IF NOT EXISTS idx_branches_tenant ON branches(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_tables_tenant ON dining_tables(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_menu_items_tenant ON menu_items(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)',
    ):
        conn.execute(stmt)

def ensure_schema_migrations(conn):
    """Additive, idempotent column adds for installs that already have data —
    executescript's CREATE TABLE IF NOT EXISTS only helps on a fresh DB, so any
    new column on an existing table needs to be added here instead."""
    if IS_POSTGRES:
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
        conn.commit()

def init_db():
    if IS_POSTGRES:
        conn = PGConn(os.getenv('DATABASE_URL'))
        conn.executescript((BASE / 'schema_postgres.sql').read_text())
        ensure_default_tenant(conn)
        ensure_super_admin(conn)
        ensure_schema_migrations(conn)
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
    row = conn.execute('SELECT active FROM tenants WHERE id=?', (tenant_id,)).fetchone()
    return bool(row and row['active'])

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
    today = datetime.now().strftime('%Y%m%d')
    prefix = f'Z-{today}-'
    row = conn.execute("SELECT COUNT(*) AS c FROM orders WHERE tenant_id=? AND order_no LIKE ?", (tenant_id, prefix + '%')).fetchone()
    seq = (row['c'] if row else 0) + 1
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
    if len(new) < 6: return jsonify(error='รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร'), 400
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
    rows = conn.execute('SELECT * FROM tenants ORDER BY name').fetchall()
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
    if len(owner_password) < 6: return jsonify(error='รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร'), 400
    conn = db()
    cur = conn.execute('INSERT INTO tenants(name,icon,created_at) VALUES(?,?,?)', (name, '🍽️', now()))
    tenant_id = cur.lastrowid
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
    conn = db()
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
        opts = conn.execute('SELECT * FROM menu_options WHERE group_id=? ORDER BY sort_order,id', (grp['id'],)).fetchall()
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
    cur = conn.execute('''INSERT INTO menu_items(tenant_id,branch_id,category_id,name,description,base_price,image_url,sort_order,
        cost_price,track_stock,stock_qty,low_stock_threshold,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (g.tenant_id, branch_id, d.get('category_id'), name, d.get('description') or '', base_price,
         d.get('image_url'), d.get('sort_order') or 0, cost_price, track_stock, stock_qty, low_stock_threshold, now()))
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
        cur = conn.execute('INSERT INTO menu_option_groups(menu_item_id,name,required,sort_order) VALUES(?,?,?,?)',
            (item_id, gname, 1 if grp.get('required') else 0, gi))
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
    conn.execute('''UPDATE menu_items SET name=?,description=?,base_price=?,category_id=?,image_url=?,
        sold_out=?,sort_order=?,cost_price=?,track_stock=?,stock_qty=?,low_stock_threshold=? WHERE id=?''',
        ((d.get('name') or old['name']).strip(), d.get('description', old['description']), base_price,
         d.get('category_id', old['category_id']), d.get('image_url', old['image_url']),
         1 if d.get('sold_out') else 0, d.get('sort_order', old['sort_order']),
         cost_price, track_stock, stock_qty, low_stock_threshold, mid))
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
    return d

def _validate_and_price_cart(conn, tenant_id, branch_id, cart):
    """Recompute prices server-side from the real menu — never trust client-sent
    totals. Returns (order_items_to_insert, total) or raises ValueError(msg)."""
    if not cart:
        raise ValueError('ตะกร้าว่างเปล่า กรุณาเลือกเมนูก่อนสั่ง')
    prepared = []
    total = 0.0
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
        unit_price = item['base_price']
        chosen_options = []
        groups = conn.execute('SELECT * FROM menu_option_groups WHERE menu_item_id=?', (menu_item_id,)).fetchall()
        selected = line.get('selected_options') or {}  # {group_id: option_id}
        for grp in groups:
            opt_id = selected.get(str(grp['id'])) or selected.get(grp['id'])
            if grp['required'] and not opt_id:
                raise ValueError(f'กรุณาเลือก "{grp["name"]}" สำหรับเมนู {item["name"]}')
            if opt_id:
                opt = conn.execute('SELECT * FROM menu_options WHERE id=? AND group_id=?', (opt_id, grp['id'])).fetchone()
                if not opt:
                    raise ValueError('ตัวเลือกเมนูไม่ถูกต้อง กรุณาโหลดหน้าใหม่')
                unit_price += opt['price_delta']
                chosen_options.append({'group_name': grp['name'], 'option_name': opt['name'], 'price_delta': opt['price_delta']})
        line_total = unit_price * qty
        total += line_total
        prepared.append({
            'menu_item_id': menu_item_id, 'item_name': item['name'], 'quantity': qty,
            'unit_price': unit_price, 'line_total': line_total,
            'notes': (line.get('notes') or '').strip()[:300], 'options': chosen_options,
        })
    return prepared, total

def _decrement_stock(conn, menu_item_id, qty):
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

def _restore_stock(conn, menu_item_id, qty):
    if not menu_item_id or qty <= 0: return
    conn.execute('UPDATE menu_items SET stock_qty=COALESCE(stock_qty,0)+? WHERE id=? AND track_stock=1', (qty, menu_item_id))

def _recalculate_order_total(conn, oid):
    row = conn.execute('SELECT COALESCE(SUM((quantity-COALESCE(cancelled_quantity,0))*unit_price),0) AS total FROM order_items WHERE order_id=?', (oid,)).fetchone()
    total = max(0, float(row['total'] or 0))
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
    if not tenant:
        return jsonify(error='ร้านนี้ปิดให้บริการชั่วคราว'), 404
    categories = [dict(x) for x in conn.execute('SELECT * FROM menu_categories WHERE branch_id=? AND active=1 ORDER BY sort_order,id', (branch_id,))]
    items_rows = conn.execute('SELECT * FROM menu_items WHERE branch_id=? AND active=1 ORDER BY sort_order,id', (branch_id,)).fetchall()
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
    branch = conn.execute('SELECT 1 FROM branches WHERE id=? AND active=1', (branch_id,)).fetchone()
    if not branch:
        return jsonify(error='ไม่พบสาขานี้'), 404
    rows = conn.execute('SELECT id,name FROM dining_tables WHERE branch_id=? AND active=1 ORDER BY id', (branch_id,)).fetchall()
    return jsonify(tables=[dict(x) for x in rows])

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
        prepared_items, total = _validate_and_price_cart(conn, tenant_id, branch_id, d.get('cart') or [])
    except ValueError as e:
        return jsonify(error=str(e)), 400

    order_no, cur = insert_order_row(conn, tenant_id,
        '''INSERT INTO orders(tenant_id,branch_id,order_no,order_type,table_id,table_name_snapshot,
        customer_name,customer_phone,customer_address,total_amount,notes,placed_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        lambda order_no: (tenant_id, branch_id, order_no, order_type, table_id, table_name, customer_name, customer_phone,
         customer_address, total, (d.get('notes') or '').strip()[:500], 'customer', now(), now()))
    order_id = cur.lastrowid
    for it in prepared_items:
        oi_cur = conn.execute('''INSERT INTO order_items(order_id,menu_item_id,item_name_snapshot,quantity,unit_price,line_total,notes)
            VALUES(?,?,?,?,?,?,?)''', (order_id, it['menu_item_id'], it['item_name'], it['quantity'], it['unit_price'], it['line_total'], it['notes']))
        oi_id = oi_cur.lastrowid
        for opt in it['options']:
            conn.execute('INSERT INTO order_item_options(order_item_id,group_name_snapshot,option_name_snapshot,price_delta_snapshot) VALUES(?,?,?,?)',
                (oi_id, opt['group_name'], opt['option_name'], opt['price_delta']))
        _decrement_stock(conn, it['menu_item_id'], it['quantity'])
    conn.commit()
    return jsonify(ok=True, order_no=order_no, order_id=order_id, total_amount=total)

@app.get('/api/public/orders/track')
def public_track_order():
    order_no = (request.args.get('order_no') or '').strip()
    phone = (request.args.get('phone') or '').strip()
    if not order_no or not phone:
        return jsonify(error='กรุณากรอกเลขที่ออเดอร์และเบอร์โทร'), 400
    conn = db()
    order = conn.execute('SELECT * FROM orders WHERE order_no=? AND customer_phone=?', (order_no, phone)).fetchone()
    if not order:
        return jsonify(error='ไม่พบออเดอร์ กรุณาตรวจสอบเลขที่ออเดอร์และเบอร์โทรอีกครั้ง'), 404
    return jsonify(order=_order_with_items(conn, order))

# ---------- staff-side order management ----------

@app.get('/api/orders')
@login_required
def list_orders():
    conn = db()
    if g.tenant_id is None: return jsonify(orders=[])
    status = request.args.get('status')
    branch_id = request.args.get('branch_id')
    q = '''SELECT orders.*, u.display_name AS created_by_name
           FROM orders LEFT JOIN users u ON u.id = orders.created_by_user_id
           WHERE orders.tenant_id=?'''
    args = [g.tenant_id]
    if status: q += ' AND orders.status=?'; args.append(status)
    if branch_id: q += ' AND orders.branch_id=?'; args.append(branch_id)
    q += ' ORDER BY orders.id DESC LIMIT 200'
    rows = conn.execute(q, args).fetchall()
    return jsonify(orders=[_order_with_items(conn, r) for r in rows])

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
        prepared_items, total = _validate_and_price_cart(conn, g.tenant_id, branch_id, d.get('cart') or [])
    except ValueError as e:
        return jsonify(error=str(e)), 400

    order_no, cur = insert_order_row(conn, g.tenant_id,
        '''INSERT INTO orders(tenant_id,branch_id,order_no,order_type,table_id,table_name_snapshot,
        customer_name,customer_phone,customer_address,total_amount,guest_count,notes,placed_by,created_by_user_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        lambda order_no: (g.tenant_id, branch_id, order_no, order_type, table_id, table_name, customer_name, customer_phone,
         customer_address, total, guest_count, (d.get('notes') or '').strip()[:500], 'staff', g.user['id'], now(), now()))
    order_id = cur.lastrowid
    for it in prepared_items:
        oi_cur = conn.execute('''INSERT INTO order_items(order_id,menu_item_id,item_name_snapshot,quantity,unit_price,line_total,notes)
            VALUES(?,?,?,?,?,?,?)''', (order_id, it['menu_item_id'], it['item_name'], it['quantity'], it['unit_price'], it['line_total'], it['notes']))
        oi_id = oi_cur.lastrowid
        for opt in it['options']:
            conn.execute('INSERT INTO order_item_options(order_item_id,group_name_snapshot,option_name_snapshot,price_delta_snapshot) VALUES(?,?,?,?)',
                (oi_id, opt['group_name'], opt['option_name'], opt['price_delta']))
        _decrement_stock(conn, it['menu_item_id'], it['quantity'])
    log_action('staff_create_order', detail=order_no)
    conn.commit()
    return jsonify(ok=True, order_no=order_no, order_id=order_id, total_amount=total)

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
        rows = conn.execute('SELECT * FROM order_items WHERE order_id=?', (oid,)).fetchall()
        for it in rows:
            remaining = max(0, int(it['quantity']) - int(it['cancelled_quantity'] or 0))
            _restore_stock(conn, it['menu_item_id'], remaining)
            conn.execute('UPDATE order_items SET cancelled_quantity=quantity,cancelled_at=COALESCE(cancelled_at,?) WHERE id=?', (now(), it['id']))
    conn.execute('UPDATE orders SET status=?,updated_at=? WHERE id=?', (status, now(), oid))
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
    valid_ids = {r['id'] for r in conn.execute('SELECT id FROM order_items WHERE order_id=?', (oid,)).fetchall()}
    item_ids = [i for i in item_ids if i in valid_ids]
    if not item_ids:
        return jsonify(error='รายการอาหารไม่ถูกต้อง'), 400
    ts = now()
    for iid in item_ids:
        conn.execute('UPDATE order_items SET kitchen_sent_at=? WHERE id=?', (ts, iid))
    log_action('send_order_items_to_kitchen', detail=f'{oid}: {item_ids}')
    conn.commit()
    return jsonify(ok=True, sent_at=ts, item_ids=item_ids)

@app.put('/api/orders/<int:oid>/payment')
@login_required
@role_required('owner', 'manager', 'staff')
def update_order_payment(oid):
    conn = db()
    order = conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?', (oid, g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'), 404
    d = request.get_json() or {}
    payment_status = d.get('payment_status')
    if payment_status not in ('unpaid', 'paid'): return jsonify(error='สถานะการชำระเงินไม่ถูกต้อง'), 400
    if order['status'] == 'cancelled': return jsonify(error='ออเดอร์ที่ยกเลิกแล้วไม่สามารถชำระเงินได้'), 409
    if order['payment_status'] == 'paid' and payment_status == 'paid': return jsonify(error='ออเดอร์นี้ชำระเงินแล้ว'), 409
    if payment_status == 'unpaid' and order['payment_status'] == 'paid':
        return jsonify(error='ไม่สามารถย้อนการชำระเงินโดยตรง กรุณาใช้ขั้นตอนคืนเงิน/void'), 409
    method = (d.get('payment_method') or '').strip()
    if payment_status == 'paid' and method not in PAYMENT_METHODS:
        return jsonify(error='กรุณาเลือกวิธีชำระเงิน'), 400
    def money(key, default=None):
        v=d.get(key, default)
        if v in (None,''): return None
        try: v=float(v)
        except: raise ValueError(f'{key} ไม่ถูกต้อง')
        if v < 0 or v > 1000000000: raise ValueError(f'{key} ไม่ถูกต้อง')
        return v
    try:
        tax=money('tax_amount', order['tax_amount'] or 0) or 0
        cash=money('cash_received')
    except ValueError as e: return jsonify(error=str(e)),400
    due=float(order['total_amount'] or 0)+tax
    if method == 'cash' and (cash is None or cash < due):
        return jsonify(error='จำนวนเงินสดที่รับมาต้องไม่น้อยกว่ายอดชำระ'), 400
    if method != 'cash': cash=None
    ts=now()
    conn.execute('UPDATE orders SET payment_status=?,payment_method=?,tax_amount=?,cash_received=?,paid_at=?,updated_at=? WHERE id=?',
                 ('paid',method,tax,cash,ts,ts,oid))
    conn.execute('INSERT INTO payments(tenant_id,branch_id,order_id,amount,payment_method,cash_received,reference,paid_by_user_id,paid_at) VALUES(?,?,?,?,?,?,?,?,?)',
                 (g.tenant_id,order['branch_id'],oid,due,method,cash,(d.get('reference') or '')[:120],g.user['id'],ts))
    log_action('payment_completed', detail=f'{oid}: {method} {due}')
    conn.commit()
    return jsonify(ok=True, amount=due, payment_method=method, change=max(0,(cash or 0)-due) if method=='cash' else 0)

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
    ids=[]; ts=now()
    for it in prepared:
        cur=conn.execute('INSERT INTO order_items(order_id,menu_item_id,item_name_snapshot,quantity,unit_price,line_total,notes,kitchen_sent_at) VALUES(?,?,?,?,?,?,?,?)',
            (oid,it['menu_item_id'],it['item_name'],it['quantity'],it['unit_price'],it['line_total'],it['notes'],ts))
        iid=cur.lastrowid; ids.append(iid)
        for op in it['options']:
            conn.execute('INSERT INTO order_item_options(order_item_id,group_name_snapshot,option_name_snapshot,price_delta_snapshot) VALUES(?,?,?,?)',(iid,op['group_name'],op['option_name'],op['price_delta']))
        _decrement_stock(conn,it['menu_item_id'],it['quantity'])
    total=_recalculate_order_total(conn,oid); log_action('add_order_items',detail=f'{oid}: {ids}'); conn.commit()
    return jsonify(ok=True,item_ids=ids,total_amount=total)

@app.put('/api/orders/<int:oid>/items/<int:iid>/cancel')
@login_required
@role_required('owner','manager','staff')
def cancel_order_item(oid,iid):
    conn=db(); order=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?',(oid,g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'),404
    if order['payment_status']=='paid' or order['status'] in ('completed','cancelled'): return jsonify(error='ออเดอร์นี้ปิดแล้ว'),409
    it=conn.execute('SELECT * FROM order_items WHERE id=? AND order_id=?',(iid,oid)).fetchone()
    if not it: return jsonify(error='ไม่พบรายการ'),404
    d=request.get_json() or {}; remaining=max(0,int(it['quantity'])-int(it['cancelled_quantity'] or 0))
    try: qty=int(d.get('quantity') or remaining)
    except: return jsonify(error='จำนวนไม่ถูกต้อง'),400
    if qty<1 or qty>remaining: return jsonify(error='จำนวนยกเลิกไม่ถูกต้อง'),400
    new_cancel=int(it['cancelled_quantity'] or 0)+qty
    conn.execute('UPDATE order_items SET cancelled_quantity=?,cancellation_reason=?,cancelled_at=? WHERE id=?',(new_cancel,(d.get('reason') or '')[:200],now(),iid))
    _restore_stock(conn,it['menu_item_id'],qty); total=_recalculate_order_total(conn,oid)
    log_action('cancel_order_item',detail=f'{oid}/{iid}: {qty}'); conn.commit()
    return jsonify(ok=True,total_amount=total,cancelled_quantity=new_cancel)

@app.put('/api/orders/<int:oid>/move-table')
@login_required
@role_required('owner','manager','staff')
def move_order_table(oid):
    conn=db(); order=conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?',(oid,g.tenant_id)).fetchone()
    if not order: return jsonify(error='ไม่พบออเดอร์'),404
    if order['order_type']!='dine_in' or order['status'] in ('completed','cancelled'): return jsonify(error='ออเดอร์นี้ไม่สามารถย้ายโต๊ะได้'),409
    try: table_id=int((request.get_json() or {}).get('table_id'))
    except: return jsonify(error='กรุณาเลือกโต๊ะปลายทาง'),400
    tb=conn.execute('SELECT * FROM dining_tables WHERE id=? AND tenant_id=? AND branch_id=? AND active=1',(table_id,g.tenant_id,order['branch_id'])).fetchone()
    if not tb: return jsonify(error='โต๊ะปลายทางไม่ถูกต้อง'),400
    occupied=conn.execute("SELECT id FROM orders WHERE tenant_id=? AND branch_id=? AND table_id=? AND id<>? AND status NOT IN ('completed','cancelled') LIMIT 1",(g.tenant_id,order['branch_id'],table_id,oid)).fetchone()
    if occupied: return jsonify(error='โต๊ะปลายทางมีออเดอร์อยู่ กรุณาปิดหรือรวมออเดอร์ก่อน'),409
    conn.execute('UPDATE orders SET table_id=?,table_name_snapshot=?,updated_at=? WHERE id=?',(table_id,tb['name'],now(),oid))
    log_action('move_order_table',detail=f'{oid}: {order["table_id"]} -> {table_id}'); conn.commit(); return jsonify(ok=True)

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
    if len(password) < 6: return jsonify(error='รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร'), 400
    conn = db()
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
        if len(d['password']) < 6: return jsonify(error='รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร'), 400
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
    today = date.today().isoformat()
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

    q = '''SELECT COUNT(*) AS c, COALESCE(SUM(total_amount),0) AS subtotal, COALESCE(SUM(tax_amount),0) AS tax,
           COALESCE(SUM(guest_count),0) AS guests
           FROM orders WHERE tenant_id=? AND payment_status='paid' AND status!='cancelled' AND substr(COALESCE(paid_at,created_at),1,10) BETWEEN ? AND ?'''
    args = [g.tenant_id, frm, to]
    if branch_id: q += ' AND branch_id=?'; args.append(branch_id)
    row = conn.execute(q, args).fetchone()
    order_count = row['c'] or 0
    subtotal = row['subtotal'] or 0
    tax = row['tax'] or 0
    guests = row['guests'] or 0
    total_sales = subtotal + tax

    ti_q = '''SELECT oi.item_name_snapshot AS name, SUM(oi.quantity) AS qty, SUM(oi.line_total) AS revenue
              FROM order_items oi JOIN orders o ON o.id=oi.order_id
              WHERE o.tenant_id=? AND o.payment_status='paid' AND o.status!='cancelled' AND substr(COALESCE(o.paid_at,o.created_at),1,10) BETWEEN ? AND ?'''
    ti_args = [g.tenant_id, frm, to]
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
               WHERE tenant_id=? AND substr(paid_at,1,10) BETWEEN ? AND ?'''
    pay_args=[g.tenant_id,frm,to]
    if branch_id: pay_q += ' AND branch_id=?'; pay_args.append(branch_id)
    pay_q += ' GROUP BY payment_method ORDER BY total DESC'
    payment_breakdown=[dict(r) for r in conn.execute(pay_q,pay_args).fetchall()]
    open_q="SELECT COUNT(*) AS c, COALESCE(SUM(total_amount+tax_amount),0) AS total FROM orders WHERE tenant_id=? AND payment_status='unpaid' AND status!='cancelled'"
    open_args=[g.tenant_id]
    if branch_id: open_q+=' AND branch_id=?'; open_args.append(branch_id)
    open_row=conn.execute(open_q,open_args).fetchone()

    return jsonify(
        from_date=frm, to_date=to,
        order_count=order_count, subtotal=subtotal, tax=tax, guests=guests, total_sales=total_sales,
        top_items=top_items,
        expense_total=expense_total, expense_by_category=expense_by_category,
        net_profit=total_sales - expense_total, payment_breakdown=payment_breakdown,
        open_order_count=open_row['c'] or 0, open_order_total=open_row['total'] or 0,
    )

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
    expense_date = (d.get('expense_date') or date.today().isoformat())[:10]
    branch_id = d.get('branch_id') or None
    conn = db()
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

# =====================================================================
# App bootstrap
# =====================================================================

with app.app_context():
    init_db()

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5300))
    app.run(host='0.0.0.0', port=port, debug=not IS_POSTGRES)
