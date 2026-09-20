from pathlib import Path
import re, sys
base=Path(__file__).resolve().parent
app=(base/'app.py').read_text()
js=(base/'static/app.js').read_text()
checks={
 'migration 16': "record_migration(conn, 16, 'critical_operations_approval')" in app,
 'manager approval verifier': 'def _critical_approval' in app and "role IN ('owner','manager')" in app,
 'password verified server-side': "verify_password(approver['password_hash'],password)" in app,
 'critical audit writer': 'def _record_critical' in app,
 'cancel item audit': "_record_critical(conn,'cancel_item'" in app,
 'cancel order audit': "_record_critical(conn,'cancel_order'" in app,
 'refund audit': "_record_critical(conn,'refund'" in app,
 'reason required': 'กรุณาระบุเหตุผลการยกเลิกรายการ' in app,
 'reason API': "@app.get('/api/operations/reasons')" in app,
 'staff approval UI': "me.role==='staff'" in js and 'approval_password' in js,
}
for k,v in checks.items(): print(('PASS' if v else 'FAIL'),k)
if not all(checks.values()): sys.exit(1)
print('PASS — Round 14C critical-operation invariants present')
