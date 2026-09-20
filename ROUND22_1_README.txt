ZaabOS Round 22.1 — Order Confirmation Hotfix

Root cause confirmed in the latest source:
staff_create_order() used client_request_id, client_device_id and offline_created_at in its INSERT without defining them first. That causes a Python NameError and the API returns the generic order-save error shown in the screenshot.

Fix:
- initialize all three values from the request before order validation/INSERT;
- restore pre-insert idempotency lookup so reconnect/retry returns the same order instead of duplicating it;
- keep the existing integrity-error duplicate guard.

No database reset. No migration. Only app.py changes.
