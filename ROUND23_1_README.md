# ZaabOS Round 23.1 — Table Move & Item Transfer UX

Based on the latest uploaded `zaabos-main-3(5).zip`.

## Fixed
- Whole-bill Move Table no longer uses a numeric browser prompt.
- Destination is selected by a real table card and actual `table_id`.
- Occupied tables are visible but disabled for whole-bill moves.
- Backend already blocks moving a whole bill onto an occupied table; UI now matches that rule.
- No silent/automatic fallback to the next table.
- Bill Manager uses the correct `/api/orders/<id>/move-table` endpoint.
- Added selective item transfer: choose item quantities and move them into an existing open unpaid table/bill.
- Selective transfer reuses the split transaction and does not decrement inventory or resend kitchen items.
- Still requires at least one active item to remain in the source bill; use Move/Merge for the whole bill.
- Existing “split into new bill” remains available.
- Desktop nav restored to 5 primary columns after Tables & QR was added.
- More menu is a compact anchored popover instead of a detached left-side panel.

No database migration or reset.
