# ZaabOS Round 27.2 — Receipt Settings Compact UI + Printer Routing

## Changes
- Compact receipt option cards: readable labels, smaller cards, no vertical letter wrapping.
- Responsive 3/2/2-column layout depending on screen width.
- Added explicit printer routing settings per branch:
  - Customer receipt -> Front printer / browser print selection
  - Kitchen ticket -> Kitchen printer / browser print selection
  - Kitchen auto queue toggle
- Existing kitchen print queue remains separate and station-aware.
- Printer routing preferences are stored in existing branch `receipt_settings.settings_json`; no database migration/reset.

## Hardware boundary
ZaabOS already creates separate kitchen print jobs. Direct silent routing to a physical thermal printer still requires a Local Print Agent / printer-specific integration at hardware setup time. Browser JavaScript alone cannot safely guarantee silent selection of a particular OS printer.

## Validation
- Python compile PASS
- app.js syntax PASS
- sw.js syntax PASS
