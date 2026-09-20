"""ZaabOS backup artifact verifier. Read-only; never connects to or modifies production."""
from pathlib import Path
import argparse, hashlib, sys

ap=argparse.ArgumentParser()
ap.add_argument('backup')
a=ap.parse_args()
p=Path(a.backup)
if not p.is_file(): sys.exit('FAIL: backup file not found')
size=p.stat().st_size
if size < 1024: sys.exit('FAIL: backup is suspiciously small')
h=hashlib.sha256()
with p.open('rb') as f:
    for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
print('PASS')
print('file:',p.name)
print('bytes:',size)
print('sha256:',h.hexdigest())
print('NOTE: integrity of the file is verified; complete recovery still requires a restore test into a separate test database.')
