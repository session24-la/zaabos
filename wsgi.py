"""Production WSGI entrypoint for ZaabOS.

Keeps the core application module unchanged while registering the browser-facing
Cloud Core helpers: local QR rendering, QR customer history, and logical table
open checks (one payable bill per dine-in seating while preserving kitchen batches).
"""
import app as core
from app import app
from customer_history import register_customer_history
import table_checks as table_checks_module
from table_checks import register_table_checks

# Operational completion (served/finished in the kitchen) is not the same as a
# settled restaurant bill. Keep any unpaid non-cancelled dine-in batch attached
# to its table check until payment closes the seating.
table_checks_module.OPEN_ORDER_SQL = "payment_status='unpaid' AND status<>'cancelled'"

register_customer_history(core)
register_table_checks(core)


@app.after_request
def inject_browser_helpers(response):
    if response.mimetype != 'text/html' or response.direct_passthrough:
        return response
    try:
        html = response.get_data(as_text=True)
    except Exception:
        return response

    # Admin/table-management QR images: local renderer, no third-party host.
    app_tag = '<script src="/static/app.js?v=27.3"></script>'
    qr_tag = '<script src="/static/qr-local.js?v=1"></script>'
    exports_tag = '<script src="/static/pos-runtime-exports.js?v=1"></script>'
    board_fix_tag = '<script src="/static/table-checks-board-fix.js?v=1"></script>'
    table_check_tag = '<script src="/static/table-checks.js?v=1"></script>'
    if app_tag in html and qr_tag not in html:
        html = html.replace(app_tag, app_tag + qr_tag, 1)
    if app_tag in html and exports_tag not in html:
        anchor = qr_tag if qr_tag in html else app_tag
        html = html.replace(anchor, anchor + exports_tag, 1)
    if app_tag in html and board_fix_tag not in html:
        anchor = exports_tag if exports_tag in html else (qr_tag if qr_tag in html else app_tag)
        html = html.replace(anchor, anchor + board_fix_tag, 1)
    if app_tag in html and table_check_tag not in html:
        # Load after the core SPA and state bridge so the grouped-table layer can
        # wrap the existing order-detail flow without duplicating the whole SPA.
        anchor = board_fix_tag if board_fix_tag in html else (exports_tag if exports_tag in html else (qr_tag if qr_tag in html else app_tag))
        html = html.replace(anchor, anchor + table_check_tag, 1)

    # Customer QR ordering: browser-session order history + "order more" flow.
    order_tag = '<script src="/static/order.js"></script>'
    history_tag = '<script src="/static/customer-history.js?v=1.0.1"></script>'
    if order_tag in html and history_tag not in html:
        html = html.replace(order_tag, order_tag + history_tag, 1)

    response.set_data(html)
    return response
