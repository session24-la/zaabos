"""Production WSGI entrypoint for ZaabOS.

Keeps the core application module unchanged while adding browser/runtime helpers:
local QR rendering, QR customer history, and one-open-bill table ordering.
"""
import app as core
from app import app
from customer_history import register_customer_history
from table_open_bill import register_table_open_bill

# Registration order matters: validate the public customer session first, then
# let the table-bill hook decide whether a dine-in submit creates or appends.
register_customer_history(core)
register_table_open_bill(core)


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
    if app_tag in html and qr_tag not in html:
        html = html.replace(app_tag, app_tag + qr_tag, 1)

    # Customer QR ordering: table/session order history + "order more" flow.
    order_tag = '<script src="/static/order.js"></script>'
    history_tag = '<script src="/static/customer-history.js?v=1.1"></script>'
    if order_tag in html and history_tag not in html:
        html = html.replace(order_tag, order_tag + history_tag, 1)

    response.set_data(html)
    return response
