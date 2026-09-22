"""Production WSGI entrypoint for ZaabOS.

Keeps the application module unchanged while adding the final Cloud Core V1
browser bootstrap needed by the local table-QR renderer. The QR renderer is
served from ZaabOS itself, so it works under the strict CSP on desktop, iPhone
and iPad without depending on a third-party QR image host.
"""
from app import app


@app.after_request
def inject_local_qr_renderer(response):
    if response.mimetype != 'text/html' or response.direct_passthrough:
        return response
    try:
        html = response.get_data(as_text=True)
    except Exception:
        return response

    app_tag = '<script src="/static/app.js?v=27.3"></script>'
    qr_tag = '<script src="/static/qr-local.js?v=1"></script>'
    if app_tag in html and qr_tag not in html:
        response.set_data(html.replace(app_tag, app_tag + qr_tag, 1))
    return response
