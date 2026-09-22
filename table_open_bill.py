"""One-open-bill behaviour for dine-in table ordering.

ZaabOS keeps one payable order open per occupied table by default. New QR
submissions on the same table append items to that order instead of creating a
second bill. Explicit split bills created by staff remain separate.

This is registered from wsgi.py as a before-request hook so the core order API
and schema stay backward compatible.
"""
from datetime import datetime, timedelta, timezone
from flask import request, jsonify

PUBLIC_TABLE_SUBMITS_PER_MINUTE = 15
_SPLIT_NOTE_PREFIX = 'แยกจากบิล #'


def register_table_open_bill(core):
    app = core.app
    if getattr(app, '_zaabos_table_open_bill_registered', False):
        return
    app._zaabos_table_open_bill_registered = True

    def _audit_event(conn, tenant_id, action, detail):
        conn.execute(
            'INSERT INTO audit_logs(tenant_id,user_id,action,detail,created_at) VALUES(?,?,?,?,?)',
            (tenant_id, None, action, detail, core.now()),
        )

    def _table_from_payload(conn, tenant_id, branch_id, data):
        token = (data.get('table_token') or '').strip()
        if token:
            return conn.execute(
                'SELECT * FROM dining_tables WHERE qr_token=? AND tenant_id=? AND branch_id=? AND active=1',
                (token, tenant_id, branch_id),
            ).fetchone()
        raw = data.get('table_id')
        if raw in (None, ''):
            return None
        try:
            table_id = int(raw)
        except (TypeError, ValueError):
            return None
        return conn.execute(
            'SELECT * FROM dining_tables WHERE id=? AND tenant_id=? AND branch_id=? AND active=1',
            (table_id, tenant_id, branch_id),
        ).fetchone()

    def _normal_open_orders(conn, tenant_id, branch_id, table_id):
        rows = conn.execute(
            """SELECT * FROM orders
               WHERE tenant_id=? AND branch_id=? AND table_id=? AND order_type='dine_in'
                 AND payment_status='unpaid' AND status NOT IN ('completed','cancelled')
               ORDER BY id ASC""",
            (tenant_id, branch_id, table_id),
        ).fetchall()
        # A staff-created split bill is intentionally separate. Normal staff/QR
        # orders on the same table are candidates for the single default bill.
        return [r for r in rows if not str(r['notes'] or '').startswith(_SPLIT_NOTE_PREFIX)]

    def _consolidate_open_orders(conn, orders):
        """Collapse legacy/default duplicate open orders without changing stock.

        Kitchen timestamps/options stay on their original item rows; only the
        owning order changes. This lets installations created before this guard
        converge to one bill the next time the table orders.
        """
        primary = orders[0]
        merged = []
        for duplicate in orders[1:]:
            conn.execute('UPDATE order_items SET order_id=? WHERE order_id=?',
                         (primary['id'], duplicate['id']))
            core._recalculate_order_total(conn, duplicate['id'])
            note = f'รวมอัตโนมัติเข้าบิล #{primary["order_no"]}'
            conn.execute(
                """UPDATE orders
                   SET status='cancelled', total_amount=0,
                       notes=CASE WHEN notes='' THEN ? ELSE notes || ? END,
                       updated_at=? WHERE id=?""",
                (note, ' | ' + note, core.now(), duplicate['id']),
            )
            merged.append(duplicate['id'])
        if merged:
            core._recalculate_order_total(conn, primary['id'])
        return primary, merged

    @app.before_request
    def append_public_table_order_to_open_bill():
        if request.path != '/api/public/orders' or request.method != 'POST':
            return None
        data = request.get_json(silent=True) or {}
        if (data.get('order_type') or 'dine_in') != 'dine_in':
            return None

        try:
            branch_id = int(data.get('branch_id'))
        except (TypeError, ValueError):
            return None  # core endpoint returns the canonical validation error

        conn = core.db()
        branch = conn.execute(
            'SELECT * FROM branches WHERE id=? AND active=1', (branch_id,)
        ).fetchone()
        if not branch or not core.tenant_active(conn, branch['tenant_id']):
            return None
        tenant_id = branch['tenant_id']
        table = _table_from_payload(conn, tenant_id, branch_id, data)
        if not table:
            return None

        table_id = table['id']
        lock_key = f'{tenant_id}:{branch_id}:{table_id}'
        core._lock_tx(conn, 'table_open_bill', lock_key)

        # Rate-limit submit actions rather than order-row count. Once a table
        # reuses one order, counting new order rows would no longer protect the
        # append path from a rapid abusive client.
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat(timespec='seconds')
        rate_detail = f'table:{branch_id}:{table_id}'
        rate = conn.execute(
            """SELECT COUNT(*) AS c FROM audit_logs
               WHERE tenant_id=? AND action='public_table_submit'
                 AND detail=? AND created_at>=?""",
            (tenant_id, rate_detail, cutoff),
        ).fetchone()
        if int(rate['c'] or 0) >= PUBLIC_TABLE_SUBMITS_PER_MINUTE:
            conn.rollback()
            return jsonify(error='มีการสั่งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'), 429

        open_orders = _normal_open_orders(conn, tenant_id, branch_id, table_id)
        _audit_event(conn, tenant_id, 'public_table_submit', rate_detail)
        if not open_orders:
            # Keep the table advisory lock open in this same request/transaction;
            # the core endpoint will create the first order and commit it.
            return None

        try:
            primary, merged = _consolidate_open_orders(conn, open_orders)
            prepared, _ = core._validate_and_price_cart(
                conn, tenant_id, branch_id, data.get('cart') or []
            )
            added_ids = []
            for item in prepared:
                cur = conn.execute(
                    """INSERT INTO order_items(
                         order_id,menu_item_id,item_name_snapshot,quantity,
                         unit_price,line_total,notes,kitchen_sent_at)
                       VALUES(?,?,?,?,?,?,?,?)""",
                    (primary['id'], item['menu_item_id'], item['item_name'],
                     item['quantity'], item['unit_price'], item['line_total'],
                     item['notes'], None),
                )
                item_id = cur.lastrowid
                if not item_id:
                    raise RuntimeError('table append item insert did not return an id')
                added_ids.append(item_id)
                for option in item['options']:
                    conn.execute(
                        """INSERT INTO order_item_options(
                             order_item_id,group_name_snapshot,option_name_snapshot,
                             price_delta_snapshot) VALUES(?,?,?,?)""",
                        (item_id, option['group_name'], option['option_name'],
                         option['price_delta']),
                    )
                core._decrement_stock(conn, tenant_id, item['menu_item_id'], item['quantity'])

            # A new kitchen round means a previously ready/served order must be
            # active again; otherwise KDS excludes `served` orders entirely.
            new_status = 'received' if primary['status'] in ('ready', 'served') else primary['status']
            total = core._recalculate_order_total(conn, primary['id'])
            conn.execute(
                'UPDATE orders SET status=?,updated_at=? WHERE id=?',
                (new_status, core.now(), primary['id']),
            )
            if merged:
                _audit_event(conn, tenant_id, 'public_table_auto_merge',
                             f'table:{table_id};primary:{primary["id"]};merged:{",".join(map(str, merged))}')
            conn.commit()
            return jsonify(
                ok=True,
                appended=True,
                order_id=primary['id'],
                order_no=primary['order_no'],
                total_amount=total,
                added_item_ids=added_ids,
                merged_order_ids=merged,
            )
        except ValueError as exc:
            conn.rollback()
            return jsonify(error=str(exc)), 400
        except Exception:
            conn.rollback()
            app.logger.exception('append_public_table_order_to_open_bill failed')
            return jsonify(error='เพิ่มรายการในบิลโต๊ะไม่สำเร็จ กรุณาลองอีกครั้ง'), 500
