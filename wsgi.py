"""Production WSGI entrypoint for ZaabOS.

Keeps the core application module unchanged while adding browser/runtime helpers:
local QR rendering, QR customer history, and one-open-bill table ordering.
"""
import re
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
    # Match app.js at any ?v= so bumping the asset version can never silently drop the QR renderer.
    qr_tag = '<script src="/static/qr-local.js?v=1"></script>'
    m = re.search(r'<script src="/static/app\.js(?:\?v=[^"]*)?"></script>', html)
    if m and qr_tag not in html:
        html = html[:m.end()] + qr_tag + html[m.end():]

    # Customer QR ordering: table/session order history + "order more" flow.
    history_tag = '<script src="/static/customer-history.js?v=1.3"></script>'
    m = re.search(r'<script src="/static/order\.js(?:\?v=[^"]*)?"></script>', html)
    if m and history_tag not in html:
        html = html[:m.end()] + history_tag + html[m.end():]

    response.set_data(html)
    return response
