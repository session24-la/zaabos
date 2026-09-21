# ZaabOS — Backup & Restore Drill (Round 29)

Production credentials for the restore-test database must **not** live on the
production web service. `zaabos-app` never needs `RESTORE_TEST_DATABASE_URL`;
there is deliberately no HTTP restore endpoint.

---

## 1. Why the Railway build was failing

`zaabos-app` carries a service variable whose **name literally starts with four
spaces**:

```
"    RESTORE_TEST_DATABASE_URL"
```

Railway stores it, but the build system turns every service variable into a
BuildKit secret keyed by its name. A name that is not `[A-Za-z_][A-Za-z0-9_]*`
produces no secret ID, and the build dies at the very first step:

```
install mise packages: python
  error: secret ID missing for "" environment variable
Build Failed: build daemon returned an error
  < failed to solve: secret ID missing for "" environment variable >
```

The empty string in `secret ID missing for ""` is the malformed name.

The reference syntax was never the problem, and neither was
`postgres-restore-test`. The variable was almost certainly pasted from an
indented code block into Railway's variable editor, carrying the indentation
into the name.

**Fix: delete that one variable in the Railway dashboard.** It cannot be removed
through the public API — an API delete is accepted but silently leaves the
malformed entry in place, and the next build fails identically. Do it in the UI:

1. Railway → project `zaabos` → service **zaabos-app** → **Variables**
2. Find the row that renders as an indented `RESTORE_TEST_DATABASE_URL`
3. **⋮ → Delete** (only that row)
4. Leave `DATABASE_URL` and `ZAABOS_SECRET_KEY` untouched — do not rotate the key
5. **Deploy**

Do not delete either PostgreSQL service. `Postgres` stays production,
`postgres-restore-test` stays the drill target.

---

## 2. Where the drill runs

Both databases are `postgres-ssl:18`, so the drill needs **PostgreSQL client 18**.
A `pg_dump` older than the server refuses to run:

```
pg_dump: error: server version: 18.x; pg_dump version: 16.x;
aborting because of server version mismatch
```

That rules out plain `RAILPACK_DEPLOY_APT_PACKAGES=postgresql-client` on a
Debian/Ubuntu base, which still ships client 15/16. Two ways that do work:

### Option A — a dedicated Railway drill service (recommended)

Create **one** new service, separate from `zaabos-app`:

| Setting | Value |
|---|---|
| Name | `restore-drill` |
| Source | same GitHub repo as `zaabos-app` (`session24-la/zaabos`) |
| Build variable | `RAILPACK_PACKAGES=python@3.13 postgresql@18` |
| Start command | `python restore_drill.py` (or leave empty and run manually) |
| Replicas | 0 / or delete the service after the drill |

Variables on **`restore-drill` only**:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
RESTORE_TEST_DATABASE_URL=${{postgres-restore-test.DATABASE_URL}}
ZAABOS_BACKUP_DIR=/app/backups
```

Type those names by hand — do not paste an indented line, that is what broke the
build in the first place.

`zaabos-app` keeps exactly two variables: `DATABASE_URL` and `ZAABOS_SECRET_KEY`.

### Option B — your own computer, no credentials copied anywhere

Install PostgreSQL 18 client tools locally, then let the Railway CLI inject the
variables:

```bash
railway link                                  # pick project zaabos / production
railway run --service restore-drill -- python backup_postgres.py
railway run --service restore-drill -- python restore_test_postgres.py backups/<file>.dump
```

`railway run` passes the variables into the local process; nothing is printed and
nothing needs to be copied into a chat, a file, or a note.

---

## 3. The drill

```bash
# 1. create a backup from production (read-only on production)
python backup_postgres.py

#    → backups/zaabos_operator_YYYYMMDD_HHMMSS.dump
#    → backups/zaabos_operator_YYYYMMDD_HHMMSS.dump.json   (sha256 + row counts)

# 2. restore it into the disposable database and verify
python restore_test_postgres.py backups/zaabos_operator_YYYYMMDD_HHMMSS.dump
```

Exit code `0` = PASS, `1` = FAIL. Both scripts print `PASS:` or `FAIL:` on the
last line, so they can be wired into a scheduled job.

### What the restore script refuses to do

Before it writes anything it runs two guards:

1. **Text guard** — `RESTORE_TEST_DATABASE_URL` must not equal `DATABASE_URL`.
2. **Identity guard** — it connects to both and compares
   `current_database()`, `inet_server_addr()`, `inet_server_port()` and
   `pg_postmaster_start_time()` (plus the cluster `system_identifier` when the
   role is allowed to read it). Two different spellings of the *same* database —
   internal vs public hostname, a different user, an extra `?sslmode=` — are
   still recognised as the same database and the drill aborts.

The text guard alone is not enough; the identity guard is what actually protects
production.

### What "verified" means

After `pg_restore` the script checks that:

- the connection succeeds;
- every core table exists — `tenants`, `users`, `branches`, `menu_items`,
  `orders`, `order_items`, `payments`, `schema_migrations`;
- `tenants`, `users` and `schema_migrations` are **not empty**;
- each table's row count **matches the count recorded in the backup manifest**
  at dump time;
- a real join query runs (`users ⋈ tenants`);
- `MAX(schema_migrations.version)` is readable.

Any mismatch prints the specific problem and exits `1`.

### Safety properties

- production is only ever read (`pg_dump`), never written;
- the drill target's `public` schema is dropped and recreated before the restore,
  so the result is deterministic and the exit code is meaningful (`pg_restore
  --clean` against a fresh database reports an error for every object it cannot
  drop, which made a first-time drill look like a failure);
- passwords and connection URLs are scrubbed from every line of output,
  including `pg_dump`/`pg_restore` stderr — only `host:port/dbname` is shown;
- a failed dump deletes its own partial file, so a later drill cannot pick up a
  0-byte artifact;
- dump and manifest are written `0600`;
- `backups/*.dump` and `backups/*.dump.json` are git-ignored.

---

## 4. Recording the result

A backup is not a backup until a restore has succeeded. After each drill record:

| Date | Artifact | sha256 (first 12) | Rows restored | Result |
|---|---|---|---|---|
| | | | | |

Run the drill after every schema migration and at least monthly. Provider-level
PostgreSQL backups on Railway are still mandatory and separate from this — the
`backups/` directory inside a container is not disaster recovery.
