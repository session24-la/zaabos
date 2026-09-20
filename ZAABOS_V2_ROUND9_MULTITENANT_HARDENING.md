# ZaabOS V2 Round 9 — Multi-Tenant Hardening

## Root cause fixed
Production PostgreSQL had a global UNIQUE constraint on `orders.order_no`.
That made another tenant's `Z-YYYYMMDD-0001` collide with the first tenant.

## Changes
- Existing PostgreSQL: drops only the legacy `orders_order_no_key` constraint.
- Adds `UNIQUE (tenant_id, order_no)` as an index; existing order rows are preserved.
- Fresh PostgreSQL/SQLite schemas now define order numbers as tenant-scoped.
- Daily order-number generation uses the highest existing suffix inside that tenant,
  not COUNT(), so deleted/gapped orders do not cause duplicate-number loops.
- Existing collision retry remains in place for simultaneous confirmations.
- Public tracking refuses ambiguous cross-tenant order-number/phone matches rather
  than returning data from the wrong shop.
- No database reset. No order deletion. No destructive table rebuild.

## Expected behavior
Tenant A can have Z-20260920-0001.
Tenant B can independently have Z-20260920-0001.
Within one tenant, the same order number cannot exist twice.
