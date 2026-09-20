# ZaabOS Round 14B — Restaurant Menu Modifiers

Baseline: user-confirmed Railway build `zaabos-main(2).zip` (Round 14A passed).

## Added
- Modifier groups can be **single choice** or **multiple choice**.
- Required groups are enforced server-side.
- Multiple-choice groups have a configurable maximum selection count.
- Modifier price deltas are recalculated on the server; client totals are never trusted.
- Duplicate/tampered modifier IDs are deduplicated and invalid/inactive options are rejected.
- Customer QR ordering and staff take-order both support the same modifier rules.
- Existing kitchen tickets, order detail and receipts continue to use immutable option snapshots.
- Existing single-choice modifier groups remain backward compatible.

## Database migration
Migration 15: `restaurant_menu_modifiers`
- `menu_option_groups.selection_type`
- `menu_option_groups.min_select`
- `menu_option_groups.max_select`
- `menu_options.active`

No database reset and no destructive migration.

## Acceptance test after Railway deploy
1. Edit a menu item and add group `ระดับความเผ็ด` as single-choice + required.
2. Add group `เพิ่มท็อปปิ้ง` as multiple-choice, max 3, with some +price choices.
3. Place one order from staff POS and one from customer QR.
4. Confirm selecting > max is rejected and missing required choice is rejected.
5. Confirm total includes every selected +price modifier.
6. Confirm modifiers appear on order detail, kitchen ticket/KDS and receipt.
7. Confirm an old menu item with existing single-choice options still works.
