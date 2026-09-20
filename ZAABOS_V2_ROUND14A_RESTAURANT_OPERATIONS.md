# ZaabOS Round 14A — Restaurant Operations Foundation

Adds tenant-scoped employee shifts, cash drawer movements, and the database foundation for critical-operation reasons/audit.

## New usable workflow
- Staff/manager/owner opens their own shift per branch with opening cash.
- Cash-in / cash-out requires a positive amount and a reason.
- Closing a shift calculates expected cash = opening cash + cash sales by that user since shift open + cash-in - cash-out.
- Staff enters counted cash and ZaabOS stores the difference.
- Duplicate open shifts for the same tenant/branch/user are blocked at DB level.
- Shift close is atomic to protect against two-device double-close.

## Foundation added for next patch
`operation_reasons` and `critical_operations` are created now so refund/cancel/discount approval workflows can be wired to standardized reasons without a destructive migration later.

No existing orders/payments/refunds are reset or rewritten. Migration ledger records version 14.
