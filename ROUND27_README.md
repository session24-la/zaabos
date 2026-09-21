# ZaabOS Round 27 — Shift Closing Slip + Shop/Receipt Settings

Source: `zaabos-main-3(8).zip` (already contains Round 26).

## Added
- Automatic printable **Shift Closing Report** immediately after closing a shift.
- Closed-shift accounting snapshot stored immutably (`summary_json`) so later payment reversals do not rewrite the historical closing report.
- Last 30 closed shifts can be viewed and reprinted from `กะ & เงินสด`.
- New branch-scoped `ตั้งค่าร้าน & ใบเสร็จ` workspace.
- Configure receipt shop name, branch display name, subtitle, address, phone, tax ID and footer.
- Configure 80mm/58mm paper, small/normal/large font and left/center header alignment.
- Toggle branch, guest count, cashier, payment breakdown, order time and paid time.
- Live receipt preview before saving.
- Normal customer receipts now load the saved settings for that branch.

## Database
Additive migration only. No reset and no destructive migration.
- `receipt_settings` table, unique per tenant + branch.
- `work_shifts.summary_json` for immutable close-shift accounting snapshots.

## Permissions
- Owner / Manager: edit receipt settings.
- Staff: read receipt settings and use/print shift reports.

## Validation
- `python -m py_compile app.py` PASS
- `node --check static/app.js` PASS
- `node --check static/sw.js` PASS
- `round27_audit.py` 10/10 PASS
- Round 24 regression audit 11/11 PASS

## Runtime acceptance after Railway deploy
1. Open shift, make Cash + QR sales, refund if desired, then close shift.
2. Verify print dialog opens with Shift Closing Report and expected/count/difference values.
3. Reopen `กะ & เงินสด` → `ประวัติกะ & พิมพ์สรุปย้อนหลัง` and reprint the closed shift.
4. Open `เพิ่มเติม` → `ตั้งค่าร้าน & ใบเสร็จ`, change shop/branch/footer/font/paper/alignment and save.
5. Pay a new order and verify the printed customer receipt uses the branch settings.
6. Switch branch and verify settings are independent per branch.
