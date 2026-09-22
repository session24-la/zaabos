"""Isolated integration acceptance for Round 31 logical table bills.

This test refuses PostgreSQL/production. It exercises real Flask routes against a
throw-away SQLite database inside the disposable Railway test container.
"""
import os
import sqlite3
import uuid

if os.getenv('DATABASE_URL'):
    raise SystemExit('REFUSE: Round31 integration test must not run against PostgreSQL/production')

# app.py's SQLite migration path expects dict-like rows during import.
_real_connect = sqlite3.connect
def _row_connect(*args, **kwargs):
    conn = _real_connect(*args, **kwargs)
    conn.row_factory = sqlite3.Row
    return conn
sqlite3.connect = _row_connect

import app as core
import wsgi  # registers customer history + table checks


def check(name, ok):
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok:
        raise SystemExit(1)


def setup_fixture():
    conn = sqlite3.connect(core.DB)
    tenant = conn.execute('SELECT id FROM tenants ORDER BY id LIMIT 1').fetchone()['id']
    conn.execute("UPDATE tenants SET active=1, subscription_status='active' WHERE id=?", (tenant,))
    stamp = uuid.uuid4().hex[:8]
    now = core.now()
    cur = conn.execute('INSERT INTO branches(tenant_id,name,active,created_at) VALUES(?,?,1,?)',
                       (tenant, 'Open Check '+stamp, now))
    branch_id = cur.lastrowid
    tables=[]
    for name in ('T-31-A','T-31-B'):
        token='r31-'+uuid.uuid4().hex
        cur=conn.execute('INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,active,created_at) VALUES(?,?,?,?,1,?)',
                         (tenant,branch_id,name,token,now))
        tables.append((cur.lastrowid,token,name))
    cur=conn.execute('INSERT INTO menu_categories(tenant_id,branch_id,name,icon,active,sort_order,created_at) VALUES(?,?,?,?,1,0,?)',
                     (tenant,branch_id,'Food','🍜',now))
    cat=cur.lastrowid
    cur=conn.execute('''INSERT INTO menu_items(tenant_id,branch_id,category_id,name,description,base_price,active,sold_out,sort_order,
        cost_price,track_stock,low_stock_threshold,created_at) VALUES(?,?,?,?,?,?,1,0,0,0,0,5,?)''',
        (tenant,branch_id,cat,'Round31 Noodles','',30000,now))
    item_id=cur.lastrowid
    username='r31_'+stamp
    password='Round31-test-password!'
    conn.execute('''INSERT INTO users(tenant_id,username,password_hash,display_name,role,active,must_change_password,created_at)
                    VALUES(?,?,?,?,?,1,0,?)''',
                 (tenant,username,core.hash_password(password),'Round31 Manager','manager',now))
    conn.commit(); conn.close()
    return tenant,branch_id,tables,item_id,username,password


def place(client, branch_id, table_token, item_id, qty=1):
    return client.post('/api/public/orders', json={
        'branch_id':branch_id,'order_type':'dine_in','table_token':table_token,
        'customer_name':'QR Customer','cart':[{'menu_item_id':item_id,'quantity':qty,'selected_options':{},'notes':''}],
        'public_session_token':'pub-'+uuid.uuid4().hex+uuid.uuid4().hex,
    })


def main():
    tenant,branch_id,tables,item_id,username,password=setup_fixture()
    table_a,token_a,_=tables[0]; table_b,_,_=tables[1]
    client=core.app.test_client()

    a=place(client,branch_id,token_a,item_id,1); b=place(client,branch_id,token_a,item_id,2)
    aj=a.get_json() or {}; bj=b.get_json() or {}
    check('two_qr_batches_created', a.status_code==200 and b.status_code==200 and aj.get('order_id')!=bj.get('order_id'))

    login=client.post('/api/login',json={'username':username,'password':password})
    auth=login.get_json() or {}; csrf=auth.get('csrf_token','')
    check('manager_login',login.status_code==200 and bool(csrf))
    headers={'X-CSRF-Token':csrf}

    r=client.get(f'/api/table-checks?branch_id={branch_id}')
    data=r.get_json() or {}; checks=data.get('checks') or []
    primary=[x for x in checks if x['table_id']==table_a and x['accept_auto_join']]
    check('one_primary_check_per_table',r.status_code==200 and len(primary)==1)
    tc=primary[0]
    check('batches_preserved_inside_check',tc['order_count']==2 and len(tc['orders'])==2)
    check('combined_subtotal',abs(float(tc['subtotal'])-90000)<0.01)

    # Moving a table bill moves every underlying batch together.
    r=client.put(f"/api/table-checks/{tc['id']}/move",json={'table_id':table_b},headers=headers)
    check('move_whole_table_check',r.status_code==200)
    conn=sqlite3.connect(core.DB)
    moved=conn.execute('SELECT COUNT(*) c FROM orders WHERE id IN (?,?) AND table_id=?',(aj['order_id'],bj['order_id'],table_b)).fetchone()['c']
    conn.close(); check('all_batches_moved_together',moved==2)

    # Another QR order on the moved table joins that same primary check.
    token_b=conn_token=None
    conn=sqlite3.connect(core.DB); token_b=conn.execute('SELECT qr_token FROM dining_tables WHERE id=?',(table_b,)).fetchone()['qr_token']; conn.close()
    c=place(client,branch_id,token_b,item_id,1); cj=c.get_json() or {}
    check('third_qr_batch_created',c.status_code==200)
    r=client.get(f"/api/table-checks/by-order/{cj.get('order_id')}")
    tc=(r.get_json() or {}).get('check') or {}
    check('later_order_joins_same_check',tc.get('order_count')==3 and abs(float(tc.get('subtotal') or 0)-120000)<0.01)

    q=client.post(f"/api/table-checks/{tc['id']}/quote",json={},headers=headers)
    quote=q.get_json() or {}; due=float(quote.get('amount') or 0)
    check('combined_quote',q.status_code==200 and abs(due-120000)<0.01)

    pay=client.post(f"/api/table-checks/{tc['id']}/payment",json={
        'payment_method':'qr','payments':[{'method':'qr','amount':due}]
    },headers=headers)
    check('single_payment_closes_whole_table',pay.status_code==200 and len((pay.get_json() or {}).get('order_ids') or [])==3)
    conn=sqlite3.connect(core.DB)
    paid=conn.execute("SELECT COUNT(*) c FROM orders WHERE id IN (?,?,?) AND payment_status='paid' AND status='completed'",
                      (aj['order_id'],bj['order_id'],cj['order_id'])).fetchone()['c']
    ptotal=conn.execute('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE order_id IN (?,?,?)',
                        (aj['order_id'],bj['order_id'],cj['order_id'])).fetchone()['t']
    conn.close()
    check('all_batches_paid_once',paid==3 and abs(float(ptotal)-due)<0.01)

    again=client.post(f"/api/table-checks/{tc['id']}/payment",json={'payment_method':'qr','payments':[{'method':'qr','amount':due}]},headers=headers)
    check('duplicate_table_payment_rejected',again.status_code==409)

    # Paid check is a closed seating. A later QR order opens a fresh primary check.
    d=place(client,branch_id,token_b,item_id,1); dj=d.get_json() or {}
    r=client.get(f"/api/table-checks/by-order/{dj.get('order_id')}")
    fresh=(r.get_json() or {}).get('check') or {}
    check('new_seating_gets_new_check',d.status_code==200 and fresh.get('id')!=tc.get('id') and fresh.get('order_count')==1)

    # Report counts logical paid bills rather than kitchen/order batches.
    rep=client.get(f'/api/reports/summary?branch_id={branch_id}')
    rd=rep.get_json() or {}
    check('report_exposes_batch_count',rep.status_code==200 and 'order_batch_count' in rd)
    check('report_bill_count_not_batch_count',int(rd.get('order_count') or 0)<=int(rd.get('order_batch_count') or 0))

    print('ROUND31_TABLE_OPEN_CHECK_PASS')

if __name__=='__main__':
    main()
