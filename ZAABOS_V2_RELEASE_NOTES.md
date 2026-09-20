# ZaabOS V2 core production patch

This patch is based on the uploaded `zaabos-main.zip`.

Implemented in this build:
- ZaabOS favicon + install manifest on admin/customer/kitchen/tracking pages.
- Payment methods: cash, QR, card, bank transfer, other.
- Cash validation and change calculation; non-cash payments do not require cash received.
- Immutable payment records in a new `payments` table.
- Duplicate payment protection; a paid order cannot simply be toggled back to unpaid.
- Paid timestamp and payment-method storage on orders.
- Sales reports now count paid orders, not every non-cancelled open order.
- Payment-method breakdown and open/unpaid totals added to report API.
- Order status transition validation (prevents arbitrary backwards jumps).
- Full-order cancellation restores remaining tracked stock once.
- Item-level cancellation API restores only cancelled stock and recalculates order total.
- Add-items-to-existing-order API; newly added items receive a new kitchen timestamp and stock deduction.
- Move-table API with tenant/branch validation and occupied-table protection.
- Additive PostgreSQL/SQLite migrations; existing production data is not reset.
- Fresh-install schemas updated to match migrations.

New API endpoints:
- POST `/api/orders/<order_id>/items`
- PUT `/api/orders/<order_id>/items/<item_id>/cancel`
- PUT `/api/orders/<order_id>/move-table`

Important deployment notes:
1. Deploy normally to Railway; startup schema migration is additive.
2. Back up the production PostgreSQL database before first V2 deploy.
3. Existing historical orders already marked `paid` remain visible in paid-sales reports via `COALESCE(paid_at, created_at)`. Historical payment-method breakdown cannot be reconstructed because old rows never stored a payment method.
4. This build adds the backend foundation for order editing and table moves. A larger dedicated POS editing UI (menu picker inside an existing order, merge/split bills, daily cash closing, refunds) is still a later UI/workflow phase rather than being falsely marked complete here.

Validation performed in the build environment:
- Python source compiles (`py_compile`).
- Browser JS parses (`node --check`).
- Fresh SQLite schema executes successfully.
- Full Flask/PostgreSQL integration test was not run in this build environment because Flask/PostgreSQL runtime dependencies are not installed here. Test on Railway staging/production after database backup.
