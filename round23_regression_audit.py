from pathlib import Path
p=Path(__file__).resolve().parent
app=(p/'app.py').read_text(encoding='utf-8')
js=(p/'static/app.js').read_text(encoding='utf-8')
kjs=(p/'static/kitchen.js').read_text(encoding='utf-8')
kh=(p/'templates/kitchen.html').read_text(encoding='utf-8')
checks={
 'inventory_explicit_tenant':'def _apply_recipe_inventory(conn, tenant_id,' in app and '(tenant_id,menu_item_id)).fetchall()' in app,
 'refund_pg_lock':"def refund_order(oid):" in app and "lock_suffix=' FOR UPDATE' if IS_POSTGRES else ''" in app[app.index('def refund_order(oid):'):app.index("@app.post('/api/orders/<int:source_id>/merge')")],
 'split_pg_lock':"lock_suffix=' FOR UPDATE' if IS_POSTGRES else ''" in app[app.index('def split_order(source_id):'):app.index("@app.get('/api/kitchen/stations')")],
 'bill_manager_real_state':'boardTables' not in js and 'allOrders' not in js and 'branchTables().filter' in js and '(activeOrders||[]).filter' in js,
 'kds_station_element':'id="kitchenStationFilter"' in kh and 'if(kitchenStationFilter)' in kjs,
 'public_subscription_gate':app.count("tenant_active(conn, tenant_id)")>=3,
 'manual_discount_decimal':"discount=Decimal('0.00')" in app,
 'branch_validation':app.count("return jsonify(error='สาขาไม่ถูกต้อง'),400")>=3,
 'production_secret_required':"ZAABOS_SECRET_KEY is required when PostgreSQL/production mode is enabled" in app,
 'cart_decimal':"total = Decimal('0.00')" in app and "unit_price = money_decimal(item['base_price'])" in app,
 'offline_auth_not_restored':"(e.transient || !e.status) && await restoreOfflineSession()" in js and 'err.status=401' in js,
 'quota_pg_lock':app.count("(' FOR UPDATE' if IS_POSTGRES else '')")>=2,
 'add_table_cleanup':"client_request_id" not in app[app.index('def add_table():'):app.index("@app.post('/api/tables/bulk')")],
}
for k,v in checks.items(): print(('PASS ' if v else 'FAIL ')+k)
raise SystemExit(0 if all(checks.values()) else 1)
