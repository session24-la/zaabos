ZaabOS Core v1.0 — Final Production Audit Fix Pack

Final audit found one real security consistency issue and one stale audit script.

Fixes:
- Change-password minimum is now 10 characters (was 6).
- New tenant owner bootstrap password minimum is now 10 characters (was 6).
- Existing normal user create/edit policy already requires 10; super-admin bootstrap remains 12.
- Round 14D audit updated for the later Decimal-based financial implementation, so it no longer reports false failures from old float-era code patterns.
- Added final_v1_production_audit.py covering current migration, tenant safety, checkout, receipt, security, offline/PWA, menu, kitchen, inventory, SaaS and fresh-schema invariants.

No database reset. No migration.

Runtime acceptance still required on Railway for real browser/session/PostgreSQL behavior. Static audit cannot prove external backup/restore, printer hardware, or Railway/Cloudflare availability.
