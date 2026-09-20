ZaabOS Round 20 — Offline POS + Safe Sync

What works:
- After at least one successful online login, the device stores a 24-hour offline session snapshot plus menu/branch/table bootstrap in IndexedDB.
- If internet/Railway becomes unavailable, the installed PWA can reopen its cached POS shell.
- NEW staff orders can be stored locally in an IndexedDB outbox.
- Each queued order has client_request_id + device id + offline timestamp.
- Reconnect triggers automatic sync; server has a tenant-scoped unique idempotency key so retry/tap/reconnect cannot create the same queued order twice.
- Rejected queued orders become visible as conflicts instead of retrying forever.
- /api/* is NEVER Service-Worker cached.

Safety boundary:
- Offline payment/refund/reopen/add-items/stock-management are intentionally NOT queued. Financial mutations need stronger conflict/shift semantics and remain online-only.
- A queued offline order is not sent to kitchen until it reaches the server. This prevents the kitchen and server from disagreeing silently.
- Cached offline authorization expires after 24 hours and is cleared on logout.
- No database reset. Migration 27 upgrades the existing orders table automatically.

Acceptance test:
1. Deploy online, login once, open POS.
2. Turn Wi-Fi off and reload installed PWA/site: POS shell should reopen in OFFLINE mode.
3. Create a NEW order: it should appear under 'ออเดอร์รอ Sync'.
4. Restore Wi-Fi: queue should sync automatically and disappear.
5. Verify exactly one server order was created even if Sync is pressed repeatedly.
