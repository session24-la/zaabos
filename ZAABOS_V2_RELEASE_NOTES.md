# ZaabOS V2 — Round 4: Money + Closing + Kitchen/Favicon Fix

## Fixed
- Kitchen flow clarified: newly confirmed orders and newly added items are already sent automatically by setting `kitchen_sent_at`. The staff UI no longer asks to resend items that were already sent.
- Legacy/unsent items can still be selected and sent manually.
- Removed the misleading quick “mark paid” action; payment must go through the payment dialog with a real payment method.
- Safari/macOS favicon now uses PNG + ICO + cache-busted URLs (`v=4`) on every web surface.
- Apple touch icon and manifest links are included consistently.

## Money / reports
- Added average bill and open/unpaid bill totals.
- Added payment-method breakdown (cash / QR / card / bank transfer / other).
- Added daily cash closing for owner/manager: opening cash, cash sales, cash-out, expected cash, counted cash, difference and notes.
- Daily closing is tenant + branch + date scoped and is auditable.

## Database safety
- Additive `daily_closings` table only. No reset or destructive migration.
- Existing PostgreSQL data is preserved.

## Validation performed locally
- Python syntax/compile check.
- JavaScript syntax check.
- SQLite schema creation check.
- ZIP integrity check.

## Important
- A live Railway/PostgreSQL transaction test cannot be truthfully claimed until deployed to the user's Railway environment.
- Safari may keep an old favicon in an already-open tab; this release changes the asset URL so a reload/new tab should request the new icon.
