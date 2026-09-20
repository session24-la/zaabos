# ZaabOS V2 Round 12 — Production Acceptance + Security

This round intentionally does not add business features.

Added:
- HTTPOnly + SameSite=Lax session-cookie hardening.
- Secure cookies automatically on Railway/production.
- X-Content-Type-Options: nosniff.
- X-Frame-Options: DENY.
- Referrer-Policy.
- Permissions-Policy.
- HSTS on HTTPS requests.
- Schema migration version 12.
- `production_acceptance_audit.py`: non-destructive audit for critical multi-tenant,
  payment/refund/closing, CSRF/password, health/readiness and security-header invariants.

Preserved:
- Round 9 tenant-scoped order numbering.
- Round 10 startup/migration fix.
- Round 11 atomic payment, refund and daily-closing protections.
- Existing PostgreSQL data; no reset and no destructive migration.

Manual acceptance before commercial rollout:
1. Tenant A and Tenant B each create orders with no cross-visibility.
2. Owner/Manager/Staff permissions are tested with real accounts.
3. QR order -> kitchen -> payment -> receipt is tested on iPhone/iPad/Mac.
4. Two devices attempt payment on the same order; only one succeeds.
5. Refund and daily close are tested once and then repeated to confirm duplicate guards.
6. `/healthz` and `/readyz` return healthy after deployment.
7. Provider/off-site PostgreSQL backup is restored into a separate test database.
