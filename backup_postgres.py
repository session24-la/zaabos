"""ZaabOS operator backup. Creates a PostgreSQL custom-format dump + SHA-256 manifest."""
import os, sys, shutil, subprocess, hashlib, json
from pathlib import Path
from datetime import datetime, timezone

dsn=os.getenv('DATABASE_URL')
if not dsn: sys.exit('FAIL: DATABASE_URL is required')
pg_dump=shutil.which('pg_dump')
if not pg_dump: sys.exit('FAIL: pg_dump not found; install PostgreSQL client')
out=Path(os.getenv('ZAABOS_BACKUP_DIR') or 'backups'); out.mkdir(parents=True, exist_ok=True)
ts=datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S'); p=out/f'zaabos_operator_{ts}.dump'
r=subprocess.run([pg_dump,'--format=custom','--no-owner','--no-acl','--file',str(p),dsn],capture_output=True,text=True)
if r.returncode: sys.exit('FAIL: '+r.stderr[-1000:])
if p.stat().st_size < 1024: sys.exit('FAIL: dump is suspiciously small')
h=hashlib.sha256(p.read_bytes()).hexdigest(); meta={'file':p.name,'bytes':p.stat().st_size,'sha256':h,'created_at':datetime.now(timezone.utc).isoformat()}
p.with_suffix('.dump.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')
print('PASS'); print(json.dumps(meta,indent=2))
