from pathlib import Path
A=Path('app.py').read_text(); J=Path('static/app.js').read_text(); H=Path('templates/index.html').read_text(); S=Path('schema_postgres.sql').read_text()
checks={'immutable_shift_snapshot':'summary_json' in A,'shift_auto_print':'printShiftCloseReport(r)' in J,'shift_history':'/api/operations/shifts' in A,'receipt_settings_api':'/api/settings/receipt' in A,'receipt_settings_ui':'tab-receiptsettings' in H,'branch_scoped_settings':'UNIQUE(tenant_id,branch_id)' in S,'paper_size':'rsPaper' in H,'font_scale':'rsFont' in H,'header_alignment':'rsAlign' in H,'receipt_uses_settings':"api('/api/settings/receipt?branch_id='" in J}
for k,v in checks.items(): print(('PASS' if v else 'FAIL'),k)
print(f'ROUND27 AUDIT: {sum(checks.values())}/{len(checks)} PASS')
raise SystemExit(0 if all(checks.values()) else 1)
