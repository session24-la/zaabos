from pathlib import Path
r=Path(__file__).parent;a=(r/'app.py').read_text();j=(r/'static/app.js').read_text();sw=(r/'static/sw.js').read_text();pg=(r/'schema_postgres.sql').read_text()
checks={
'migration27':"record_migration(conn, 27, 'offline_pos_safe_sync')" in a,
'idempotency_column':'client_request_id' in pg and 'client_request_id' in a,
'idempotency_unique':'uq_orders_tenant_client_request' in a,
'idempotency_lookup':"WHERE tenant_id=? AND client_request_id=?" in a,
'indexeddb':"indexedDB.open(ZAABOS_OFFLINE_DB" in j,
'cached_session':'cacheOfflineSession' in j and 'restoreOfflineSession' in j,
'outbox':'queueOfflineOrder' in j and "offlineAll('outbox')" in j,
'auto_sync':'syncOfflineOrders' in j and 'setInterval' in j,
'device_id':'zaabos_device_id' in j,
'api_never_cached':"u.pathname.startsWith('/api/')" in sw,
'app_shell_offline':"caches.match('/')||await caches.match('/offline')" in sw,
'no_offline_payment':"endpoint = addItemsOrderId" in j,
}
bad=[]
for k,v in checks.items():print(('PASS ' if v else 'FAIL ')+k);bad+=[] if v else [k]
raise SystemExit(1 if bad else 0)
