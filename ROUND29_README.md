# Round 29 — Backup & Recovery

## What changed
- `ZAABOS_BACKUP_DIR` is honored by the application.
- PostgreSQL backups use `pg_dump --format=custom` and write a SHA-256 manifest
  that now also records the row counts of the core tables, so a restore can be
  verified against what was actually backed up.
- Super-admin API can list/create/download backup artifacts. There is
  intentionally **no HTTP restore endpoint**.
- `production-readiness` reports `pg_dump_available` and the backup artifact
  count, and reminds operators that provider/off-site backup plus a restore
  drill are mandatory.
- `backup_postgres.py` creates an operator backup.
- `restore_test_postgres.py` restores only into `RESTORE_TEST_DATABASE_URL`.

## Round 29 fix pass
- **Railway build failure root cause:** a service variable on `zaabos-app` whose
  name began with four spaces (`"    RESTORE_TEST_DATABASE_URL"`). Railway turns
  each variable into a BuildKit secret keyed by its name; an invalid name yields
  no secret ID and the build fails with
  `failed to solve: secret ID missing for "" environment variable`. The
  reference syntax and the `postgres-restore-test` service were not at fault.
  The variable has to be removed in the Railway dashboard — an API delete is
  accepted but leaves it in place.
- `restore_test_postgres.py` no longer trusts a text comparison of the two
  connection strings. It fingerprints both databases and refuses to run when the
  target and production resolve to the same database through different URLs.
- The target's `public` schema is dropped and recreated before `pg_restore`, so
  the exit code is meaningful on a first-time (empty) drill database.
- Verification now asserts core tables exist, core tables are non-empty, row
  counts match the backup manifest, and a real join query runs.
- Passwords and connection URLs are scrubbed from all output, including
  `pg_dump`/`pg_restore` stderr.
- A failed `pg_dump` deletes its own partial artifact; dump and manifest are
  written `0600`; `backups/*.dump*` are git-ignored.
- Both Railway PostgreSQL services run **PostgreSQL 18**, so the drill
  environment needs **client 18** — an older `pg_dump` aborts on version
  mismatch.

See `RESTORE_DRILL.md` for the exact Railway steps and the drill procedure.

## Production requirement
Local Railway/container files are not disaster recovery. Enable PostgreSQL
provider/off-site backups separately. A backup is not accepted as verified until
a restore into a disposable test database succeeds.

No schema migration or DB reset is required.
