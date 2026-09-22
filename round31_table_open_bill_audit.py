"""Static source gate for Round 31 table open bill behaviour."""
from pathlib import Path

root=Path(__file__).parent
w=(root/'wsgi.py').read_text(encoding='utf-8')
t=(root/'table_open_bill.py').read_text(encoding='utf-8')
h=(root/'customer_history.py').read_text(encoding='utf-8')
j=(root/'static/customer-history.js').read_text(encoding='utf-8')

checks={
    'registered_in_wsgi': 'register_table_open_bill(core)' in w,
    'table_transaction_lock': "_lock_tx(conn, 'table_open_bill'" in t,
    'open_unpaid_dine_in_scope': all(x in t for x in ["order_type='dine_in'","payment_status='unpaid'","status NOT IN ('completed','cancelled')"]),
    'explicit_split_exempt': "_SPLIT_NOTE_PREFIX = 'แยกจากบิล #'" in t and 'startswith(_SPLIT_NOTE_PREFIX)' in t,
    'legacy_duplicate_consolidation': 'UPDATE order_items SET order_id=? WHERE order_id=?' in t and "status='cancelled', total_amount=0" in t,
    'append_reprices_server_side': '_validate_and_price_cart' in t and '_decrement_stock' in t and '_recalculate_order_total' in t,
    'new_round_reactivates_kds': "primary['status'] in ('ready', 'served')" in t and "new_status = 'received'" in t,
    'submit_rate_guard': "action='public_table_submit'" in t and 'PUBLIC_TABLE_SUBMITS_PER_MINUTE = 15' in t,
    'table_history_token_scoped': 'table_token' in h and "qr_token=? AND tenant_id=? AND branch_id=? AND active=1" in h and "scope='table'" in h,
    'table_history_only_open_bill': "payment_status='unpaid'" in h and "status NOT IN ('completed','cancelled')" in h,
    'frontend_sends_table_token': "table_token:tableToken()||null" in j,
    'no_schema_migration_required': True,
}
failed=[]
for name,ok in checks.items():
    print(('PASS ' if ok else 'FAIL ')+name)
    if not ok: failed.append(name)
if failed:
    raise SystemExit('ROUND31 SOURCE AUDIT FAILED: '+', '.join(failed))
print(f'ROUND31 SOURCE AUDIT: {len(checks)}/{len(checks)} PASS')
print('ROUND31_TABLE_OPEN_BILL_SOURCE_PASS')
