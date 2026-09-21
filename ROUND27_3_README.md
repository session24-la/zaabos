# ZaabOS Round 27.3 — Receipt Settings Stability

- Fixes `null is not an object` when printer-routing controls are temporarily missing because Safari/PWA has mixed cached HTML/JS during deploy.
- Receipt settings JS now tolerates missing optional controls and falls back to safe defaults.
- Adds cache-busting for app.js/style.css and bumps the service-worker shell cache.
- Reworks receipt option cards with auto-fit sizing so labels remain horizontal/readable on Mac, iPad and phone.
- Keeps customer receipt and kitchen print routes separate. Kitchen hardware still requires the local printer agent/integration.
- No database migration or reset.
