# Round 31 — Table Open Check

Goal: one active payable dine-in bill per table seating while preserving every ordering event as its own kitchen/audit batch.

Acceptance scope:
- QR re-orders and multiple devices at the same table join the same primary open check.
- Kitchen batches remain separate so newly ordered items can be prepared independently.
- Cashier sees a grouped table bill and pays once; split payment still works.
- Receipt totals all batches exactly once.
- Explicit split bills remain separate and later QR orders do not silently undo the split.
- Moving a grouped table bill moves every open batch together.
- Duplicate table payment is rejected atomically.
- After a paid check is closed, a later seating on the same table opens a new primary check.
- Report and shift bill counts use logical bills while preserving underlying order-batch counts for audit.
- Tenant isolation, CSRF, pricing, discounts, tax/service charge, inventory, KDS, refunds and customer-session history must remain compatible.

Validation gates:
- Disposable SQLite route integration must end with `ROUND31_TABLE_OPEN_CHECK_PASS`.
- Disposable PostgreSQL restore-test acceptance must end with `ROUND31_POSTGRES_OPEN_CHECK_PASS`; it also races concurrent QR orders and duplicate payment attempts.
- Production is merged only after both gates pass and the final branch diff is reviewed.
