# ZaabOS Round 14F — Independent Audit Fixes

Based on the independent Claude audit of the latest deployed Round 14E UI-hotfix baseline.

Implemented without resetting or deleting production data:

- FIN-001: reports now include `delivery_fee` in total sales, net sales/profit, average bill and open-order totals; report UI shows delivery fee separately.
- FIN-002: menu category/item creation validates branch ownership; menu item category validates tenant+branch ownership; public menu filters both `tenant_id` and `branch_id`; menu edit validates category ownership.
- FIN-003: decreasing an order-item quantity now requires a reason; Staff also requires Owner/Manager credentials; the action is recorded in `critical_operations`. Increasing quantity remains normal.
- FIN-005: public order tracking now sends phone number in POST JSON rather than URL query strings. Same-browser success flow keeps convenience via sessionStorage.
- FIN-006: `/api/admin/production-readiness` now uses normal login + super-admin decorators.
- FIN-007: newly created/reset tenant user passwords now require at least 10 characters.
- FIN-008: removed the duplicate early `SESSION_COOKIE_SECURE` assignment; canonical production config remains in one place.
- FIN-010: merged source orders have their total recalculated after items are moved.
- Fixed an existing report UI typo where the refund card referenced an undefined `cards` variable.
- Migration ledger records version 19 `independent_audit_fixes` (no destructive schema operation).

Not silently changed in this round because they require runtime/configuration or a product decision:

- FIN-004: verify/set stable `ZAABOS_SECRET_KEY` in Railway.
- Refund-after-shift-close policy.
- Restaurant/business timezone (Asia/Vientiane vs server UTC).
- Money precision redesign.
- Advanced kitchen notification behavior when already-sent quantities are reduced.
- SQLite-only daily-closing race (production uses PostgreSQL).

Validation performed:
- Python compile
- JavaScript syntax checks
- Existing Round 12/14B/14C/14D/14E audits
- Round 14F static invariant audit
