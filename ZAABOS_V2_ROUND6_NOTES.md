# ZaabOS V2 Round 6 — Production Completion

- Fixed favicon in the actual Flask `templates/` pages and bumped assets to v6.
- Added full-payment refund/void recording for Owner/Manager with immutable original payment history.
- Reports now expose refund total, refund count, net sales and subtract refunds from net profit.
- Added safe merge-bill workflow for open unpaid orders in the same branch.
- Added clearer network failure handling for staff actions.
- Existing receipt printing, daily closing, permissions and kitchen flow remain intact.
- Additive database migration only; no reset/destructive migration.
