from pathlib import Path
checks={
 'backend_live_summary':'def _shift_live_summary' in Path('app.py').read_text(),
 'shift_api_summary':'summary=_shift_live_summary' in Path('app.py').read_text(),
 'close_uses_same_summary':"summary=_shift_live_summary(conn,sh,g.user['id'])" in Path('app.py').read_text(),
 'gross_shift_ui':'ยอดรับชำระในกะ' in Path('static/app.js').read_text(),
 'cash_ui':'เงินสดที่ควรมีในลิ้นชัก' in Path('static/app.js').read_text(),
 'midnight_explained':'กะนี้ไม่ตัดยอดตอน 00:00' in Path('static/app.js').read_text(),
 'reopen_quick_shift':'reopenQuickShift' in Path('static/app.js').read_text(),
 'reopen_auto_continue':'await submitReopenOrder()' in Path('static/app.js').read_text(),
 'refund_wording':'เฉพาะบิลที่เคยคืนเงินจริงแล้วเท่านั้น' in Path('templates/index.html').read_text(),
}
for k,v in checks.items(): print(('PASS' if v else 'FAIL'),k)
raise SystemExit(0 if all(checks.values()) else 1)
