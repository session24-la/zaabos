# ZaabOS Round 14D — Pricing / Promotions / Service Charge / Tax

Migration: 17 `pricing_promotions_service_tax`

## Added
- Per-branch Tax % and Service Charge % settings.
- Tenant-scoped promotion codes with percent/fixed discount and minimum spend.
- Manual order discount at payment; Staff requires Owner/Manager approval using the Round 14C approval flow.
- Backend is authoritative for promotion validation, discount, service charge, tax and final amount.
- Orders snapshot discount/service/tax so historical paid orders do not change when settings change later.
- Receipt prints discount, service charge, tax and corrected grand total.
- Sales summary includes discount/service/tax in total sales.
- Promotions can be disabled without deleting historical order references.

## Safety
- No database reset and no destructive migration.
- Existing branches default to 0% Tax and 0% Service Charge until configured.
- Existing orders default to zero discount/service charge.
- Promotion codes are unique inside each tenant, not globally.

## Quick acceptance test
1. Open ราคา & โปรโมชั่น as Owner/Manager and set Tax/Service Charge for a branch.
2. Create a promotion code (e.g. TEST10, 10%).
3. Open an unpaid order and pay with the promotion code.
4. Verify receipt shows discount/service/tax and payment total is correct.
5. As Staff, try a manual discount: it must require Owner/Manager credentials.
6. Verify Reports total reflects discount/service/tax.
