# Round 25 — Operational UX Polish

Source: latest `zaabos-main-3(7).zip` after Round 24.

## Changes
- Replaced Refund native prompt/confirm flow with responsive ZaabOS modal.
- Replaced Reopen native confirm with responsive ZaabOS modal and clear safety explanation.
- Payment Promotion/Manual Discount/Manager Approval moved into a collapsed optional section so the amount/payment controls stay visible first.
- Take-order modal gets sticky header + sticky Confirm Order button and controlled scrolling, reducing accidental loss of position on long menus.
- No database/schema/migration changes.
- Existing backend safety rules remain authoritative (including refunded-order reopen blocking).

## Validation
Run `python -m py_compile app.py` and `node --check static/app.js` before deploy.
