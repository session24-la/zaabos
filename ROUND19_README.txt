ZaabOS Round 19 — Branded Error Pages + PWA/Offline Foundation
Carries forward the successful Round 18.2 startup fix.

Adds branded 404/500/503, installable PWA metadata, root Service Worker, offline fallback, and online/offline banner.
Security/data rule: /api/* is never cached. Round 19 intentionally does not queue offline orders/payments.
A total Railway/origin crash can still show Railway/Cloudflare 502 because Flask is not alive; a ZaabOS-branded total-outage page requires an independent edge layer (for example Cloudflare custom error handling).
No database reset. No new DB migration.
