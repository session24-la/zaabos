# Round 28.2 — History & Print Preview UX
- History defaults to Today and supports Yesterday / last 7 days / this month / custom date range.
- Order history is grouped with date dividers, while each order keeps its exact timestamp.
- Backend `/api/orders` accepts `date_from` / `date_to` using the restaurant timezone.
- Receipt settings preview now has explicit Front Receipt / Kitchen Order preview tabs.
- No database migration or reset.
- Backup/restore is intentionally not changed in this UI patch; production PostgreSQL restore remains an infrastructure task.
