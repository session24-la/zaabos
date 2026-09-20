from pathlib import Path
root=Path(__file__).resolve().parent
app=(root/'app.py').read_text()
a=(root/'static/app.js').read_text(); o=(root/'static/order.js').read_text()
checks={
 'migration15': "record_migration(conn, 15, 'restaurant_menu_modifiers')" in app,
 'selection_type': 'selection_type' in app,
 'server_min': 'len(opt_ids) < min_select' in app,
 'server_max': 'len(opt_ids) > max_select' in app,
 'server_active': 'group_id=? AND active=1' in app,
 'staff_multi': "g.selection_type === 'multiple'" in a and 'checked.length > maxSel' in a,
 'customer_multi': "g.selection_type === 'multiple'" in o and 'checked.length > maxSel' in o,
}
for k,v in checks.items(): print(('PASS' if v else 'FAIL'), k)
if not all(checks.values()): raise SystemExit(1)
print('PASS — Round 14B modifier invariants present')
