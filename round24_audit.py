from pathlib import Path
root=Path(__file__).resolve().parent
app=(root/'app.py').read_text()
js=(root/'static/app.js').read_text()
html=(root/'templates/index.html').read_text()
css=(root/'static/style.css').read_text()
checks={
 'critical_unique_index_not_recreated': 'CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_tenant_order_active' not in app,
 'inventory_row_lock': "ing_sql='SELECT * FROM ingredients" in app and "FOR UPDATE" in app,
 'cancel_item_row_lock': "item_sql='SELECT * FROM order_items" in app,
 'move_table_row_lock': "table_sql='SELECT * FROM dining_tables" in app,
 'kitchen_print_job_insert': 'INSERT INTO kitchen_print_jobs' in app,
 'branch_id_400': app.count("branch_id ไม่ถูกต้อง") >= 2,
 'order_payload_payments': "d['payments']" in app,
 'split_receipt_cash_leg': 'cashDue' in js and 'paymentBreakdown' in js,
 'desktop_ops_navigation': 'nav-secondary' in html and 'data-tab="inventory" class="nav-primary nav-secondary"' in html,
 'receipt_guest_safe_area': '12mm!important' in css,
 'payment_cards_responsive': '#tab-reports .payment-cards' in css and 'overflow-wrap:anywhere' in css,
}
for k,v in checks.items(): print(('PASS' if v else 'FAIL'),k)
if not all(checks.values()): raise SystemExit(1)
print(f'ROUND24 AUDIT: {sum(checks.values())}/{len(checks)} PASS')
