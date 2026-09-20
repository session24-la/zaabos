# ZaabOS Production Launch Checklist

## Required before taking real restaurant money
- [ ] Railway app and PostgreSQL are healthy.
- [ ] `ZAABOS_SECRET_KEY` is set to a long, stable random value in Railway.
- [ ] Super-admin default/temporary password has been changed.
- [ ] `/healthz` and `/readyz` pass after a fresh redeploy.
- [ ] Tenant A cannot view/edit Tenant B menu, orders, users, payments or reports.
- [ ] QR order -> kitchen -> payment -> receipt tested on the actual iPhone/iPad/Mac used in store.
- [ ] Same order payment attempted simultaneously on two devices; only one succeeds.
- [ ] Refund duplicate guard tested.
- [ ] Daily closing tested and report totals manually reconciled.
- [ ] PostgreSQL provider/off-site backup is enabled outside the app container.
- [ ] A backup has been restored into a SEPARATE test database and checked. Never test restore against production.

## Backup policy
Recommended operational target: daily automated database backup plus provider retention appropriate to the business. Keep at least one copy outside the application container. A backup is not considered proven until a restore test succeeds.

## Recovery drill
1. Create/select an isolated test PostgreSQL database.
2. Restore a recent production backup into that isolated database using the provider's supported restore process.
3. Point a temporary ZaabOS test deployment at that test database only.
4. Verify tenants, branches, menu, open/closed orders, payments, refunds and daily closings.
5. Compare representative totals with production reports.
6. Delete/secure the temporary recovery environment after the drill.

## Launch status
Rounds 9–13 cover multi-tenant order isolation, production safety, concurrency protection, security headers, acceptance invariants and operational readiness. Remaining SaaS features such as subscriptions/plans/billing are product features, not blockers for operating the first restaurant.
