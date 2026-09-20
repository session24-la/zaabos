ZaabOS Round 21 — Offline Reliability Completion

Hardens Round 20 for real deployment:
- Repairs the Round 20 fresh SQLite schema and verifies a brand-new database can initialize.
- Temporary network/5xx/429 failures stay pending and retry; real 4xx business conflicts stop for review.
- Conflict queue rows can Retry or Remove.
- Offline dine-in orders visibly reserve/mark the table; takeaway/delivery queued orders are visible.
- Removes the reconnect forced-reload race so the sync lifecycle owns reconnect behavior.
- /api/* remains excluded from Service Worker caching.

Safety boundary remains intentional: payment/refund/reopen/kitchen-send/admin stock mutations are online-only while disconnected. They are not silently replayed from multiple devices.
No database reset. No new migration.
