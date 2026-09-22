"""Non-production integration test for QR customer order history.

Refuses to run when DATABASE_URL is present. Uses local SQLite only.
"""
import os
import sqlite3
import uuid

if os.getenv('DATABASE_URL'):
    raise SystemExit('REFUSE: customer-history integration test must not run against PostgreSQL/production')

import app as core
import wsgi  # registers customer-history hooks/routes on core.app


def check(name, ok):
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok:
        raise SystemExit(1)


def main():
    conn = sqlite3.connect(core.DB)
    conn.row_factory = sqlite3.Row
    tenant = conn.execute('SELECT id FROM tenants ORDER BY id LIMIT 1').fetchone()['id']
    conn.execute("UPDATE tenants SET active=1, subscription_status='active' WHERE id=?", (tenant,))
    stamp = uuid.uuid4().hex[:10]
    now = core.now()
    cur = conn.execute('INSERT INTO branches(tenant_id,name,active,created_at) VALUES(?,?,1,?)',
                       (tenant, 'History Test ' + stamp, now))
    branch_id = cur.lastrowid
    table_token = 'hist-' + uuid.uuid4().hex
    conn.execute('INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,active) VALUES(?,?,?,?,1)',
                 (tenant, branch_id, 'T-HISTORY', table_token))
    cur = conn.execute('INSERT INTO menu_categories(tenant_id,branch_id,name,icon,active,sort_order) VALUES(?,?,?,?,1,0)',
                       (tenant, branch_id, 'Food', '🍜'))
    cat_id = cur.lastrowid
    cur = conn.execute('''INSERT INTO menu_items(tenant_id,branch_id,category_id,name,description,base_price,active,sold_out,sort_order,
                        cost_price,track_stock,low_stock_threshold,created_at) VALUES(?,?,?,?,?,?,1,0,0,0,0,5,?)''',
                       (tenant, branch_id, cat_id, 'History Noodles', '', 25000, now))
    item_id = cur.lastrowid
    conn.commit(); conn.close()

    client = core.app.test_client()
    token = 'pub-' + uuid.uuid4().hex + uuid.uuid4().hex
    payload = {
        'branch_id': branch_id,
        'order_type': 'dine_in',
        'table_token': table_token,
        'customer_name': 'History Tester',
        'public_session_token': token,
        'cart': [{'menu_item_id': item_id, 'quantity': 2, 'selected_options': {}, 'notes': ''}],
    }
    r = client.post('/api/public/orders', json=payload)
    created = r.get_json() or {}
    check('create_order', r.status_code == 200 and bool(created.get('order_no')))

    r = client.post('/api/public/orders/history', json={
        'branch_id': branch_id,
        'public_session_token': token,
    })
    body = r.get_json() or {}
    check('history_lookup', r.status_code == 200 and len(body.get('orders') or []) == 1)
    order = body['orders'][0]
    check('history_items', order['items'][0]['item_name_snapshot'] == 'History Noodles' and order['items'][0]['quantity'] == 2)
    check('history_no_pii', all(k not in order for k in ('customer_phone','customer_address','id','tenant_id','branch_id')))

    other = 'pub-' + uuid.uuid4().hex + uuid.uuid4().hex
    r = client.post('/api/public/orders/history', json={
        'branch_id': branch_id,
        'public_session_token': other,
    })
    check('session_isolation', r.status_code == 200 and (r.get_json() or {}).get('orders') == [])

    conn = sqlite3.connect(core.DB)
    stored = conn.execute('SELECT client_device_id FROM orders WHERE branch_id=? ORDER BY id DESC LIMIT 1',
                          (branch_id,)).fetchone()[0]
    conn.close()
    check('token_hashed_at_rest', stored.startswith('public:') and token not in stored and len(stored) == 71)

    print('ROUND30_CUSTOMER_HISTORY_PASS')


if __name__ == '__main__':
    main()
