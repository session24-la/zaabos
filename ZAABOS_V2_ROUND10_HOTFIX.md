# Round 10 startup hotfix

Root cause:
The PostgreSQL compatibility adapter automatically appended `RETURNING id`
to every INSERT. Round 10 introduced `schema_migrations`, whose primary key is
`version` and which intentionally has no `id` column. On startup, recording
migration version 10 therefore caused PostgreSQL to reject the query and the
Railway app crashed.

Fix:
- Do not append `RETURNING id` for `schema_migrations`.
- Preserve lastrowid emulation for normal application tables.
- No database reset.
- No data deletion.
- No rollback of the Round 9 multi-tenant fix.
