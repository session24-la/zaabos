# ZaabOS Round 23 — Production Blocker Fix

Basis: independent PostgreSQL/runtime review `ZAABOS_V1_INDEPENDENT_FINAL_REVIEW.md`.

## Fixed

- ZAABOS-001: public QR orders no longer depend on implicit `g.tenant_id` for recipe inventory. Inventory helpers now receive tenant_id explicitly.
- ZAABOS-002: PostgreSQL refund flow locks the order row (`FOR UPDATE`) before reading paid/refunded totals, serializing concurrent refunds for the same order.
- ZAABOS-003: split bill now defines/uses its PostgreSQL row lock.
- ZAABOS-004: Bill Manager uses real frontend state (`branchTables()` / `activeOrders`) instead of undefined `boardTables` / `allOrders`.
- ZAABOS-005: KDS now has a real `#kitchenStationFilter` control and null-safe event binding.
- ZAABOS-006: public menu/order/table/tracking paths enforce `tenant_active()` so suspended/expired tenants cannot continue customer QR operation.
- ZAABOS-007: manual checkout discount starts as Decimal, removing float + Decimal TypeError.
- ZAABOS-008: kitchen station, ingredient, and expense creation validate that supplied branch_id belongs to the logged-in tenant.
- ZAABOS-009: PostgreSQL/production startup now REQUIRES `ZAABOS_SECRET_KEY`; local SQLite development retains file fallback.
- ZAABOS-010: cart/menu-option pricing now uses Decimal internally and quantizes before DB/API values.
- ZAABOS-011: offline cached session is restored only for connectivity/transient failures, never for explicit HTTP auth/subscription denial. 401 errors now retain status metadata.
- ZAABOS-012: branch/user quota checks lock the tenant row on PostgreSQL so concurrent creates cannot both consume the last slot.

## Additional cleanup found during reconciliation

Removed an unrelated Round 22.1 idempotency/order lookup block that had accidentally been present inside `add_table()`. Order idempotency remains in `staff_create_order()` where it belongs.

## Deployment warning — read before deploy

On Railway/PostgreSQL, set a stable environment variable `ZAABOS_SECRET_KEY` BEFORE deploying this release. Round 23 intentionally fails startup if PostgreSQL is enabled and the key is missing. This prevents silent session-key rotation on ephemeral filesystems.

## Database

No schema reset. No migration required for Round 23.

## Local validation performed here

- `python -m py_compile app.py` — PASS
- `node --check static/app.js` — PASS
- `node --check static/kitchen.js` — PASS
- existing `final_v1_production_audit.py` — PASS before packaging
- existing Round 21 and Round 22 audits — PASS before packaging

A fresh runtime import could not be executed in this container because Flask is not installed in this execution environment. Therefore this release MUST be re-run through the same real PostgreSQL + HTTP regression suite used by the independent reviewer. Do not treat syntax/static PASS as final production acceptance.
