from pathlib import Path
p=Path(__file__).parent
a=(p/'app.py').read_text()
js=(p/'static/app.js').read_text()
checks={
'migration18':"record_migration(conn, 18, 'fulfillment_delivery_preorder')" in a,
'scheduled_for':'scheduled_for' in a,
'delivery_fee_payment':"+delivery_fee" in a,
'fulfillment_endpoint':"/api/orders/<int:oid>/fulfillment" in a,
'staff_schedule':'takeOrderScheduledFor' in js,
'delivery_actions':'out_for_delivery' in js,
}
for k,v in checks.items(): print(('PASS' if v else 'FAIL'),k)
raise SystemExit(0 if all(checks.values()) else 1)
