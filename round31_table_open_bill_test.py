"""Non-production integration tests for one-open-bill dine-in table ordering.

Refuses PostgreSQL/production and uses only local SQLite test data.
"""
import os
import sqlite3
import uuid

if os.getenv('DATABASE_URL'):
    raise SystemExit('REFUSE: table-open-bill test must not run against PostgreSQL/production')

# app.py's SQLite migration bootstrap expects mapping-style rows.
_real_connect = sqlite3.connect
def _row_connect(*args, **kwargs):
    conn = _real_connect(*args, **kwargs)
    conn.row_factory = sqlite3.Row
    return conn
sqlite3.connect = _row_connect

import app as core
import wsgi  # registers customer-history + table-open-bill hooks


def check(name, ok):
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok:
        raise SystemExit(1)


def make_fixture():
    conn = sqlite3.connect(core.DB)
    tenant = conn.execute('SELECT id FROM tenants ORDER BY id LIMIT 1').fetchone()['id']
    conn.execute("UPDATE tenants SET active=1, subscription_status='active' WHERE id=?", (tenant,))
    now = core.now(); stamp = uuid.uuid4().hex[:10]
    b = conn.execute('INSERT INTO branches(tenant_id,name,active,created_at) VALUES(?,?,1,?)',
                     (tenant, 'Open Bill Test '+stamp, now)).lastrowid
    t1_token='ob-'+uuid.uuid4().hex; t2_token='ob-'+uuid.uuid4().hex
    t1=conn.execute('INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,active,created_at) VALUES(?,?,?,?,1,?)',
                    (tenant,b,'T-OPEN-1',t1_token,now)).lastrowid
    t2=conn.execute('INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,active,created_at) VALUES(?,?,?,?,1,?)',
                    (tenant,b,'T-OPEN-2',t2_token,now)).lastrowid
    cat=conn.execute('INSERT INTO menu_categories(tenant_id,branch_id,name,icon,active,sort_order,created_at) VALUES(?,?,?,?,1,0,?)',
                     (tenant,b,'Food','🍜',now)).lastrowid
    item=conn.execute('''INSERT INTO menu_items(tenant_id,branch_id,category_id,name,description,base_price,active,sold_out,sort_order,
                        cost_price,track_stock,low_stock_threshold,created_at)
                        VALUES(?,?,?,?,?,?,1,0,0,0,0,5,?)''',
                      (tenant,b,cat,'Open Bill Noodles','',25000,now)).lastrowid
    conn.commit(); conn.close()
    return tenant,b,t1,t1_token,t2,t2_token,item


def payload(branch, token, item, session, qty=1):
    return {
        'branch_id': branch, 'order_type': 'dine_in', 'table_token': token,
        'customer_name': 'QR guest', 'public_session_token': session,
        'cart': [{'menu_item_id': item, 'quantity': qty, 'selected_options': {}, 'notes': ''}],
    }


def main():
    tenant,b,t1,t1_token,t2,t2_token,item = make_fixture()
    client=core.app.test_client()
    s1='pub-'+uuid.uuid4().hex+uuid.uuid4().hex
    s2='pub-'+uuid.uuid4().hex+uuid.uuid4().hex

    first=client.post('/api/public/orders',json=payload(b,t1_token,item,s1,1))
    one=first.get_json() or {}
    check('first_table_order_created', first.status_code==200 and bool(one.get('order_id')) and not one.get('appended'))

    second=client.post('/api/public/orders',json=payload(b,t1_token,item,s2,1))
    two=second.get_json() or {}
    check('second_phone_appends_same_bill', second.status_code==200 and two.get('appended') is True and two.get('order_id')==one.get('order_id'))
    check('same_order_number', two.get('order_no')==one.get('order_no'))

    conn=sqlite3.connect(core.DB)
    open_rows=conn.execute("SELECT * FROM orders WHERE tenant_id=? AND branch_id=? AND table_id=? AND payment_status='unpaid' AND status NOT IN ('completed','cancelled')",
                           (tenant,b,t1)).fetchall()
    item_count=conn.execute('SELECT COUNT(*) c FROM order_items WHERE order_id=?',(one['order_id'],)).fetchone()['c']
    total=conn.execute('SELECT total_amount FROM orders WHERE id=?',(one['order_id'],)).fetchone()['total_amount']
    check('one_open_bill_only', len(open_rows)==1)
    check('both_rounds_kept_as_items', item_count==2 and int(total)==50000)
    conn.close()

    # Both phones on the physical table QR can see the same shared bill.
    for name,session in [('phone_a_table_history',s1),('phone_b_table_history',s2)]:
        r=client.post('/api/public/orders/history',json={'branch_id':b,'public_session_token':session,'table_token':t1_token})
        body=r.get_json() or {}; rows=body.get('orders') or []
        check(name, r.status_code==200 and body.get('scope')=='table' and len(rows)==1 and len(rows[0].get('items') or [])==2)

    # A different physical table must never share the bill.
    other=client.post('/api/public/orders',json=payload(b,t2_token,item,'pub-'+uuid.uuid4().hex+uuid.uuid4().hex,1))
    other_body=other.get_json() or {}
    check('different_table_separate_bill', other.status_code==200 and other_body.get('order_id')!=one.get('order_id'))

    # Legacy duplicate customer orders converge automatically on the next submit.
    conn=sqlite3.connect(core.DB); now=core.now()
    legacy_no='LEG-'+uuid.uuid4().hex[:12]
    legacy=conn.execute('''INSERT INTO orders(tenant_id,branch_id,order_no,order_type,table_id,table_name_snapshot,
                         customer_name,total_amount,notes,placed_by,created_at,updated_at)
                         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',
                      (tenant,b,legacy_no,'dine_in',t1,'T-OPEN-1','Legacy guest',25000,'','customer',now,now)).lastrowid
    conn.execute('''INSERT INTO order_items(order_id,menu_item_id,item_name_snapshot,quantity,unit_price,line_total,notes)
                    VALUES(?,?,?,?,?,?,?)''',(legacy,item,'Legacy Noodles',1,25000,25000,''))
    conn.commit(); conn.close()
    third=client.post('/api/public/orders',json=payload(b,t1_token,item,s1,1))
    third_body=third.get_json() or {}
    check('legacy_duplicate_auto_merged', third.status_code==200 and legacy in (third_body.get('merged_order_ids') or []))
    conn=sqlite3.connect(core.DB)
    legacy_state=conn.execute('SELECT status,total_amount FROM orders WHERE id=?',(legacy,)).fetchone()
    check('merged_duplicate_cancelled_zero', legacy_state['status']=='cancelled' and float(legacy_state['total_amount'])==0)

    # If the old kitchen round was already served, a new QR round must reactivate
    # the parent order so KDS (which excludes served orders) can show new items.
    conn.execute("UPDATE orders SET status='served',updated_at=? WHERE id=?",(core.now(),one['order_id']))
    conn.commit(); conn.close()
    reactivate=client.post('/api/public/orders',json=payload(b,t1_token,item,s2,1))
    check('served_bill_accepts_new_round', reactivate.status_code==200 and (reactivate.get_json() or {}).get('appended') is True)
    conn=sqlite3.connect(core.DB)
    status=conn.execute('SELECT status FROM orders WHERE id=?',(one['order_id'],)).fetchone()['status']
    latest_item=conn.execute('SELECT kitchen_sent_at FROM order_items WHERE order_id=? ORDER BY id DESC LIMIT 1',(one['order_id'],)).fetchone()
    check('new_round_reactivates_kds', status=='received' and latest_item['kitchen_sent_at'] is None)

    # An explicit staff split remains separate and is not auto-merged.
    split_no='SPL-'+uuid.uuid4().hex[:12]
    split=conn.execute('''INSERT INTO orders(tenant_id,branch_id,order_no,order_type,table_id,table_name_snapshot,
                        customer_name,total_amount,notes,placed_by,created_at,updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',
                     (tenant,b,split_no,'dine_in',t1,'T-OPEN-1','Split guest',10000,
                      'แยกจากบิล #'+one['order_no'],'staff',now,now)).lastrowid
    conn.execute('''INSERT INTO order_items(order_id,menu_item_id,item_name_snapshot,quantity,unit_price,line_total,notes)
                    VALUES(?,?,?,?,?,?,?)''',(split,item,'Split Item',1,10000,10000,''))
    conn.commit(); conn.close()
    fourth=client.post('/api/public/orders',json=payload(b,t1_token,item,s2,1))
    check('explicit_split_preserved', fourth.status_code==200 and split not in ((fourth.get_json() or {}).get('merged_order_ids') or []))
    conn=sqlite3.connect(core.DB)
    split_state=conn.execute('SELECT status FROM orders WHERE id=?',(split,)).fetchone()['status']
    check('split_bill_still_open', split_state!='cancelled')

    # A seating session ends only after every bill intentionally left on that
    # table (normal + explicit splits) is closed. Then the same physical QR must
    # start a fresh bill, never revive a paid order.
    ts=core.now()
    conn.execute("UPDATE orders SET payment_status='paid',status='completed',paid_at=?,updated_at=? WHERE id IN (?,?)",
                 (ts,ts,one['order_id'],split))
    conn.commit(); conn.close()
    new_session=client.post('/api/public/orders',json=payload(b,t1_token,item,'pub-'+uuid.uuid4().hex+uuid.uuid4().hex,1))
    fresh=new_session.get_json() or {}
    check('closed_table_starts_fresh_bill', new_session.status_code==200 and fresh.get('order_id') not in (one.get('order_id'),split))

    print('ROUND31_TABLE_OPEN_BILL_PASS')


if __name__=='__main__':
    main()
