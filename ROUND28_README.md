# ZaabOS Round 28 — Production Gate

Source: latest user upload `zaabos-main-3(9).zip`.

## Runtime fixes
- PostgreSQL transaction advisory lock serializes daily order-number allocation across workers/instances; retry ceiling retained as a secondary guard.
- Public QR order creation now has a DB-serialized per-table/branch burst guard (15 customer orders / 60 seconds) and returns HTTP 429 instead of accepting unlimited bursts.
- Public/staff carts are capped at 100 lines per order.
- Login lock expiry now uses timezone-aware UTC consistently with `now()`.
- Menu stock adjustment, ingredient waste, and ingredient stock count use PostgreSQL row locking before read/modify/write to prevent lost updates.
- Invalid `branch_id` query values are normalized to HTTP 400 in the audited high-traffic endpoints.
- Staff shift history is limited to the staff member's own closed shifts; owner/manager keep branch-wide history.
- Added CSP hardening compatible with the current inline UI. (Inline script/style remain temporarily allowed until the UI is refactored.)
- Tablet 641–999px navigation collapses secondary operational tabs into More instead of overflowing the viewport; mobile menu workspace width is constrained.

## Validation performed here
- `python -m py_compile app.py` — PASS
- `node --check static/app.js` — PASS
- `python round28_production_gate_audit.py` — 11/11 PASS
- `python round27_audit.py` — 10/10 PASS
- `python round23_regression_audit.py` — PASS

## Important acceptance note
These are source/static checks in this environment. The concurrency fixes must still be re-run by the independent PostgreSQL/HTTP/browser acceptance suite on the deployed/real PostgreSQL environment, especially 8–20 simultaneous order creation, waste/stock-adjust/count races, Asia/Vientiane login lock duration, and 834px tablet navigation.

No database reset and no schema migration are required for Round 28.
