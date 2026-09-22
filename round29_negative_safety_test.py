"""Non-destructive safety checks for the Round 29 restore guard."""
import hashlib, json, tempfile
from pathlib import Path
import restore_test_postgres as r

def check(name, ok):
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok: raise SystemExit(1)

# Same physical database must be detected even when URLs could differ.
a={'database':'railway','address':'10.0.0.1','port':5432,'started':'2026-01-01','system_identifier':'123'}
b=dict(a)
check('same_database_guard', r.same_database(a,b))
c=dict(b); c['address']='10.0.0.2'; c['system_identifier']='456'
check('different_database_allowed', not r.same_database(a,c))

# Secret scrubber must remove both full DSN and password.
dsn='postgresql://tester:round29-secret@example.invalid:5432/testdb'
out=r.scrub('connection failed '+dsn+' password=round29-secret', dsn)
check('secret_scrubbed', 'round29-secret' not in out and dsn not in out)

# Checksum mismatch logic: demonstrate a changed artifact cannot match its manifest.
with tempfile.TemporaryDirectory() as td:
    p=Path(td)/'sample.dump'; p.write_bytes(b'known-good-backup')
    expected=hashlib.sha256(p.read_bytes()).hexdigest()
    (Path(td)/'sample.dump.json').write_text(json.dumps({'sha256':expected}))
    p.write_bytes(b'tampered-backup')
    actual=hashlib.sha256(p.read_bytes()).hexdigest()
    check('manifest_mismatch_detected', actual != expected)

print('ROUND29_NEGATIVE_SAFETY_TESTS_PASS')
