# ZaabOS V2 Round 8

- Hardened both staff/mobile and public order creation with transaction rollback and JSON errors.
- Added explicit checks for returned order/order-item IDs.
- Kept the PostgreSQL-safe CASE/WHEN stock decrement.
- Redesigned the 80mm receipt for a clean restaurant layout: centered brand, table/guest/order metadata, aligned qty-item-price rows, totals, PAID marker, payment details and timestamps.
- No database reset and no destructive migration.
