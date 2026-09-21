# ZaabOS Round 28.1 — Tablet Navigation Hotfix

## Changed
- `static/style.css` only.
- At 641–999px, secondary primary-nav items remain hidden to prevent horizontal overflow.
- Their copies inside `☰ เพิ่มเติม` are explicitly restored with `display:flex!important`.
- This restores access to Reports, Inventory, and Shift & Cash on 768px/834px tablets.

## Database
- No migration.
- No reset required.

## Acceptance
Verify at 768×1024 and 834×1112:
1. No horizontal navigation overflow.
2. `☰ เพิ่มเติม` contains Reports, Inventory, and Shift & Cash.
3. All 11 workspaces remain reachable.
