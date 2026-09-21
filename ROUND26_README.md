# ZaabOS Round 26 — Live Shift Dashboard & Cash Reopen Flow

Source: `zaabos-main-4(3).zip`

## Changes
- Shift/Cash now exposes a live summary from shift-open time until now; it does not reset at midnight.
- Live cards: gross received, bill count, cash, QR/transfer, refunds, net received, expected cash drawer, opening cash/cash-in/cash-out.
- Close Shift uses the same backend summary calculation as the live dashboard to avoid UI/closing reconciliation drift.
- Cash bill Reopen: if no shift is open, the Reopen modal now explains the real cause, lets the cashier enter opening cash, opens a shift, and automatically continues the same Reopen operation.
- Refund warning wording now applies only to bills that actually have a refund.

## No schema changes
No DB reset and no migration is required.

## Verification
- `python -m py_compile app.py` PASS
- `node --check static/app.js` PASS
- `node --check static/sw.js` PASS
- `python round26_shift_audit.py` 9/9 PASS
- Round 24 regression audit 11/11 PASS

## Manual acceptance after deploy
1. Open a shift with opening cash.
2. Make Cash + QR sales and confirm live shift totals update.
3. Add cash-in/cash-out and confirm expected drawer updates.
4. Refund and confirm refund/net figures update.
5. Close shift and compare expected cash with the live expected cash immediately before close.
6. With no shift open, Reopen a cash-paid non-refunded bill. Enter opening cash in the Reopen modal; it should open the shift and continue reopening automatically.
7. A genuinely refunded bill must remain blocked from Reopen.
