-- Postgres schema for ZaabOS. Final-state only — a Postgres deployment always
-- starts empty, applied once by init_db(). REAL (SQLite) -> DOUBLE PRECISION
-- (Postgres's own REAL is 4-byte and loses precision on money amounts).

CREATE TABLE IF NOT EXISTS tenants (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name TEXT NOT NULL,
 icon TEXT NOT NULL DEFAULT '🍽️',
 currency TEXT NOT NULL DEFAULT 'LAK',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS branches (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id INTEGER NOT NULL,
 name TEXT NOT NULL,
 icon TEXT NOT NULL DEFAULT '🏠',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS dining_tables (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id INTEGER NOT NULL,
 branch_id INTEGER NOT NULL,
 category_id INTEGER,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 base_price DOUBLE PRECISION NOT NULL DEFAULT 0,
 image_url TEXT,
 sold_out INTEGER NOT NULL DEFAULT 0,
 sort_order INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1,
 cost_price DOUBLE PRECISION NOT NULL DEFAULT 0,
 track_stock INTEGER NOT NULL DEFAULT 0,
 stock_qty INTEGER,
 low_stock_threshold INTEGER NOT NULL DEFAULT 5,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(branch_id) REFERENCES branches(id),
 FOREIGN KEY(category_id) REFERENCES menu_categories(id)
);

CREATE TABLE IF NOT EXISTS menu_option_groups (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 menu_item_id INTEGER NOT NULL,
 name TEXT NOT NULL,
 required INTEGER NOT NULL DEFAULT 0,
 sort_order INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(menu_item_id) REFERENCES menu_items(id)
);

CREATE TABLE IF NOT EXISTS menu_options (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 group_id INTEGER NOT NULL,
 name TEXT NOT NULL,
 price_delta DOUBLE PRECISION NOT NULL DEFAULT 0,
 sort_order INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(group_id) REFERENCES menu_option_groups(id)
);

CREATE TABLE IF NOT EXISTS orders (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id INTEGER NOT NULL,
 branch_id INTEGER NOT NULL,
 order_no TEXT UNIQUE NOT NULL,
 order_type TEXT NOT NULL DEFAULT 'dine_in' CHECK(order_type IN ('dine_in','takeaway','delivery')),
 table_id INTEGER,
 table_name_snapshot TEXT,
 customer_name TEXT NOT NULL DEFAULT '',
 customer_phone TEXT NOT NULL DEFAULT '',
 customer_address TEXT,
 status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','preparing','ready','served','completed','cancelled')),
 payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid')),
 total_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
 tax_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
 cash_received DOUBLE PRECISION,
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
 FOREIGN KEY(created_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_id INTEGER NOT NULL,
 menu_item_id INTEGER,
 item_name_snapshot TEXT NOT NULL,
 quantity INTEGER NOT NULL DEFAULT 1,
 unit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
 line_total DOUBLE PRECISION NOT NULL DEFAULT 0,
 notes TEXT NOT NULL DEFAULT '',
 kitchen_sent_at TIMESTAMP,
 cancelled_quantity INTEGER NOT NULL DEFAULT 0,
 cancellation_reason TEXT NOT NULL DEFAULT '',
 cancelled_at TEXT,
 FOREIGN KEY(order_id) REFERENCES orders(id),
 FOREIGN KEY(menu_item_id) REFERENCES menu_items(id)
);

CREATE TABLE IF NOT EXISTS order_item_options (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_item_id INTEGER NOT NULL,
 group_name_snapshot TEXT NOT NULL,
 option_name_snapshot TEXT NOT NULL,
 price_delta_snapshot DOUBLE PRECISION NOT NULL DEFAULT 0,
 FOREIGN KEY(order_item_id) REFERENCES order_items(id)
);

CREATE TABLE IF NOT EXISTS payments (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id INTEGER NOT NULL,
 branch_id INTEGER NOT NULL,
 order_id INTEGER NOT NULL,
 amount DOUBLE PRECISION NOT NULL,
 payment_method TEXT NOT NULL,
 cash_received DOUBLE PRECISION,
 reference TEXT NOT NULL DEFAULT '',
 paid_by_user_id INTEGER,
 paid_at TEXT NOT NULL,
 FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id INTEGER,
 user_id INTEGER,
 action TEXT NOT NULL,
 detail TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);

-- Manual expense entries (รายจ่าย) for the income/expense report. "Income" side
-- of that report is derived from orders directly — no separate table needed.
CREATE TABLE IF NOT EXISTS expenses (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id INTEGER NOT NULL,
 branch_id INTEGER,
 category TEXT NOT NULL,
 amount DOUBLE PRECISION NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 expense_date TEXT NOT NULL,
 created_by_user_id INTEGER,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(branch_id) REFERENCES branches(id),
 FOREIGN KEY(created_by_user_id) REFERENCES users(id)
);


CREATE TABLE IF NOT EXISTS daily_closings (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, closing_date TEXT NOT NULL,
 opening_cash DOUBLE PRECISION NOT NULL DEFAULT 0, cash_out DOUBLE PRECISION NOT NULL DEFAULT 0,
 expected_cash DOUBLE PRECISION NOT NULL DEFAULT 0, counted_cash DOUBLE PRECISION NOT NULL DEFAULT 0, difference DOUBLE PRECISION NOT NULL DEFAULT 0,
 notes TEXT NOT NULL DEFAULT '', closed_by_user_id INTEGER, closed_at TEXT NOT NULL,
 UNIQUE(tenant_id,branch_id,closing_date)
);


CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, order_id INTEGER NOT NULL, payment_id INTEGER,
    amount DOUBLE PRECISION NOT NULL, reason TEXT NOT NULL DEFAULT '', refunded_by_user_id INTEGER, refunded_at TEXT NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id)
);
