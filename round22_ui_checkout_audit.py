from pathlib import Path
r=Path(__file__).parent
j=(r/'static/app.js').read_text(); h=(r/'templates/index.html').read_text(); c=(r/'static/style.css').read_text()
checks={
'format_datetime_fixed':'function formatDateTime(value)' in j,
'current_user_fixed':'currentUser' not in j,
'payment_auto_print':'printReceipt(orderId);' in j and "const fresh=await api('/api/orders?branch_id='" in j,
'menu_sidebar':'menu-category-sidebar' in h,
'menu_workspace':'menu-items-workspace' in h,
'category_filter':'selectedMenuCategoryId' in j and "filter(it=>Number(it.category_id)" in j,
'image_cards':'menu-card-media' in j and 'menu-photo-placeholder' in j,
'tables_qr_primary':h.index('data-tab="tables" class="nav-primary"') < h.index('data-tab="history" class="nav-primary"'),
'no_tables_duplicate_more':h.count('data-tab="tables"')==1,
'responsive_menu':'@media(max-width:760px)' in c,
}
bad=[]
for k,v in checks.items():print(('PASS ' if v else 'FAIL ')+k);bad+=[] if v else [k]
raise SystemExit(1 if bad else 0)
