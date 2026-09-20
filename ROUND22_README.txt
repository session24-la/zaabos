ZaabOS Round 22 — Checkout + Menu Workspace Polish

Fixes:
- Runtime error: formatDateTime is now backed by the existing Asia/Vientiane formatter.
- Adjacent operations bug: undefined currentUser replaced with the authenticated `me`.
- Payment confirmation now reloads the authoritative paid order and immediately opens the receipt print flow.
- Receipt remains printable later from History.
- Menu management redesigned: category sidebar on the left, selected category's food cards on the right, image-first cards, responsive mobile layout.
- Table & QR moved from More to the primary navigation directly after Menu.
- Existing add/edit/delete category and menu-item actions are preserved.

No DB reset and no schema migration in this round.
