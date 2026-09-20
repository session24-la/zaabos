from pathlib import Path
root=Path(__file__).parent
app=(root/'app.py').read_text(); js=(root/'static/app.js').read_text(); html=(root/'index.html').read_text()
checks={
'migration17': "record_migration(conn, 17, 'pricing_promotions_service_tax')" in app,
'pricing_settings': 'CREATE TABLE IF NOT EXISTS pricing_settings' in app,
'promotions': 'CREATE TABLE IF NOT EXISTS promotions' in app,
'tenant_promo_unique': 'uq_promotions_tenant_code' in app,
'backend_tax': "service=money_decimal(base*Decimal(str(settings.get('service_charge_rate')" in app and "tax=money_decimal((base+service)*Decimal(str(settings.get('tax_rate')" in app,
'backend_discount': "manual=money(d.get('discount_amount'),0)" in app and "discount=min(money_decimal(discount),subtotal)" in app,
'manager_approval': "_critical_approval(conn,d)" in app,
'pricing_ui': 'tab-pricing' in html and 'loadPricing()' in js,
'receipt_discount': 'discount_amount' in js and 'service_charge_amount' in js,
}
for k,v in checks.items(): print(('PASS' if v else 'FAIL'),k)
if not all(checks.values()): raise SystemExit(1)
print('PASS — Round 14D critical invariants present')
