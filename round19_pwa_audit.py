from pathlib import Path
r=Path(__file__).parent;a=(r/'app.py').read_text();sw=(r/'static/sw.js').read_text();h=(r/'templates/index.html').read_text();m=(r/'static/manifest.webmanifest').read_text()
checks={'round18_2':'information_schema.columns' in a,'bootstrap_safe':'idx_tenants_subscription' not in (r/'schema_postgres.sql').read_text(),'sw_route':"@app.get('/sw.js')" in a,'offline_route':"@app.get('/offline')" in a,'404':'@app.errorhandler(404)' in a,'500':'@app.errorhandler(500)' in a,'503':'@app.errorhandler(503)' in a,'api_not_cached':"u.pathname.startsWith('/api/')" in sw,'offline_fallback':"caches.match('/offline')" in sw,'sw_register':"serviceWorker.register('/sw.js'" in h,'network_banner':'networkBanner' in h,'manifest':'ZaabOS Restaurant POS' in m}
bad=[]
for k,v in checks.items():print(('PASS ' if v else 'FAIL ')+k);bad+=[] if v else [k]
raise SystemExit(1 if bad else 0)
