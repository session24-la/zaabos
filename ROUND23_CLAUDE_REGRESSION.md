# ZaabOS Round 23 — Independent PostgreSQL Runtime Regression Request

Use the new full project after Round 23 is merged/deployed. Do not assume the fixes work because the code looks correct.

Re-run the SAME PostgreSQL 16 + real Flask HTTP methodology used in `ZAABOS_V1_INDEPENDENT_FINAL_REVIEW.md`.

## Mandatory re-tests of previous findings

1. ZAABOS-001 — Public QR order: POST `/api/public/orders` with (a) item without recipe and (b) item with recipe. Both must succeed; recipe stock movement must affect only the correct tenant.
2. ZAABOS-002 — Concurrent refund: create a paid order where only one of two simultaneous refund requests can fit in remaining refundable balance. Fire both requests concurrently. Sum(refunds) must never exceed active paid amount; only one request should succeed where appropriate.
3. ZAABOS-003 — Split bill backend: split a quantity/item from an open unpaid order on PostgreSQL. Must return 200 and preserve at least one item in source bill.
4. ZAABOS-004 — Bill Manager browser runtime: open Move, Merge and Split modes. Browser console must have no ReferenceError; each mode must show correct candidates.
5. ZAABOS-005 — `/kitchen`: page must leave boot splash, station selector must exist, station list must load, and selecting a station must filter displayed kitchen items correctly.
6. ZAABOS-006 — Suspend a tenant. Verify public menu, public tables, public order creation and public tracking are blocked. Reactivate and verify they work again.
7. ZAABOS-007 — Payment with manual discount. Must return 200 and exact expected total using Decimal rounding.
8. ZAABOS-008 — Login Tenant A and submit Tenant B branch_id to kitchen station creation, ingredient creation and expense creation. All must reject and DB must contain no cross-tenant branch association.
9. ZAABOS-009 — PostgreSQL startup without `ZAABOS_SECRET_KEY` must fail clearly. With a stable key it must boot; restart/redeploy with same key must preserve sessions as expected.
10. ZAABOS-010 — Cart with decimal menu/modifier prices and multiple quantities. Compare stored order totals with Decimal expected values exactly.
11. ZAABOS-011 — With cached offline session present: network failure may enter offline mode; HTTP 401/403 must NOT restore the cached session and must show login/access denial instead.
12. ZAABOS-012 — With only one branch/user quota slot remaining, fire two concurrent create requests. At most one may succeed.

## Previously unverified flows that must now be tested

- Merge bill end-to-end, including totals and source cancellation state.
- Reopen/payment reversal: same-shift cash and previous-shift cash accounting.
- Ingredient/recipe flow: sale deduction, cancellation/restore, manual adjustment, waste, stock count and movement history.
- Staff critical-operation approval using a real staff login and manager/owner approver credentials.
- Receipt: successful payment -> immediate print flow, plus reprint from History.
- PWA/service-worker behavior in a real browser, including logout/session expiry and sensitive cache behavior.
- 80 mm receipt print preview/physical printer if hardware is available.

## Cross-tenant branch_id sweep

Do not stop at the three endpoints from ZAABOS-008. Search every authenticated mutation endpoint that accepts client-controlled `branch_id`. For each, verify the referenced branch belongs to `g.tenant_id` directly or that the mutation is otherwise safely constrained through a tenant-scoped parent row. Report any remaining route that can create a row whose `tenant_id` and `branch_id` belong to different tenants.

## Acceptance rule

Do not mark Round 23 accepted from static/string audits. Acceptance requires runtime evidence on PostgreSQL for all former Critical/High findings. Report any regression as a new finding with HTTP request/response, traceback if any, and DB evidence.

Return:
1. Previous finding ID -> PASS/FAIL with evidence.
2. New findings, if any, ordered Critical/High/Medium/Low.
3. Runtime tests actually executed.
4. Remaining `[?]` items not proven.
5. Whether any Critical or High blocker remains. Do not modify code during this review.
