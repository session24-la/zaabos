# Round 10 — Production Safety Foundation

- Removed the known default production super-admin password bootstrap. Existing admins are unchanged.
- Fresh production bootstrap uses ZAABOS_ADMIN_USERNAME / ZAABOS_ADMIN_PASSWORD (minimum 12 chars).
- Added a schema_migrations ledger and records version 10.
- Added tenant+branch composite indexes for core operational tables.
- Added /healthz and /readyz probes; readiness checks the database and reports schema version without exposing restaurant data.
- Kept Round 9 tenant-scoped order numbering and isolation protections.
- No database reset and no destructive data migration.
