from pathlib import Path
s=Path('app.py').read_text(); css=Path('static/style.css').read_text()
checks={
'order_number_db_lock': "_lock_tx(conn, 'order_no'" in s and 'pg_advisory_xact_lock' in s,
'login_lock_utc': "datetime.now(timezone.utc) + timedelta(minutes=5)" in s,
'menu_stock_row_lock': "old = _row_for_update(conn, 'SELECT * FROM menu_items" in s,
'waste_row_lock': "def ingredient_waste" in s and "ing=_row_for_update" in s[s.index('def ingredient_waste'):s.index('def ingredient_stock_count')],
'count_row_lock': "def ingredient_stock_count" in s and "ing=_row_for_update" in s[s.index('def ingredient_stock_count'):s.index("@app.get('/api/inventory/counts')")],
'public_rate_limit': "public_order_rate" in s and '429' in s[s.index('def public_create_order'):s.index("@app.post('/api/public/orders/track')")],
'order_line_cap': 'len(cart) > 100' in s,
'branch_validation': "def _query_int_arg" in s,
'csp': 'Content-Security-Policy' in s,
'tablet_nav': 'min-width:641px) and (max-width:999px)' in css and '.pos-nav>.nav-secondary{display:none!important}' in css,
'staff_shift_privacy': "if g.user['role']=='staff'" in s[s.index('def shift_history'):s.index("@app.post('/api/operations/shift/close')")],
}
for k,v in checks.items(): print(('PASS' if v else 'FAIL'),k)
print(f"ROUND28 SOURCE AUDIT: {sum(checks.values())}/{len(checks)} PASS")
raise SystemExit(0 if all(checks.values()) else 1)
