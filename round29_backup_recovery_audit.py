from pathlib import Path
s=Path('app.py').read_text(); b=Path('backup_postgres.py').read_text(); r=Path('restore_test_postgres.py').read_text()
checks={
'env_backup_dir':"ZAABOS_BACKUP_DIR" in s and "Path(os.getenv('ZAABOS_BACKUP_DIR')" in s,
'custom_pg_dump':"--format=custom" in s and "--no-owner" in s,
'sha256_manifest':"_sha256_file" in s and "sha256" in s,
'admin_list':"@app.get('/api/admin/backups')" in s and '@super_admin_required' in s,
'admin_create':"@app.post('/api/admin/backups')" in s,
'admin_download':"/api/admin/backups/<path:filename>/download" in s,
'no_http_restore':"@app.post('/api/admin/restore" not in s,
'restore_separate_db':"RESTORE_TEST_DATABASE_URL" in r and "test==prod" in r,
'restore_core_checks':all(x in r for x in ('tenants','users','orders','payments','schema_migrations')),
'operator_backup':"pg_dump" in b and "sha256" in b,
'readiness':"pg_dump_available" in s and "backup_artifacts" in s,
}
for k,v in checks.items(): print(('PASS' if v else 'FAIL'),k)
print(f"ROUND29 SOURCE AUDIT: {sum(checks.values())}/{len(checks)} PASS")
raise SystemExit(0 if all(checks.values()) else 1)
