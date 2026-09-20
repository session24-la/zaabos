# ZaabOS Round 14E UI Hotfix

Problem reproduced from the latest deployed ZIP:
- Both #loginView and #appRoot start with class `hidden`.
- Round 14D JavaScript attached an event listener to `#cpDiscount`, but the payment modal HTML did not contain that element.
- Round 14A/14D JavaScript also expected Operations/Pricing controls that were not present in index.html.
- This could throw a JavaScript TypeError during startup and leave the page visually blank.

Fix:
- Added the missing payment promotion/discount/manager-approval fields.
- Added Operations tab UI for shift/cash/critical-operation history.
- Added Pricing & Promotions tab UI.
- Added a small defensive startup error fallback so both root views cannot remain hidden after a future startup JS error.
- Synchronized root index.html and templates/index.html.
- No database reset and no schema/data deletion.
- Round 14E backend/database behavior is preserved.
