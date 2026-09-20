from pathlib import Path
s=Path('app.py').read_text()
js=Path('static/app.js').read_text()
track=Path('static/track.js').read_text()
checks={
 'migration19': "record_migration(conn, 19, 'independent_audit_fixes')" in s,
 'report_delivery_sum': 'COALESCE(SUM(delivery_fee),0) AS delivery' in s and 'total_sales = subtotal - discount + service + tax + delivery' in s,
 'public_menu_tenant_scope': "menu_items WHERE tenant_id=? AND branch_id=?" in s and "menu_categories WHERE tenant_id=? AND branch_id=?" in s,
 'menu_branch_ownership': "SELECT id FROM branches WHERE id=? AND tenant_id=? AND active=1" in s,
 'menu_category_ownership': "SELECT id FROM menu_categories WHERE id=? AND tenant_id=? AND branch_id=? AND active=1" in s,
 'quantity_critical_approval': "_record_critical(conn,'reduce_item_quantity'" in s and "approved_by, approval_err = _critical_approval(conn, d)" in s,
 'readiness_auth': "@app.get('/api/admin/production-readiness')\n@login_required\n@super_admin_required" in s,
 'password_min10': s.count('รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร') >= 2,
 'merge_source_recalc': '_recalculate_order_total(conn,source_id)' in s,
 'tracking_post': "@app.post('/api/public/orders/track')" in s and "fetch('/api/public/orders/track', { method:'POST'" in track,
 'report_delivery_ui': 'fmtMoney(s.delivery_fee||0)' in js,
}
for k,v in checks.items(): print(('PASS' if v else 'FAIL'), k)
if not all(checks.values()): raise SystemExit(1)
print('PASS — Round 14F independent-audit fixes present')
