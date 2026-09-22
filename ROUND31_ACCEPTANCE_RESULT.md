# Round 31 Acceptance Result

Feature: one open payable dine-in bill per occupied table.

Validated in isolated Railway SQLite integration so far:
- repeated QR order from a second phone appends to the same order number
- one normal open bill remains per table
- item rows from each ordering round remain separate for kitchen item state
- both phones using the physical table QR can view the same current bill
- a different table stays isolated
- legacy/default duplicate open orders converge into the primary bill
- explicit staff split bills stay separate
- adding a new round to a served bill reactivates it for KDS visibility
- once all normal/split bills on the seating are closed, the next QR submit starts a fresh bill

Final merge gate additionally requires the full source/regression suite to emit `ROUND31_FULL_REGRESSION_PASS`.
