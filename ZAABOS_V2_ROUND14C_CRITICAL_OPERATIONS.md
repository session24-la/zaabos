# ZaabOS Round 14C — Critical Operations & Manager Approval

## Added
- Critical actions now create dedicated immutable-style audit rows in `critical_operations`.
- Cancelling an item requires a real reason.
- Cancelling a whole order requires a real reason.
- Full refund remains Owner/Manager only and is now also written to critical-operation history.
- When a Staff user cancels an item/order, Owner/Manager credentials are required and verified by the backend. Sending an approver ID from the browser is not trusted.
- Operations screen shows performer, approver, reason and timestamp for Owner/Manager.
- Added operation-reason APIs so predefined reason buttons/dropdowns can be built without changing the audit model.
- Migration ledger version 16: `critical_operations_approval`.

## Compatibility / safety
- No database reset and no destructive migration.
- Existing orders/payments/refunds are preserved.
- Round 9–15 protections remain in place.
- Refund is still full-refund/one-refund-per-order, matching the current ZaabOS payment model.

## Acceptance test
1. Login as Staff and try to cancel an item. Enter a reason; invalid manager credentials must fail.
2. Repeat with a valid Owner/Manager account; cancellation must succeed and stock/total remain correct.
3. Login as Manager and cancel an open order with a reason; no second approval credential is needed, but the action must be audited.
4. Refund a paid order as Manager; verify the refund and critical-operation history both exist.
5. Open `กะ & เงินสด` as Owner/Manager and verify performer, approver, reason and time are visible.
