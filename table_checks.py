"""Table open-check / multi-batch billing for ZaabOS.

A dine-in table has one primary open check per seating by default. Every QR/staff
order remains its own order row (and therefore its own kitchen batch), while
cashier payment/receipt/reporting can operate on the logical table check.

Explicit bill splits are represented by secondary checks (accept_auto_join=0),
so later QR orders keep joining the primary bill instead of silently undoing a
staff-requested split.
"""
import json
import os
import re
import sqlite3
from decimal import Decimal
from flask import request, jsonify, g, session

MIGRATION_VERSION = 29
MIGRATION_NAME = 'table_open_checks'
OPEN_ORDER_SQL = "payment_status='unpaid' AND status NOT IN ('completed','cancelled')"


def register_table_checks(core):
    app = core.app
    if getattr(app, '_zaabos_table_checks_registered', False):
        return
    app._zaabos_table_checks_registered = True

    def standalone_conn():
        if core.IS_POSTGRES:
            return core.PGConn(os.getenv('DATABASE_URL'))
        conn = sqlite3.connect(core.DB)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        return conn

    def ensure_schema():
        conn = standalone_conn()
        try:
            idcol = 'INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY' if core.IS_POSTGRES else 'INTEGER PRIMARY KEY AUTOINCREMENT'
            conn.execute(f'''CREATE TABLE IF NOT EXISTS table_checks (
                id {idcol},
                tenant_id INTEGER NOT NULL,
                branch_id INTEGER NOT NULL,
                table_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                accept_auto_join INTEGER NOT NULL DEFAULT 1,
                opened_at TEXT NOT NULL,
                closed_at TEXT,
                paid_by_user_id INTEGER,
                payment_summary_json TEXT NOT NULL DEFAULT '{{}}'
            )''')
            conn.execute(f'''CREATE TABLE IF NOT EXISTS table_check_orders (
                id {idcol},
                check_id INTEGER NOT NULL,
                order_id INTEGER NOT NULL UNIQUE,
                attached_at TEXT NOT NULL
            )''')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_table_checks_scope ON table_checks(tenant_id,branch_id,table_id,status)')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_table_check_orders_check ON table_check_orders(check_id,order_id)')
            conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS uq_table_primary_open
                            ON table_checks(tenant_id,table_id)
                            WHERE status='open' AND accept_auto_join=1""")
            conn.commit()
            core.record_migration(conn, MIGRATION_VERSION, MIGRATION_NAME)
        finally:
            conn.close()

    ensure_schema()

    def row_dict(row):
        return dict(row) if row else None

    def check_for_order(conn, order_id):
        return conn.execute('''SELECT c.* FROM table_checks c
            JOIN table_check_orders co ON co.check_id=c.id
            WHERE co.order_id=? LIMIT 1''', (order_id,)).fetchone()

    def open_orders_for_check(conn, check_id, lock=False):
        sql = f'''SELECT o.* FROM orders o
                  JOIN table_check_orders co ON co.order_id=o.id
                  WHERE co.check_id=? AND o.{OPEN_ORDER_SQL}
                  ORDER BY o.id'''
        if lock and core.IS_POSTGRES:
            sql += ' FOR UPDATE OF o'
        return conn.execute(sql, (check_id,)).fetchall()

    def all_orders_for_check(conn, check_id):
        return conn.execute('''SELECT o.* FROM orders o
            JOIN table_check_orders co ON co.order_id=o.id
            WHERE co.check_id=? ORDER BY o.id''', (check_id,)).fetchall()

    def create_check(conn, order, accept_auto_join):
        cur = conn.execute('''INSERT INTO table_checks
            (tenant_id,branch_id,table_id,status,accept_auto_join,opened_at,payment_summary_json)
            VALUES(?,?,?,'open',?,?,?)''',
            (order['tenant_id'], order['branch_id'], order['table_id'],
             1 if accept_auto_join else 0, core.now(), '{}'))
        return cur.lastrowid

    def attach_order(conn, order_id, force_secondary=False):
        order = conn.execute('SELECT * FROM orders WHERE id=?', (order_id,)).fetchone()
        if not order or order['order_type'] != 'dine_in' or not order['table_id']:
            return None
        existing = check_for_order(conn, order_id)
        if existing:
            return existing['id']

        core._lock_tx(conn, 'table_check', f"{order['tenant_id']}:{order['table_id']}")
        check = None
        if not force_secondary:
            check = conn.execute('''SELECT * FROM table_checks
                WHERE tenant_id=? AND branch_id=? AND table_id=?
                  AND status='open' AND accept_auto_join=1
                ORDER BY id DESC LIMIT 1''',
                (order['tenant_id'], order['branch_id'], order['table_id'])).fetchone()
        if check:
            check_id = check['id']
        else:
            try:
                check_id = create_check(conn, order, not force_secondary)
            except core.INTEGRITY_ERRORS:
                conn.rollback()
                order = conn.execute('SELECT * FROM orders WHERE id=?', (order_id,)).fetchone()
                check = conn.execute('''SELECT * FROM table_checks
                    WHERE tenant_id=? AND branch_id=? AND table_id=?
                      AND status='open' AND accept_auto_join=1
                    ORDER BY id DESC LIMIT 1''',
                    (order['tenant_id'], order['branch_id'], order['table_id'])).fetchone()
                if not check:
                    raise
                check_id = check['id']
        try:
            conn.execute('INSERT INTO table_check_orders(check_id,order_id,attached_at) VALUES(?,?,?)',
                         (check_id, order_id, core.now()))
        except core.INTEGRITY_ERRORS:
            if core.IS_POSTGRES:
                conn.rollback()
            old = check_for_order(conn, order_id)
            return old['id'] if old else check_id
        return check_id

    def reconcile_check(conn, check_id):
        check = conn.execute('SELECT * FROM table_checks WHERE id=?', (check_id,)).fetchone()
        if not check or check['status'] != 'open':
            return
        active = open_orders_for_check(conn, check_id)
        if active:
            return
        row = conn.execute('''SELECT
              SUM(CASE WHEN o.payment_status='paid' THEN 1 ELSE 0 END) paid_count,
              COUNT(*) total_count,
              MAX(o.paid_at) paid_at
            FROM orders o JOIN table_check_orders co ON co.order_id=o.id
            WHERE co.check_id=? AND o.status!='cancelled' ''', (check_id,)).fetchone()
        paid = int((row['paid_count'] if row else 0) or 0)
        total = int((row['total_count'] if row else 0) or 0)
        if total and paid == total:
            conn.execute("UPDATE table_checks SET status='paid',closed_at=COALESCE(closed_at,?) WHERE id=?",
                         (row['paid_at'] or core.now(), check_id))
        else:
            conn.execute("UPDATE table_checks SET status='cancelled',closed_at=COALESCE(closed_at,?) WHERE id=?",
                         (core.now(), check_id))

    def backfill_open_checks(conn, tenant_id, branch_id=None):
        q = f'''SELECT o.* FROM orders o
            LEFT JOIN table_check_orders co ON co.order_id=o.id
            WHERE o.tenant_id=? AND o.order_type='dine_in' AND o.table_id IS NOT NULL
              AND o.{OPEN_ORDER_SQL} AND co.order_id IS NULL'''
        args = [tenant_id]
        if branch_id:
            q += ' AND o.branch_id=?'
            args.append(branch_id)
        q += ' ORDER BY o.table_id,o.id'
        for order in conn.execute(q, args).fetchall():
            secondary = 'แยกจากบิล #' in str(order['notes'] or '')
            attach_order(conn, order['id'], force_secondary=secondary)
        conn.commit()

    def check_payload(conn, check, include_orders=True):
        rows = open_orders_for_check(conn, check['id']) if check['status'] == 'open' else all_orders_for_check(conn, check['id'])
        orders = [core._order_with_items(conn, row) for row in rows] if include_orders else []
        subtotal = core.money_sum(row['total_amount'] or 0 for row in rows)
        return {
            'id': check['id'], 'tenant_id': check['tenant_id'], 'branch_id': check['branch_id'],
            'table_id': check['table_id'], 'status': check['status'],
            'accept_auto_join': bool(check['accept_auto_join']), 'opened_at': check['opened_at'],
            'closed_at': check['closed_at'], 'order_ids': [row['id'] for row in rows],
            'order_count': len(rows), 'subtotal': core.money_float(subtotal), 'orders': orders,
        }

    def load_scoped_check(conn, check_id, allow_closed=False):
        check = conn.execute('SELECT * FROM table_checks WHERE id=? AND tenant_id=?',
                             (check_id, g.tenant_id)).fetchone()
        if not check or (not allow_closed and check['status'] != 'open'):
            return None
        return check

    def allocation(total, weights):
        total = core.money_decimal(total)
        weights = [core.money_decimal(w) for w in weights]
        base = sum(weights, Decimal('0.00'))
        if not weights:
            return []
        if total == Decimal('0.00') or base <= Decimal('0.00'):
            out = [Decimal('0.00') for _ in weights]
            out[-1] = total
            return out
        out, used = [], Decimal('0.00')
        for i, w in enumerate(weights):
            if i == len(weights) - 1:
                part = core.money_decimal(total - used)
            else:
                part = core.money_decimal(total * w / base)
                used = core.money_decimal(used + part)
            out.append(part)
        residual = core.money_decimal(total - sum(out, Decimal('0.00')))
        out[-1] = core.money_decimal(out[-1] + residual)
        return out

    def quote(conn, check, payload):
        orders = open_orders_for_check(conn, check['id'])
        if not orders:
            raise ValueError('ไม่พบบิลค้างชำระของโต๊ะนี้')
        subtotal = core.money_sum(o['total_amount'] or 0 for o in orders)
        settings = core._pricing_settings(conn, check['branch_id'])
        discount = Decimal('0.00')
        label = ''
        promotion_id = None
        code = (payload.get('promotion_code') or '').strip()
        if code:
            promo = core._active_promotion(conn, code, check['branch_id'], core.money_float(subtotal))
            promotion_id = promo['id']
            label = promo['name']
            if promo['discount_type'] == 'percent':
                discount = core.money_decimal(subtotal * core.money_decimal(promo['discount_value']) / Decimal('100'))
            else:
                discount = core.money_decimal(promo['discount_value'])
            if promo['max_discount'] is not None:
                discount = min(discount, core.money_decimal(promo['max_discount']))
        manual = core.money_decimal(payload.get('discount_amount') or 0)
        if manual < 0 or manual > Decimal('1000000000'):
            raise ValueError('จำนวนส่วนลดไม่ถูกต้อง')
        if manual > 0:
            discount = core.money_decimal(discount + manual)
            label = (payload.get('discount_reason') or 'ส่วนลดพิเศษ')[:120]
        discount = min(core.money_decimal(discount), subtotal)
        base = max(Decimal('0.00'), subtotal - discount)
        service = core.money_decimal(base * Decimal(str(settings.get('service_charge_rate') or 0)) / Decimal('100'))
        tax = core.money_decimal((base + service) * Decimal(str(settings.get('tax_rate') or 0)) / Decimal('100'))
        due = core.money_decimal(base + service + tax)
        return {
            'orders': orders, 'subtotal_d': subtotal, 'discount_d': discount,
            'service_d': service, 'tax_d': tax, 'due_d': due,
            'promotion_id': promotion_id, 'discount_label': label, 'manual_discount_d': manual,
            'subtotal': core.money_float(subtotal), 'discount': core.money_float(discount),
            'service_charge': core.money_float(service), 'tax': core.money_float(tax),
            'amount': core.money_float(due),
        }

    def normalize_payments(payload, due):
        due = core.money_decimal(due)
        if due == Decimal('0.00'):
            return []
        parts = payload.get('payments')
        if not parts:
            parts = [{'method': payload.get('payment_method') or 'cash', 'amount': due,
                      'cash_received': payload.get('cash_received'), 'reference': payload.get('reference')}]
        if not isinstance(parts, list) or not parts:
            raise ValueError('กรุณาระบุการชำระเงิน')

        def amount(v, default=0):
            x = core.money_decimal(default if v in (None, '') else v)
            if x < 0 or x > Decimal('1000000000'):
                raise ValueError('จำนวนเงินไม่ถูกต้อง')
            return x

        explicit = core.money_sum(amount(p.get('amount')) for p in parts[1:]) if len(parts) > 1 else Decimal('0.00')
        normalized = []
        total = Decimal('0.00')
        for idx, p in enumerate(parts):
            method = (p.get('method') or '').strip()
            if method not in core.PAYMENT_METHODS:
                raise ValueError('วิธีชำระเงินไม่ถูกต้อง')
            raw = p.get('amount')
            part_amount = core.money_decimal(max(Decimal('0.00'), due - explicit)) if idx == 0 and len(parts) > 1 and raw in (None, '', 0, 0.0) else amount(raw, due if len(parts) == 1 else 0)
            if part_amount <= 0:
                raise ValueError('ยอดแต่ละช่องทางต้องมากกว่า 0')
            cash_received = amount(p.get('cash_received'), part_amount) if method == 'cash' else None
            if method == 'cash' and cash_received < part_amount:
                raise ValueError('เงินสดที่รับมาต้องไม่น้อยกว่ายอดเงินสด')
            normalized.append({'method': method, 'amount': part_amount, 'cash_received': cash_received,
                               'reference': (p.get('reference') or '')[:120]})
            total = core.money_decimal(total + part_amount)
        if total != due:
            raise ValueError(f'ยอดชำระรวมต้องเท่ากับ {due:.2f}')
        return normalized

    def distribute_payment_rows(normalized, order_dues):
        remaining = [core.money_decimal(x) for x in order_dues]
        rows = [[] for _ in order_dues]
        for part in normalized:
            left = part['amount']
            change = core.money_decimal((part['cash_received'] or Decimal('0.00')) - part['amount']) if part['method'] == 'cash' else Decimal('0.00')
            change_assigned = False
            for i in range(len(remaining)):
                if left <= 0:
                    break
                if remaining[i] <= 0:
                    continue
                take = min(left, remaining[i])
                cr = None
                if part['method'] == 'cash':
                    cr = core.money_decimal(take + (change if not change_assigned else Decimal('0.00')))
                    change_assigned = True
                rows[i].append({'method': part['method'], 'amount': take, 'cash_received': cr,
                                'reference': part['reference']})
                left = core.money_decimal(left - take)
                remaining[i] = core.money_decimal(remaining[i] - take)
            if left != Decimal('0.00'):
                raise ValueError('ไม่สามารถกระจายยอดชำระไปยังรายการในบิลได้')
        if any(x != Decimal('0.00') for x in remaining):
            raise ValueError('ยอดชำระยังไม่ครบทุกออเดอร์ในโต๊ะ')
        return rows

    @app.get('/api/table-checks')
    @core.login_required
    def list_table_checks():
        if g.tenant_id is None:
            return jsonify(checks=[])
        try:
            branch_id = core._query_int_arg('branch_id')
        except ValueError:
            return jsonify(error='branch_id ไม่ถูกต้อง'), 400
        conn = core.db()
        backfill_open_checks(conn, g.tenant_id, branch_id)
        q = "SELECT * FROM table_checks WHERE tenant_id=? AND status='open'"
        args = [g.tenant_id]
        if branch_id:
            q += ' AND branch_id=?'
            args.append(branch_id)
        q += ' ORDER BY table_id,id'
        out = []
        for check in conn.execute(q, args).fetchall():
            reconcile_check(conn, check['id'])
            fresh = conn.execute('SELECT * FROM table_checks WHERE id=?', (check['id'],)).fetchone()
            if fresh and fresh['status'] == 'open':
                out.append(check_payload(conn, fresh))
        conn.commit()
        return jsonify(checks=out)

    @app.get('/api/table-checks/by-order/<int:order_id>')
    @core.login_required
    def table_check_by_order(order_id):
        conn = core.db()
        order = conn.execute('SELECT * FROM orders WHERE id=? AND tenant_id=?', (order_id, g.tenant_id)).fetchone()
        if not order:
            return jsonify(error='ไม่พบออเดอร์'), 404
        check = check_for_order(conn, order_id)
        if not check and order['order_type'] == 'dine_in' and order['table_id'] and order['payment_status'] == 'unpaid':
            check_id = attach_order(conn, order_id)
            conn.commit()
            check = conn.execute('SELECT * FROM table_checks WHERE id=?', (check_id,)).fetchone() if check_id else None
        if not check:
            return jsonify(check=None)
        return jsonify(check=check_payload(conn, check))

    @app.post('/api/table-checks/<int:check_id>/quote')
    @core.login_required
    @core.role_required('owner', 'manager', 'staff')
    def table_check_quote(check_id):
        conn = core.db()
        check = load_scoped_check(conn, check_id)
        if not check:
            return jsonify(error='ไม่พบบิลโต๊ะที่เปิดอยู่'), 404
        try:
            q = quote(conn, check, request.get_json(silent=True) or {})
        except ValueError as e:
            return jsonify(error=str(e)), 400
        return jsonify({k: v for k, v in q.items() if not k.endswith('_d') and k != 'orders'})

    @app.post('/api/table-checks/<int:check_id>/payment')
    @core.login_required
    @core.role_required('owner', 'manager', 'staff')
    def table_check_payment(check_id):
        conn = core.db()
        core._lock_tx(conn, 'table_check_payment', f'{g.tenant_id}:{check_id}')
        check_sql = 'SELECT * FROM table_checks WHERE id=? AND tenant_id=?'
        if core.IS_POSTGRES:
            check_sql += ' FOR UPDATE'
        check = conn.execute(check_sql, (check_id, g.tenant_id)).fetchone()
        if not check or check['status'] != 'open':
            return jsonify(error='บิลโต๊ะนี้ปิดหรือถูกชำระจากอุปกรณ์อื่นแล้ว'), 409
        payload = request.get_json(silent=True) or {}
        try:
            q = quote(conn, check, payload)
            orders = q['orders']
            normalized = normalize_payments(payload, q['due_d'])
        except Exception as e:
            if isinstance(e, ValueError):
                return jsonify(error=str(e)), 400
            raise

        approved_by = None
        if q['manual_discount_d'] > 0:
            approved_by, err = core._critical_approval(conn, payload)
            if err:
                return err

        weights = [core.money_decimal(o['total_amount'] or 0) for o in orders]
        discounts = allocation(q['discount_d'], weights)
        bases = [max(Decimal('0.00'), weights[i] - discounts[i]) for i in range(len(weights))]
        services = allocation(q['service_d'], bases)
        tax_weights = [core.money_decimal(bases[i] + services[i]) for i in range(len(weights))]
        taxes = allocation(q['tax_d'], tax_weights)
        order_dues = [core.money_decimal(bases[i] + services[i] + taxes[i]) for i in range(len(weights))]
        try:
            distributed = distribute_payment_rows(normalized, order_dues) if normalized else [[] for _ in orders]
        except ValueError as e:
            return jsonify(error=str(e)), 400

        ts = core.now()
        payment_method = 'split' if len(normalized) > 1 else (normalized[0]['method'] if normalized else 'other')
        try:
            for idx, order in enumerate(orders):
                order_cash = core.money_sum((r['cash_received'] or 0) for r in distributed[idx] if r['method'] == 'cash') if distributed[idx] else Decimal('0.00')
                claimed = conn.execute("""UPDATE orders SET payment_status='paid',payment_method=?,
                    tax_amount=?,service_charge_amount=?,discount_amount=?,discount_label=?,promotion_id=?,
                    cash_received=?,paid_at=?,updated_at=?,status='completed'
                    WHERE id=? AND tenant_id=? AND payment_status='unpaid' AND status<>'cancelled'""",
                    (payment_method, core.money_float(taxes[idx]), core.money_float(services[idx]),
                     core.money_float(discounts[idx]), q['discount_label'], q['promotion_id'],
                     core.money_float(order_cash) if order_cash > 0 else None,
                     ts, ts, order['id'], g.tenant_id))
                if getattr(claimed, 'rowcount', 1) != 1:
                    conn.rollback()
                    return jsonify(error='บิลถูกเปลี่ยนจากอุปกรณ์อื่น กรุณารีเฟรช'), 409
                for leg in distributed[idx]:
                    conn.execute('''INSERT INTO payments
                        (tenant_id,branch_id,order_id,amount,payment_method,cash_received,reference,paid_by_user_id,paid_at)
                        VALUES(?,?,?,?,?,?,?,?,?)''',
                        (g.tenant_id, check['branch_id'], order['id'], core.money_float(leg['amount']),
                         leg['method'], core.money_float(leg['cash_received']) if leg['cash_received'] is not None else None,
                         leg['reference'], g.user['id'], ts))
            if q['manual_discount_d'] > 0:
                core._record_critical(conn, 'discount', check['branch_id'], 'table_check', check_id,
                                      q['discount_label'], approved_by,
                                      f"manual_discount={q['manual_discount_d']}")
            summary = {
                'amount': q['amount'], 'subtotal': q['subtotal'], 'discount': q['discount'],
                'service_charge': q['service_charge'], 'tax': q['tax'], 'payment_method': payment_method,
                'payments': [{'method': p['method'], 'amount': core.money_float(p['amount']),
                              'cash_received': core.money_float(p['cash_received']) if p['cash_received'] is not None else None}
                             for p in normalized],
            }
            conn.execute("""UPDATE table_checks SET status='paid',closed_at=?,paid_by_user_id=?,
                            payment_summary_json=? WHERE id=? AND tenant_id=? AND status='open'""",
                         (ts, g.user['id'], json.dumps(summary, ensure_ascii=False), check_id, g.tenant_id))
            core.log_action('table_check_payment_completed',
                            detail=f"check={check_id} orders={len(orders)} due={q['due_d']}")
            conn.commit()
        except Exception:
            conn.rollback()
            app.logger.exception('table check payment failed')
            return jsonify(error='บันทึกการชำระบิลโต๊ะไม่สำเร็จ'), 500

        change = core.money_sum(max(Decimal('0.00'), (p['cash_received'] or Decimal('0.00')) - p['amount'])
                                for p in normalized if p['method'] == 'cash')
        return jsonify(ok=True, table_check_id=check_id, amount=q['amount'],
                       payments=[{'method': p['method'], 'amount': core.money_float(p['amount'])} for p in normalized],
                       change=core.money_float(change), order_ids=[o['id'] for o in orders])

    @app.get('/api/table-checks/<int:check_id>/receipt')
    @core.login_required
    @core.role_required('owner', 'manager', 'staff')
    def table_check_receipt(check_id):
        conn = core.db()
        check = load_scoped_check(conn, check_id, allow_closed=True)
        if not check:
            return jsonify(error='ไม่พบบิลโต๊ะนี้'), 404
        rows = all_orders_for_check(conn, check_id)
        orders = [core._order_with_items(conn, r) for r in rows if r['status'] != 'cancelled']
        if not orders:
            return jsonify(error='บิลนี้ไม่มีรายการ'), 404
        payments = conn.execute('''SELECT p.amount,p.payment_method,p.cash_received,p.reference,p.paid_at,p.order_id
            FROM payments p JOIN table_check_orders co ON co.order_id=p.order_id
            WHERE co.check_id=? AND p.tenant_id=? AND p.reversed_at IS NULL ORDER BY p.id''',
            (check_id, g.tenant_id)).fetchall()
        subtotal = core.money_sum(o['total_amount'] or 0 for o in orders)
        discount = core.money_sum(o['discount_amount'] or 0 for o in orders)
        service = core.money_sum(o['service_charge_amount'] or 0 for o in orders)
        tax = core.money_sum(o['tax_amount'] or 0 for o in orders)
        total = core.money_decimal(subtotal - discount + service + tax)
        table_name = orders[0]['table_name_snapshot'] if orders else ''
        return jsonify(
            check={k: row_dict(check).get(k) for k in ('id','status','opened_at','closed_at','table_id')},
            table_name=table_name, orders=orders,
            subtotal=core.money_float(subtotal), discount=core.money_float(discount),
            service_charge=core.money_float(service), tax=core.money_float(tax), total=core.money_float(total),
            payments=[dict(p) for p in payments],
        )

    @app.put('/api/table-checks/<int:check_id>/move')
    @core.login_required
    @core.role_required('owner', 'manager', 'staff')
    def move_table_check(check_id):
        conn = core.db()
        core._lock_tx(conn, 'table_check_move', f'{g.tenant_id}:{check_id}')
        check = load_scoped_check(conn, check_id)
        if not check:
            return jsonify(error='ไม่พบบิลโต๊ะที่เปิดอยู่'), 404
        try:
            table_id = int((request.get_json(silent=True) or {}).get('table_id'))
        except (TypeError, ValueError):
            return jsonify(error='กรุณาเลือกโต๊ะปลายทาง'), 400
        if table_id == check['table_id']:
            return jsonify(ok=True)
        table = conn.execute('''SELECT * FROM dining_tables
            WHERE id=? AND tenant_id=? AND branch_id=? AND active=1''',
            (table_id, g.tenant_id, check['branch_id'])).fetchone()
        if not table:
            return jsonify(error='โต๊ะปลายทางไม่ถูกต้อง'), 400
        occupied = conn.execute(f'''SELECT id FROM orders WHERE tenant_id=? AND branch_id=? AND table_id=?
            AND {OPEN_ORDER_SQL} LIMIT 1''', (g.tenant_id, check['branch_id'], table_id)).fetchone()
        if occupied:
            return jsonify(error='โต๊ะปลายทางมีบิลเปิดอยู่ กรุณาปิดหรือรวมบิลก่อน'), 409
        rows = open_orders_for_check(conn, check_id, lock=True)
        if not rows:
            return jsonify(error='บิลนี้ไม่มีออเดอร์ที่ย้ายได้'), 409
        ts = core.now()
        for order in rows:
            conn.execute('UPDATE orders SET table_id=?,table_name_snapshot=?,updated_at=? WHERE id=? AND tenant_id=?',
                         (table_id, table['name'], ts, order['id'], g.tenant_id))
        conn.execute('UPDATE table_checks SET table_id=? WHERE id=? AND tenant_id=?',
                     (table_id, check_id, g.tenant_id))
        core.log_action('move_table_check', detail=f"check={check_id}: {check['table_id']}->{table_id}")
        conn.commit()
        return jsonify(ok=True, table_id=table_id, table_name=table['name'])

    @app.post('/api/table-checks/<int:check_id>/reopen')
    @core.login_required
    @core.role_required('owner', 'manager', 'staff')
    def reopen_table_check(check_id):
        conn = core.db()
        core._lock_tx(conn, 'table_check_reopen', f'{g.tenant_id}:{check_id}')
        check = load_scoped_check(conn, check_id, allow_closed=True)
        if not check or check['status'] != 'paid':
            return jsonify(error='เปิดกลับได้เฉพาะบิลโต๊ะที่ชำระแล้ว'), 409
        conflict = conn.execute("""SELECT id FROM table_checks WHERE tenant_id=? AND table_id=?
            AND status='open' AND accept_auto_join=1 AND id<>? LIMIT 1""",
            (g.tenant_id, check['table_id'], check_id)).fetchone()
        if conflict:
            return jsonify(error='โต๊ะนี้มีบิลรอบใหม่เปิดอยู่แล้ว ไม่สามารถเปิดบิลเก่ากลับมาชนกันได้'), 409
        orders = conn.execute('''SELECT o.* FROM orders o JOIN table_check_orders co ON co.order_id=o.id
            WHERE co.check_id=? AND o.tenant_id=? AND o.payment_status='paid' ORDER BY o.id''',
            (check_id, g.tenant_id)).fetchall()
        if not orders:
            return jsonify(error='ไม่พบออเดอร์ที่ชำระแล้วในบิลนี้'), 409
        order_ids = [o['id'] for o in orders]
        marks = ','.join('?' for _ in order_ids)
        if conn.execute(f'SELECT id FROM refunds WHERE tenant_id=? AND order_id IN ({marks}) LIMIT 1',
                        [g.tenant_id, *order_ids]).fetchone():
            return jsonify(error='บิลนี้มีการคืนเงินแล้ว ไม่สามารถเปิดกลับมาแก้ไขได้'), 409
        payments = conn.execute(f'''SELECT p.* FROM payments p
            WHERE p.tenant_id=? AND p.order_id IN ({marks}) AND p.reversed_at IS NULL ORDER BY p.id''',
            [g.tenant_id, *order_ids]).fetchall()
        if not payments:
            return jsonify(error='ไม่พบรายการชำระเงินที่ใช้งานอยู่'), 409
        payload = request.get_json(silent=True) or {}
        reason = (payload.get('reason') or '').strip()[:300]
        if len(reason) < 2:
            return jsonify(error='กรุณาระบุเหตุผลการเปิดบิลกลับมาแก้ไข'), 400
        approved_by, err = core._critical_approval(conn, payload)
        if err:
            return err
        shift_id = None
        if any(p['payment_method'] == 'cash' for p in payments):
            sh = conn.execute("""SELECT id FROM work_shifts WHERE tenant_id=? AND branch_id=?
                AND opened_by_user_id=? AND status='open' ORDER BY id DESC LIMIT 1""",
                (g.tenant_id, check['branch_id'], g.user['id'])).fetchone()
            if not sh:
                return jsonify(error='กรุณาเปิดกะก่อนเปิดบิลเงินสดกลับมาแก้ไข'), 409
            shift_id = sh['id']
        ts = core.now()
        conn.execute(f'''UPDATE payments SET reversed_at=?,reversed_by_user_id=?,reversal_reason=?,reversed_shift_id=?
            WHERE tenant_id=? AND order_id IN ({marks}) AND reversed_at IS NULL''',
            [ts, g.user['id'], reason, shift_id, g.tenant_id, *order_ids])
        for order in orders:
            conn.execute("""UPDATE orders SET payment_status='unpaid',payment_method=NULL,cash_received=NULL,paid_at=NULL,
                tax_amount=0,service_charge_amount=0,discount_amount=0,discount_label='',promotion_id=NULL,
                status='served',updated_at=? WHERE id=? AND tenant_id=?""",
                (ts, order['id'], g.tenant_id))
        conn.execute("""UPDATE table_checks SET status='open',accept_auto_join=1,closed_at=NULL,
            paid_by_user_id=NULL,payment_summary_json='{}' WHERE id=? AND tenant_id=?""",
            (check_id, g.tenant_id))
        core._record_critical(conn, 'reopen_paid_order', check['branch_id'], 'table_check', check_id,
                              reason, approved_by, f"orders={len(orders)} payments={len(payments)}")
        core.log_action('reopen_table_check', detail=f'check={check_id} orders={len(orders)}')
        conn.commit()
        return jsonify(ok=True, table_check_id=check_id, table_id=check['table_id'])

    def logical_bill_count(conn, tenant_id, start, end, branch_id=None, open_only=False):
        if open_only:
            q = '''SELECT o.id,co.check_id FROM orders o
                LEFT JOIN table_check_orders co ON co.order_id=o.id
                WHERE o.tenant_id=? AND o.payment_status='unpaid' AND o.status!='cancelled' '''
            args = [tenant_id]
        else:
            q = '''SELECT o.id,co.check_id FROM orders o
                LEFT JOIN table_check_orders co ON co.order_id=o.id
                WHERE o.tenant_id=? AND o.payment_status='paid' AND o.status!='cancelled'
                  AND COALESCE(o.paid_at,o.created_at)>=? AND COALESCE(o.paid_at,o.created_at)<?'''
            args = [tenant_id, start, end]
        if branch_id:
            q += ' AND o.branch_id=?'
            args.append(branch_id)
        rows = conn.execute(q, args).fetchall()
        keys = {('check', r['check_id']) if r['check_id'] else ('order', r['id']) for r in rows}
        return len(keys), len(rows)

    def shift_bill_count(conn, tenant_id, branch_id, user_id, opened_at, closed_at=None):
        q = '''SELECT p.order_id,co.check_id FROM payments p
            LEFT JOIN table_check_orders co ON co.order_id=p.order_id
            WHERE p.tenant_id=? AND p.branch_id=? AND p.paid_by_user_id=?
              AND p.paid_at>=? AND p.reversed_at IS NULL'''
        args = [tenant_id, branch_id, user_id, opened_at]
        if closed_at:
            q += ' AND p.paid_at<?'
            args.append(closed_at)
        rows = conn.execute(q, args).fetchall()
        keys = {('check', r['check_id']) if r['check_id'] else ('order', r['order_id']) for r in rows}
        return len(keys), len({r['order_id'] for r in rows})

    @app.before_request
    def protect_grouped_core_actions():
        if request.method not in ('PUT', 'POST') or not request.path.startswith('/api/orders/'):
            return None
        conn = core.db()
        user = core.get_current_user(conn)
        if not user:
            return None
        tenant_id = core.effective_tenant_id(conn, user)
        if tenant_id in (None, 'all'):
            return None
        token = request.headers.get('X-CSRF-Token')
        if not token or token != session.get('csrf_token'):
            return None
        g.user = user
        g.tenant_id = tenant_id
        m = re.fullmatch(r'/api/orders/(\d+)/(payment|reopen)', request.path)
        if m:
            oid = int(m.group(1))
            check = check_for_order(conn, oid)
            if check:
                meaningful = [o for o in all_orders_for_check(conn, check['id']) if o['status'] != 'cancelled']
                if len(meaningful) > 1:
                    if m.group(2) == 'payment' and check['status'] == 'open':
                        return jsonify(error='โต๊ะนี้มีหลายรอบสั่ง กรุณาชำระจากปุ่ม “ชำระทั้งโต๊ะ”'), 409
                    if m.group(2) == 'reopen' and check['status'] == 'paid':
                        return jsonify(error='บิลนี้เป็นบิลรวมโต๊ะ กรุณาเปิดบิลรวมกลับมาแก้ไข'), 409
        m = re.fullmatch(r'/api/orders/(\d+)/move-table', request.path)
        if m:
            oid = int(m.group(1))
            check = check_for_order(conn, oid)
            if check and check['status'] == 'open' and len(open_orders_for_check(conn, check['id'])) > 1:
                return jsonify(error='โต๊ะนี้มีหลายรอบสั่ง กรุณาย้ายทั้งบิลโต๊ะพร้อมกัน'), 409
        return None

    @app.after_request
    def maintain_table_checks(response):
        try:
            conn = core.db()
            path = request.path
            body = response.get_json(silent=True) if response.is_json else None
            if response.status_code == 200 and request.method == 'POST' and path in ('/api/public/orders', '/api/orders'):
                oid = (body or {}).get('order_id')
                if oid:
                    attach_order(conn, int(oid))
                    conn.commit()
            elif response.status_code == 200 and request.method == 'POST':
                m = re.fullmatch(r'/api/orders/(\d+)/split', path)
                if m:
                    new_id = (body or {}).get('new_order_id')
                    if new_id:
                        attach_order(conn, int(new_id), force_secondary=True)
                        conn.commit()
                m2 = re.fullmatch(r'/api/orders/(\d+)/merge', path)
                if m2:
                    source_check = check_for_order(conn, int(m2.group(1)))
                    if source_check:
                        reconcile_check(conn, source_check['id'])
                        conn.commit()
            if response.status_code == 200 and request.method == 'PUT':
                m = re.fullmatch(r'/api/orders/(\d+)/payment', path)
                if m:
                    check = check_for_order(conn, int(m.group(1)))
                    if check:
                        reconcile_check(conn, check['id'])
                        conn.commit()
                m = re.fullmatch(r'/api/orders/(\d+)/move-table', path)
                if m:
                    order = conn.execute('SELECT * FROM orders WHERE id=?', (int(m.group(1)),)).fetchone()
                    check = check_for_order(conn, int(m.group(1)))
                    if order and check and check['status'] == 'open':
                        conn.execute('UPDATE table_checks SET table_id=? WHERE id=?', (order['table_id'], check['id']))
                        conn.commit()

            if response.status_code == 200 and response.is_json and getattr(g, 'tenant_id', None):
                if path == '/api/reports/summary' and request.method == 'GET':
                    data = response.get_json(silent=True) or {}
                    frm = (request.args.get('from') or core.restaurant_today())[:10]
                    to = (request.args.get('to') or core.restaurant_today())[:10]
                    if frm > to:
                        frm, to = to, frm
                    start, end = core.local_range_bounds_utc(frm, to)
                    branch_id = request.args.get('branch_id')
                    try:
                        branch_id = int(branch_id) if branch_id else None
                    except ValueError:
                        branch_id = None
                    bills, batches = logical_bill_count(conn, g.tenant_id, start, end, branch_id)
                    open_bills, open_batches = logical_bill_count(conn, g.tenant_id, None, None, branch_id, open_only=True)
                    data['order_batch_count'] = data.get('order_count', batches)
                    data['order_count'] = bills
                    data['average_bill'] = (float(data.get('total_sales') or 0) / bills) if bills else 0
                    data['open_order_batch_count'] = data.get('open_order_count', open_batches)
                    data['open_order_count'] = open_bills
                    response.set_data(json.dumps(data, ensure_ascii=False))
                elif path == '/api/operations/shift' and request.method == 'GET':
                    data = response.get_json(silent=True) or {}
                    sh = data.get('shift')
                    summary = data.get('summary')
                    if sh and summary:
                        bills, batches = shift_bill_count(conn, g.tenant_id, sh['branch_id'],
                                                          sh['opened_by_user_id'], sh['opened_at'], sh.get('closed_at'))
                        summary['order_batch_count'] = summary.get('bill_count', batches)
                        summary['bill_count'] = bills
                        data['summary'] = summary
                        response.set_data(json.dumps(data, ensure_ascii=False))
                elif path == '/api/operations/shifts' and request.method == 'GET':
                    data = response.get_json(silent=True)
                    if isinstance(data, list):
                        for sh in data:
                            summary = sh.get('summary') or {}
                            bills, batches = shift_bill_count(conn, g.tenant_id, sh['branch_id'],
                                                              sh['opened_by_user_id'], sh['opened_at'], sh.get('closed_at'))
                            summary['order_batch_count'] = summary.get('bill_count', batches)
                            summary['bill_count'] = bills
                            sh['summary'] = summary
                        response.set_data(json.dumps(data, ensure_ascii=False))
        except Exception:
            app.logger.exception('table check maintenance failed')
        return response
