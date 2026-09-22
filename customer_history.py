"""QR customer order-session history for ZaabOS.

This module is registered by the production WSGI entrypoint. It adds a private,
browser-scoped order history without asking the customer for an order number or
phone number. The browser keeps a random opaque token; only its SHA-256 digest is
stored in orders.client_device_id, which is already indexed by the core schema.
"""
import hashlib
from datetime import datetime, timedelta, timezone
from flask import request, jsonify

PUBLIC_ORDER_SESSION_TTL_HOURS = 12


def register_customer_history(core):
    app = core.app
    if getattr(app, '_zaabos_customer_history_registered', False):
        return
    app._zaabos_customer_history_registered = True

    def session_hash(token):
        raw = (token or '').strip()
        if not raw:
            return None
        if len(raw) < 16 or len(raw) > 128:
            return None
        return 'public:' + hashlib.sha256(raw.encode('utf-8')).hexdigest()

    def public_order_view(conn, order):
        full = core._order_with_items(conn, order)
        items = []
        for it in full.get('items', []):
            items.append({
                'item_name_snapshot': it.get('item_name_snapshot'),
                'quantity': it.get('quantity'),
                'unit_price': it.get('unit_price'),
                'line_total': it.get('line_total'),
                'notes': it.get('notes') or '',
                'options': [
                    {'option_name_snapshot': opt.get('option_name_snapshot')}
                    for opt in (it.get('options') or [])
                ],
            })
        return {
            'order_no': full.get('order_no'),
            'order_type': full.get('order_type'),
            'table_name_snapshot': full.get('table_name_snapshot'),
            'status': full.get('status'),
            'payment_status': full.get('payment_status'),
            'total_amount': full.get('total_amount'),
            'created_at': full.get('created_at'),
            'updated_at': full.get('updated_at'),
            'items': items,
        }

    @app.before_request
    def validate_public_order_session_token():
        if request.path != '/api/public/orders' or request.method != 'POST':
            return None
        data = request.get_json(silent=True) or {}
        raw = (data.get('public_session_token') or '').strip()
        if raw and not session_hash(raw):
            return jsonify(error='เซสชันการสั่งอาหารไม่ถูกต้อง กรุณาสแกน QR ใหม่'), 400
        return None

    @app.after_request
    def attach_public_order_session(response):
        """Attach the opaque browser session to a successfully-created order.

        The core order transaction has already committed at this point. This
        secondary update is deliberately best-effort: an order must never be
        reported as failed merely because history metadata could not be saved,
        which would tempt the customer to submit a duplicate order.
        """
        if request.path != '/api/public/orders' or request.method != 'POST' or response.status_code != 200:
            return response
        try:
            data = request.get_json(silent=True) or {}
            digest = session_hash(data.get('public_session_token'))
            body = response.get_json(silent=True) or {}
            order_id = body.get('order_id')
            if digest and order_id:
                conn = core.db()
                conn.execute(
                    "UPDATE orders SET client_device_id=? WHERE id=? AND placed_by='customer'",
                    (digest, order_id),
                )
                conn.commit()
        except Exception:
            app.logger.exception('customer history metadata update failed')
        return response

    @app.post('/api/public/orders/history')
    def public_order_session_history():
        data = request.get_json(silent=True) or {}
        try:
            branch_id = int(data.get('branch_id'))
        except (TypeError, ValueError):
            return jsonify(error='branch_id ไม่ถูกต้อง'), 400
        digest = session_hash(data.get('public_session_token'))
        if not digest:
            return jsonify(error='ไม่พบเซสชันการสั่งอาหาร กรุณาสแกน QR ใหม่'), 400

        conn = core.db()
        branch = conn.execute(
            'SELECT tenant_id FROM branches WHERE id=? AND active=1', (branch_id,)
        ).fetchone()
        if not branch or not core.tenant_active(conn, branch['tenant_id']):
            return jsonify(error='ไม่พบสาขานี้'), 404

        cutoff = (datetime.now(timezone.utc) - timedelta(hours=PUBLIC_ORDER_SESSION_TTL_HOURS)).isoformat(timespec='seconds')
        rows = conn.execute(
            """SELECT * FROM orders
               WHERE tenant_id=? AND branch_id=? AND placed_by='customer'
                 AND client_device_id=? AND created_at>=?
               ORDER BY id DESC LIMIT 20""",
            (branch['tenant_id'], branch_id, digest, cutoff),
        ).fetchall()
        return jsonify(
            orders=[public_order_view(conn, row) for row in rows],
            ttl_hours=PUBLIC_ORDER_SESSION_TTL_HOURS,
        )
