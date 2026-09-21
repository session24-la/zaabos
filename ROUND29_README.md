# Round 29 — Backup & Recovery

## What changed
- `ZAABOS_BACKUP_DIR` is now actually honored by the application.
- PostgreSQL application backups use `pg_dump --format=custom` and write a SHA-256 manifest.
- Super-admin API can list/create/download backup artifacts. There is intentionally **no HTTP restore endpoint**.
- `production-readiness` now reports `pg_dump_available` and backup artifact count and reminds operators that provider/off-site backup + restore drill are mandatory.
- `backup_postgres.py` creates an operator backup.
- `restore_test_postgres.py` restores only to `RESTORE_TEST_DATABASE_URL`, refuses to run if it equals production, then checks core tables.

## Production requirement
Local Railway/container files are not disaster recovery. Enable PostgreSQL provider/off-site backups separately. A backup is not accepted as verified until a restore into a disposable test database succeeds.

## Suggested drill
1. Ensure PostgreSQL client (`pg_dump`, `pg_restore`) is installed in the environment where the scripts run.
2. Set `DATABASE_URL` and a durable `ZAABOS_BACKUP_DIR`; run `python backup_postgres.py`.
3. Provision an empty disposable PostgreSQL database and set `RESTORE_TEST_DATABASE_URL` to it.
4. Run `python restore_test_postgres.py backups/<dump-file>.dump`.
5. Record the PASS result/date. Never point `RESTORE_TEST_DATABASE_URL` at production.

No schema migration or DB reset is required.
