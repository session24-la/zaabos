"""QR customer order history for ZaabOS.

Per-table QR pages expose the current open table bill to every guest who scanned
that physical table QR. Generic QR/takeaway/delivery flows keep the original
browser-scoped opaque session history. No order number or phone lookup is needed.
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
            active_qty = max(0, int(it.get('quantity') or 0) - int(it.get('cancelled_quantity') or 0))
            if active_qty <= 0:
                continue
            items.append({
                'item_name_snapshot': it.get('item_name_snapshot'),
                'quantity': active_qty,
                'unit_price': it.get('unit_price'),
                'line_total': float(it.get('unit_price') or 0) * active_qty,
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
        """Attach generic/browser history metadata after a successful submit.

        Per-table history does not depend on this single device field; it is
        authorized by the physical table QR token instead, so several phones at
        the same table can all see the same open bill.
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

        conn = core.db()
        branch = conn.execute(
            'SELECT tenant_id FROM branches WHERE id=? AND active=1', (branch_id,)
        ).fetchone()
        if not branch or not core.tenant_active(conn, branch['tenant_id']):
            return jsonify(error='ไม่พบสาขานี้'), 404
        tenant_id = branch['tenant_id']
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=PUBLIC_ORDER_SESSION_TTL_HOURS)).isoformat(timespec='seconds')

        # Physical table QR = table-session scope. Any guest at that table sees
        # the same currently-open bill, which is exactly what lets three phones
        # order together without requiring a shared order number or phone.
        table_token = (data.get('table_token') or '').strip()
        if table_token:
            table = conn.execute(
                'SELECT id FROM dining_tables WHERE qr_token=? AND tenant_id=? AND branch_id=? AND active=1',
                (table_token, tenant_id, branch_id),
            ).fetchone()
            if not table:
                return jsonify(error='ไม่พบโต๊ะนี้ กรุณาสแกน QR ใหม่'), 404
            rows = conn.execute(
                """SELECT * FROM orders
                   WHERE tenant_id=? AND branch_id=? AND table_id=? AND order_type='dine_in'
                     AND payment_status='unpaid' AND status NOT IN ('completed','cancelled')
                   ORDER BY id ASC LIMIT 20""",
                (tenant_id, branch_id, table['id']),
            ).fetchall()
            return jsonify(
                orders=[public_order_view(conn, row) for row in rows],
                ttl_hours=PUBLIC_ORDER_SESSION_TTL_HOURS,
                scope='table',
            )

        # Generic QR / non-table order: preserve per-device session isolation.
        digest = session_hash(data.get('public_session_token'))
        if not digest:
            return jsonify(error='ไม่พบเซสชันการสั่งอาหาร กรุณาสแกน QR ใหม่'), 400
        rows = conn.execute(
            """SELECT * FROM orders
               WHERE tenant_id=? AND branch_id=? AND placed_by='customer'
                 AND client_device_id=? AND created_at>=?
               ORDER BY id DESC LIMIT 20""",
            (tenant_id, branch_id, digest, cutoff),
        ).fetchall()
        return jsonify(
            orders=[public_order_view(conn, row) for row in rows],
            ttl_hours=PUBLIC_ORDER_SESSION_TTL_HOURS,
            scope='device',
        )
