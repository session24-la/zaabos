from pathlib import Path
import sqlite3
r=Path(__file__).parent;j=(r/'static/app.js').read_text();h=(r/'templates/index.html').read_text()
checks={'sqlite_fresh_columns':'client_request_id TEXT' in (r/'schema.sql').read_text(),'pg_fresh_columns':'client_request_id TEXT' in (r/'schema_postgres.sql').read_text(),'transient_errors':'err.transient' in j,'transient_queue_retry':"e.transient" in j and "rec.status='pending'" in j,'conflict_retry':'data-offline-retry' in j,'queue_delete':'data-offline-remove' in j,'offline_table_visibility':'offline-pending' in j,'offline_other_visibility':'offline-local-row' in j,'no_reconnect_reload':"addEventListener('online',()=>{net();location.reload()})" not in h,'api_not_cached':"u.pathname.startsWith('/api/')" in (r/'static/sw.js').read_text()}
bad=[]
for k,v in checks.items():print(('PASS ' if v else 'FAIL ')+k);bad+=[] if v else [k]
try:c=sqlite3.connect(':memory:');c.executescript((r/'schema.sql').read_text());print('PASS sqlite_fresh_schema')
except Exception as e:print('FAIL sqlite_fresh_schema',e);bad.append('sqlite_fresh_schema')
raise SystemExit(1 if bad else 0)
