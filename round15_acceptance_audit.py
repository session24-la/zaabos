from pathlib import Path
root=Path(__file__).parent
app=(root/"app.py").read_text()
js=(root/"static/app.js").read_text()
kjs=(root/"static/kitchen.js").read_text()
checks={
"migration23":"round15_acceptance_hardening" in app,
"partial_refund_index":"CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_tenant_order" not in app and "idx_refunds_tenant_order" in app,
"partial_refund_backend":"remaining_refundable" in app and "d.get('amount')" in app,
"partial_refund_ui":"payload.amount=amount" in js,
"split_payment":"d.get('payments')" in app,
"inventory_load":"tab === 'inventory') loadInventory()" in js,
"navigator_runtime":"showTab('orders')" not in js and "showTab('operations')" not in js,
"kitchen_station_backend":"station_id" in app and "mi.kitchen_station_id" in app,
"kitchen_station_frontend":"kitchenStationFilter" in kjs and "station_id" in kjs,
}
bad=[]
for k,v in checks.items():
    print(("PASS " if v else "FAIL ")+k)
    if not v: bad.append(k)
raise SystemExit(1 if bad else 0)
