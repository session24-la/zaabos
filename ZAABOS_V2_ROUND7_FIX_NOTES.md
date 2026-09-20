# ZaabOS V2 Round 7 — Targeted Fix

Fixed three reported production issues:

1. Mobile customer order confirmation
   - More robust JSON/error handling in Safari/mobile browsers.
   - Public order creation is transaction-safe and always returns JSON on server failure.
   - Prevents a generic client error caused by an HTML 500 response.

2. Order status workflow
   - Removed the generic manual status-advance button from the staff order card.
   - Kitchen still controls cooking workflow.
   - Successful payment automatically closes the order as COMPLETED.
   - Staff no longer needs to manually click through preparing/ready/served/completed after payment.

3. Safari favicon
   - Added real `/favicon.ico` and `/apple-touch-icon.png` routes.
   - Added no-cache headers to those standard icon routes.
   - All Flask templates and static HTML now point to the root favicon with cache-bust `v=7`.

No database reset. No destructive migration.
