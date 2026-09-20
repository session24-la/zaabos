# Round 14H.1 — POS workflow fixes

- Payment confirmation modal is always above the order-detail modal.
- Cancelling an order closes the detail workspace immediately; cancelled orders remain in History and no longer expose a payment action.
- Cancellation/reduction/reopen critical actions use five quick reason choices plus Other.
- Kitchen has an explicit “← POS / หน้าร้าน” return action instead of an icon-only home button.
- Added auditable “reopen paid bill” workflow: active payment is reversed (never deleted), the order becomes unpaid/served and returns to its table, staff can correct quantity/items and charge again.
- Cash payment reversal requires the operator to have an open shift and is attributed to that shift for drawer reconciliation.
- Reports, daily closing and shift cash sales ignore reversed payments.
- Migration 21 is additive; no DB reset and no deletion of historical payments.
