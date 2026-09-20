# ZaabOS V2 Round 11 — Concurrency & Recovery Hardening

- One payment per tenant/order enforced at database level.
- One refund per tenant/order enforced at database level.
- One daily closing per tenant/branch/date enforced at database level.
- Payment confirmation is atomic; double taps/two devices cannot both win.
- Concurrent refund attempts return conflict instead of duplicating refunds.
- PostgreSQL daily closing uses atomic UPSERT.
- Existing local backup helper is retained, but container-local dumps are not sufficient disaster recovery. Configure off-site/provider PostgreSQL backups and test restore before commercial rollout.
- No database reset or destructive rebuild.
