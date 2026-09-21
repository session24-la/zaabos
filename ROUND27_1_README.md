# ZaabOS Round 27.1 — Responsive Settings + Safe Shift Close

## Changed
- Receipt settings workspace constrained and responsive across Mac/desktop, iPad/tablet, and phone widths.
- Receipt preview no longer forces an excessively tall/wide settings page.
- Option cards reflow cleanly at desktop/tablet/mobile breakpoints.
- Closing a shift now requires a second confirmation screen.
- Confirmation shows expected cash, counted cash, and shortage/overage before committing.
- Empty/invalid counted cash is rejected before confirmation.
- Only after final confirmation is the close-shift API called; the existing shift-closing print report then opens.

## Database
No schema or migration changes.

## Validation
- `python -m py_compile app.py` PASS
- `node --check static/app.js` PASS
- `node --check static/sw.js` PASS
