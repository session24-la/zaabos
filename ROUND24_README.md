# ZaabOS Round 24 — Independent Audit Production Hardening

Basis: `ZAABOS_INDEPENDENT_ACCEPTANCE_FINAL.md` + raw acceptance results supplied by the user.

## Fixed in this release

- ZB-C01 Critical: removed recreation of the legacy one-active-payment unique index. Split-payment data can survive restart/redeploy.
- ZB-H01 High: inventory adjustment now locks the ingredient row on PostgreSQL and records the quantity actually applied.
- ZB-H02 High: item cancellation locks the order-item row before calculating remaining cancellable quantity and restoring recipe stock.
- ZB-M01 Medium: move-table locks the destination table row on PostgreSQL before the occupied check.
- ZB-M02 Medium: split-payment receipt change is calculated against the cash payment leg, not the whole bill.
- ZB-M03 Medium: sending items to kitchen now creates server-side `kitchen_print_jobs` per kitchen station represented in that send.
- ZB-L01 Low: malformed `branch_id` on order list/report summary returns HTTP 400 rather than leaking into a DB 500.
- ZB-L02 Low: order API includes active payment legs and receipts itemize split payment methods/amounts.
- ZB-L03 Low/known UX: Reports, Inventory, and Shift/Cash are promoted to the main navigation on tablet/desktop while remaining available under More on mobile.

## Manual UX carry-ins included

- Receipt guest count gets a wider printable safe area.
- Report payment cards use responsive sizing so Cash/QR totals do not collide.

## Important scope

- `kitchen_print_jobs` is now populated server-side. This does **not** mean a physical thermal printer is connected; a printer agent/device integration is still required for hardware printing.
- No destructive DB reset and no new schema migration are required by this patch.

## Required acceptance after deploy

1. Existing DB with a split-payment bill -> redeploy/restart -> app must boot normally.
2. Five concurrent stock adjustments -> final stock must equal opening + movement ledger sum.
3. Two concurrent cancels of the same item -> recipe stock must be restored only once for the actually cancelled quantity.
4. Two simultaneous move-table requests to the same destination -> only one may succeed.
5. Split bill payment with cash change + QR -> receipt must show both payment legs and correct cash change.
6. Send items to kitchen -> `/api/kitchen/print-jobs` should return pending job(s).
7. `/api/orders?branch_id=abc` and report summary with malformed branch id -> HTTP 400.
8. Check main navigation on desktop/tablet and mobile.
