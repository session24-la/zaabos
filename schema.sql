-- ZaabOS — restaurant ordering & table-service system
-- SQLite schema (final-state; fresh installs only, no legacy migration needed)

CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🍽️',
    currency TEXT NOT NULL DEFAULT 'LAK',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('super_admin','owner','manager','staff')),
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
);

-- A tenant (restaurant business) can run more than one physical location.
CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🏠',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS dining_tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    qr_token TEXT UNIQUE NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(branch_id) REFERENCES branches(id)
);

CREATE TABLE IF NOT EXISTS menu_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🍜',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(branch_id) REFERENCES branches(id)
);

CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    category_id INTEGER,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    base_price REAL NOT NULL DEFAULT 0,
    image_url TEXT,
    sold_out INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    cost_price REAL NOT NULL DEFAULT 0,
    track_stock INTEGER NOT NULL DEFAULT 0,
    stock_qty INTEGER,
    low_stock_threshold INTEGER NOT NULL DEFAULT 5,
 kitchen_station_id INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(branch_id) REFERENCES branches(id),
    FOREIGN KEY(category_id) REFERENCES menu_categories(id)
);

-- e.g. "ขนาด" (size) or "ความเผ็ด" (spice level) — a group of choices for one menu item
CREATE TABLE IF NOT EXISTS menu_option_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 0,
    selection_type TEXT NOT NULL DEFAULT 'single',
    min_select INTEGER NOT NULL DEFAULT 0,
    max_select INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(menu_item_id) REFERENCES menu_items(id)
);

-- e.g. "เล็ก / กลาง / ใหญ่" within the "ขนาด" group
CREATE TABLE IF NOT EXISTS menu_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price_delta REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(group_id) REFERENCES menu_option_groups(id)
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    order_no TEXT NOT NULL,
    order_type TEXT NOT NULL DEFAULT 'dine_in' CHECK(order_type IN ('dine_in','takeaway','delivery')),
    table_id INTEGER,
    table_name_snapshot TEXT,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    customer_address TEXT,
    scheduled_for TEXT,
    fulfillment_status TEXT NOT NULL DEFAULT 'pending',
    delivery_fee REAL NOT NULL DEFAULT 0,
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    driver_name TEXT NOT NULL DEFAULT '',
    driver_phone TEXT NOT NULL DEFAULT '',
    delivery_note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','preparing','ready','served','completed','cancelled')),
    payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid')),
    total_amount REAL NOT NULL DEFAULT 0,
    tax_amount REAL NOT NULL DEFAULT 0,
    service_charge_amount REAL NOT NULL DEFAULT 0,
    discount_amount REAL NOT NULL DEFAULT 0,
    discount_label TEXT NOT NULL DEFAULT '',
    promotion_id INTEGER,
    cash_received REAL,
    payment_method TEXT,
    paid_at TEXT,
    guest_count INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    placed_by TEXT NOT NULL DEFAULT 'customer' CHECK(placed_by IN ('customer','staff')),
    created_by_user_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(branch_id) REFERENCES branches(id),
    FOREIGN KEY(table_id) REFERENCES dining_tables(id),
    FOREIGN KEY(created_by_user_id) REFERENCES users(id),
 UNIQUE(tenant_id, order_no)
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    menu_item_id INTEGER,
    item_name_snapshot TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    kitchen_sent_at TEXT,
    cancelled_quantity INTEGER NOT NULL DEFAULT 0,
    cancellation_reason TEXT NOT NULL DEFAULT '',
    cancelled_at TEXT,
    FOREIGN KEY(order_id) REFERENCES orders(id),
    FOREIGN KEY(menu_item_id) REFERENCES menu_items(id)
);

CREATE TABLE IF NOT EXISTS order_item_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_item_id INTEGER NOT NULL,
    group_name_snapshot TEXT NOT NULL,
    option_name_snapshot TEXT NOT NULL,
    price_delta_snapshot REAL NOT NULL DEFAULT 0,
    FOREIGN KEY(order_item_id) REFERENCES order_items(id)
);

CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 tenant_id INTEGER NOT NULL,
 branch_id INTEGER NOT NULL,
 order_id INTEGER NOT NULL,
 amount REAL NOT NULL,
 payment_method TEXT NOT NULL,
 cash_received REAL,
 reference TEXT NOT NULL DEFAULT '',
 paid_by_user_id INTEGER,
 reversed_at TEXT,
 reversed_by_user_id INTEGER,
 reversal_reason TEXT NOT NULL DEFAULT '',
 reversed_shift_id INTEGER,
 paid_at TEXT NOT NULL,
 FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_payments_reversed_shift
ON payments(tenant_id, reversed_shift_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

-- Manual expense entries (รายจ่าย) for the income/expense report. "Income" side
-- of that report is derived from orders directly — no separate table needed.
CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    expense_date TEXT NOT NULL,
    created_by_user_id INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(branch_id) REFERENCES branches(id),
    FOREIGN KEY(created_by_user_id) REFERENCES users(id)
);


CREATE TABLE IF NOT EXISTS daily_closings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, closing_date TEXT NOT NULL,
 opening_cash REAL NOT NULL DEFAULT 0, cash_out REAL NOT NULL DEFAULT 0,
 expected_cash REAL NOT NULL DEFAULT 0, counted_cash REAL NOT NULL DEFAULT 0, difference REAL NOT NULL DEFAULT 0,
 notes TEXT NOT NULL DEFAULT '', closed_by_user_id INTEGER, closed_at TEXT NOT NULL,
 UNIQUE(tenant_id,branch_id,closing_date)
);


CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, order_id INTEGER NOT NULL, payment_id INTEGER,
    amount REAL NOT NULL, reason TEXT NOT NULL DEFAULT '', refunded_by_user_id INTEGER, refunded_at TEXT NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
 version INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 applied_at TEXT NOT NULL
);

-- Round 14A restaurant operations
CREATE TABLE IF NOT EXISTS work_shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, opened_by_user_id INTEGER NOT NULL, closed_by_user_id INTEGER, opened_at TEXT NOT NULL, closed_at TEXT, opening_cash REAL NOT NULL DEFAULT 0, counted_cash REAL, expected_cash REAL, difference REAL, status TEXT NOT NULL DEFAULT 'open', notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS cash_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, shift_id INTEGER NOT NULL, movement_type TEXT NOT NULL, amount REAL NOT NULL, reason TEXT NOT NULL, created_by_user_id INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operation_reasons (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, operation_type TEXT NOT NULL, label TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS critical_operations (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER, operation_type TEXT NOT NULL, entity_type TEXT NOT NULL DEFAULT '', entity_id INTEGER, reason_id INTEGER, reason_text TEXT NOT NULL DEFAULT '', performed_by_user_id INTEGER NOT NULL, approved_by_user_id INTEGER, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);

-- Round 14D pricing/promotions
CREATE TABLE IF NOT EXISTS pricing_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, tax_rate REAL NOT NULL DEFAULT 0, service_charge_rate REAL NOT NULL DEFAULT 0, updated_by_user_id INTEGER, updated_at TEXT NOT NULL, UNIQUE(tenant_id,branch_id));
CREATE TABLE IF NOT EXISTS promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER, code TEXT NOT NULL, name TEXT NOT NULL, discount_type TEXT NOT NULL DEFAULT 'percent', discount_value REAL NOT NULL DEFAULT 0, min_spend REAL NOT NULL DEFAULT 0, max_discount REAL, starts_at TEXT, ends_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_by_user_id INTEGER, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_promotions_tenant_code ON promotions(tenant_id,code);

CREATE TABLE IF NOT EXISTS kitchen_stations (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'unit', stock_qty REAL NOT NULL DEFAULT 0, low_stock_threshold REAL NOT NULL DEFAULT 0, cost_per_unit REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, menu_item_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL, quantity REAL NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recipe_menu_ingredient ON recipes(tenant_id,menu_item_id,ingredient_id);
CREATE TABLE IF NOT EXISTS inventory_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL, movement_type TEXT NOT NULL, quantity REAL NOT NULL, reason TEXT NOT NULL DEFAULT '', order_id INTEGER, created_by_user_id INTEGER, created_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_order_items_order_active ON order_items(order_id,cancelled_quantity);
