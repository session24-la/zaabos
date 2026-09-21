from pathlib import Path
import sqlite3, re
r=Path(__file__).parent
a=(r/'app.py').read_text(); j=(r/'static/app.js').read_text(); sw=(r/'static/sw.js').read_text(); h=(r/'templates/index.html').read_text(); pg=(r/'schema_postgres.sql').read_text(); sq=(r/'schema.sql').read_text()
checks={
'latest_migration_27':"record_migration(conn, 27, 'offline_pos_safe_sync')" in a,
'round18_existing_db_fix':'information_schema.columns' in a and 'idx_tenants_subscription' not in pg,
'round22_order_hotfix':all(x in a[a.index('def staff_create_order():'):a.index("@app.put('/api/orders/<int:oid>/status')")] for x in ['client_request_id =','client_device_id =','offline_created_at =']),
'order_idempotency_unique':'uq_orders_tenant_client_request' in a,
'payment_decimal':'money_decimal(base*Decimal' in a and "total != due" in a,
'partial_refund':'remaining_refundable' in a or 'refundable' in a,
'split_payment':"parts=d.get('payments')" in a,
'payment_auto_receipt':('printReceipt(id)' in j or 'printReceipt(orderId)' in j),
'csrf_mutations':"request.method in ('POST', 'PUT', 'DELETE')" in a and 'X-CSRF-Token' in a,
'secure_cookie':'SESSION_COOKIE_SECURE=IS_POSTGRES' in a,
'security_headers':'X-Content-Type-Options' in a and 'Strict-Transport-Security' in a,
'password_change_min10':"len(new) < 10" in a,
'tenant_owner_password_min10':"len(owner_password) < 10" in a,
'user_password_min10':a.count('len(password) < 10')>=1,
'superadmin_password_min12':'len(password) < 12' in a,
'tenant_scoped_order_lookup':"WHERE id=? AND tenant_id=?" in a,
'menu_sidebar':'menu-category-sidebar' in h and 'selectedMenuCategoryId' in j,
'qr_primary_nav':'data-tab="tables" class="nav-primary"' in h,
'format_datetime_defined':'function formatDateTime(value)' in j,
'no_currentUser':'currentUser' not in j,
'offline_indexeddb':'indexedDB.open(ZAABOS_OFFLINE_DB' in j,
'offline_api_not_cached':"u.pathname.startsWith('/api/')" in sw,
'offline_retry':'syncOfflineOrders' in j and 'data-offline-retry' in j,
'health':'/healthz' in a and '/readyz' in a,
'production_readiness':'/api/admin/production-readiness' in a,
'kitchen_station':'kitchen_stations' in a and 'kitchen_station_id' in a,
'inventory':'inventory_movements' in a and 'recipes' in a,
'saas':'saas_plans' in a and 'subscription_status' in a,
'fresh_schema_offline_cols':all(x in sq for x in ['client_request_id TEXT','client_device_id TEXT','offline_created_at TEXT']),
'postgres_schema_offline_cols':all(x in pg for x in ['client_request_id TEXT','client_device_id TEXT','offline_created_at TEXT']),
}
bad=[]
for k,v in checks.items(): print(('PASS ' if v else 'FAIL ')+k); bad += [] if v else [k]
try:
 c=sqlite3.connect(':memory:'); c.executescript(sq); print('PASS fresh_sqlite_schema')
except Exception as e: print('FAIL fresh_sqlite_schema',e); bad.append('fresh_sqlite_schema')
raise SystemExit(1 if bad else 0)
