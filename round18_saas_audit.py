from pathlib import Path
r=Path(__file__).parent;a=(r/'app.py').read_text();j=(r/'static/app.js').read_text();h=(r/'templates/index.html').read_text();c=(r/'static/style.css').read_text()
checks={'migration26':'saas_commercial_layer' in a,'plans':'CREATE TABLE IF NOT EXISTS saas_plans' in a,'limits':'max_branches' in a and 'max_users' in a,'enforce':'รองรับสูงสุด' in a,'subscription_api':'def update_tenant_subscription' in a,'reactivate':'def reactivate_tenant' in a,'dashboard':'saasSummary' in h and 'renderTenants' in j,'trial':'trial_days' in a and 'tenantTrialDays' in h,'receipt':'padding-right:3mm!important' in c}
bad=[]
for k,v in checks.items():print(('PASS ' if v else 'FAIL ')+k);bad+=[] if v else [k]
raise SystemExit(1 if bad else 0)
