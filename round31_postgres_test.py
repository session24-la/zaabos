"""PostgreSQL acceptance for Round 31 against the disposable restore-test DB only.

Safety gates require an explicit opt-in label and expected internal hostname.
Never configure this service with the production Postgres DATABASE_URL.
"""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

DB_URL=os.getenv('DATABASE_URL','')
EXPECTED_HOST=os.getenv('ROUND31_EXPECTED_DB_HOST','')
if os.getenv('ROUND31_POSTGRES_TEST')!='restore-test':
    raise SystemExit('REFUSE: ROUND31_POSTGRES_TEST must equal restore-test')
if not DB_URL or not EXPECTED_HOST or urlsplit(DB_URL).hostname != EXPECTED_HOST:
    raise SystemExit('REFUSE: DATABASE_URL host is not the explicitly approved restore-test host')

import app as core
import wsgi

core.app.config['SESSION_COOKIE_SECURE']=False


def check(name,ok):
    print(('PASS ' if ok else 'FAIL ')+name)
    if not ok: raise SystemExit(1)


def conn():
    return core.PGConn(DB_URL)


def setup():
    c=conn(); tenant=c.execute('SELECT id FROM tenants WHERE active=1 ORDER BY id LIMIT 1').fetchone()['id']
    stamp=uuid.uuid4().hex[:10]; now=core.now()
    cur=c.execute('INSERT INTO branches(tenant_id,name,active,created_at) VALUES(?,?,1,?)',(tenant,'R31 PG '+stamp,now)); branch=cur.lastrowid
    token='r31pg-'+uuid.uuid4().hex
    cur=c.execute('INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,active,created_at) VALUES(?,?,?,?,1,?)',(tenant,branch,'T-R31-PG',token,now)); table=cur.lastrowid
    cur=c.execute('INSERT INTO menu_categories(tenant_id,branch_id,name,icon,active,sort_order,created_at) VALUES(?,?,?,?,1,0,?)',(tenant,branch,'R31 Food','🍜',now)); cat=cur.lastrowid
    cur=c.execute('''INSERT INTO menu_items(tenant_id,branch_id,category_id,name,description,base_price,active,sold_out,sort_order,cost_price,track_stock,low_stock_threshold,created_at)
                     VALUES(?,?,?,?,?,?,1,0,0,0,0,5,?)''',(tenant,branch,cat,'R31 PG Noodles','',25000,now)); item=cur.lastrowid
    user='r31pg_'+stamp; password='Round31-PG-test-password!'
    c.execute('''INSERT INTO users(tenant_id,username,password_hash,display_name,role,active,must_change_password,created_at)
                 VALUES(?,?,?,?,?,1,0,?)''',(tenant,user,core.hash_password(password),'R31 PG Manager','manager',now))
    c.commit(); c.close(); return branch,table,token,item,user,password


def place(branch,token,item):
    cli=core.app.test_client()
    return cli.post('/api/public/orders',json={'branch_id':branch,'order_type':'dine_in','table_token':token,'customer_name':'PG QR','cart':[{'menu_item_id':item,'quantity':1,'selected_options':{},'notes':''}],'public_session_token':'pub-'+uuid.uuid4().hex+uuid.uuid4().hex})


def login(user,password):
    cli=core.app.test_client(); r=cli.post('/api/login',json={'username':user,'password':password}); body=r.get_json() or {}; return cli,body.get('csrf_token',''),r.status_code


def main():
    branch,table,token,item,user,password=setup()

    # Concurrent phones at one table must still converge on one primary check.
    with ThreadPoolExecutor(max_workers=4) as ex:
        rs=list(ex.map(lambda _:place(branch,token,item),range(4)))
    ids=[(r.get_json() or {}).get('order_id') for r in rs]
    check('pg_concurrent_orders_created',all(r.status_code==200 for r in rs) and len(set(ids))==4)

    cli,csrf,status=login(user,password); headers={'X-CSRF-Token':csrf}
    check('pg_manager_login',status==200 and bool(csrf))
    checks=(cli.get(f'/api/table-checks?branch_id={branch}').get_json() or {}).get('checks') or []
    primary=[x for x in checks if x['table_id']==table and x['accept_auto_join']]
    check('pg_one_primary_open_check',len(primary)==1 and primary[0]['order_count']==4)
    tc=primary[0]
    check('pg_combined_total',abs(float(tc['subtotal'])-100000)<0.01)

    quote=cli.post(f"/api/table-checks/{tc['id']}/quote",json={},headers=headers).get_json() or {}
    due=float(quote.get('amount') or 0)
    check('pg_quote',due>0)

    # Two cashier sessions race the same table payment. Exactly one may win.
    c1,x1,s1=login(user,password); c2,x2,s2=login(user,password)
    payload={'payment_method':'qr','payments':[{'method':'qr','amount':due}]}
    def pay(pair):
        c,x=pair
        return c.post(f"/api/table-checks/{tc['id']}/payment",json=payload,headers={'X-CSRF-Token':x})
    with ThreadPoolExecutor(max_workers=2) as ex:
        pres=list(ex.map(pay,[(c1,x1),(c2,x2)]))
    codes=sorted(r.status_code for r in pres)
    check('pg_atomic_duplicate_payment_guard',codes==[200,409])

    c=conn()
    paid=c.execute('''SELECT COUNT(*) c FROM orders o JOIN table_check_orders co ON co.order_id=o.id
                      WHERE co.check_id=? AND o.payment_status='paid' AND o.status='completed' ''',(tc['id'],)).fetchone()['c']
    payment_total=c.execute('''SELECT COALESCE(SUM(p.amount),0) t FROM payments p JOIN table_check_orders co ON co.order_id=p.order_id
                               WHERE co.check_id=? AND p.reversed_at IS NULL''',(tc['id'],)).fetchone()['t']
    primaries=c.execute("SELECT COUNT(*) c FROM table_checks WHERE tenant_id=(SELECT tenant_id FROM branches WHERE id=?) AND table_id=? AND status='open' AND accept_auto_join=1",(branch,table)).fetchone()['c']
    c.close()
    check('pg_all_batches_paid_once',paid==4 and abs(float(payment_total)-due)<0.01)
    check('pg_primary_closed_after_payment',primaries==0)

    # Same QR after close starts a fresh seating/check.
    nr=place(branch,token,item); nid=(nr.get_json() or {}).get('order_id')
    fresh=(cli.get(f'/api/table-checks/by-order/{nid}').get_json() or {}).get('check') or {}
    check('pg_new_seating_new_check',nr.status_code==200 and fresh.get('id')!=tc['id'] and fresh.get('order_count')==1)

    print('ROUND31_POSTGRES_OPEN_CHECK_PASS')

if __name__=='__main__':
    main()
