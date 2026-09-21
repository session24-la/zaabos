"""ZaabOS safe restore drill. Restores ONLY into RESTORE_TEST_DATABASE_URL, never DATABASE_URL."""
import os, sys, shutil, subprocess
from pathlib import Path
import psycopg2

if len(sys.argv)!=2: sys.exit('usage: python restore_test_postgres.py backups/<file>.dump')
p=Path(sys.argv[1]);
if not p.is_file(): sys.exit('FAIL: backup file not found')
prod=os.getenv('DATABASE_URL','').strip(); test=os.getenv('RESTORE_TEST_DATABASE_URL','').strip()
if not test: sys.exit('FAIL: RESTORE_TEST_DATABASE_URL is required')
if prod and test==prod: sys.exit('FAIL: restore test database MUST NOT equal DATABASE_URL')
pg_restore=shutil.which('pg_restore')
if not pg_restore: sys.exit('FAIL: pg_restore not found; install PostgreSQL client')
# Test DB must be disposable. Clean it, restore, then perform minimum integrity probes.
r=subprocess.run([pg_restore,'--clean','--if-exists','--no-owner','--no-acl','--dbname',test,str(p)],capture_output=True,text=True)
if r.returncode: sys.exit('FAIL restore: '+r.stderr[-1500:])
conn=psycopg2.connect(test); cur=conn.cursor()
checks={}
for table in ('tenants','users','orders','payments','schema_migrations'):
    cur.execute("SELECT to_regclass(%s)",(table,)); exists=cur.fetchone()[0] is not None; checks[table]=exists
    if not exists: sys.exit(f'FAIL: missing table after restore: {table}')
cur.execute('SELECT COUNT(*) FROM schema_migrations'); checks['migration_rows']=cur.fetchone()[0]
cur.execute('SELECT COUNT(*) FROM tenants'); checks['tenant_rows']=cur.fetchone()[0]
cur.execute('SELECT COUNT(*) FROM orders'); checks['order_rows']=cur.fetchone()[0]
conn.close()
print('PASS: restore drill completed on separate test database')
print(checks)
