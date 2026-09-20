ZaabOS Round 14H.3 — changed files only
Replace only:
- app.py
- static/app.js
- schema.sql
- schema_postgres.sql

Safety fixes before Bill Operations:
- restart-safe payment reversal index
- correct same-shift cash reversal calculation
- cancelled history no longer says unpaid
- fresh-install schemas include reversal fields/indexes
No database reset or data deletion.
