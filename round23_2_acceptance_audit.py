from pathlib import Path
r=Path(__file__).parent;a=(r/'app.py').read_text();j=(r/'static/app.js').read_text();h=(r/'templates/index.html').read_text();k=(r/'static/kitchen.js').read_text()
C={'guest':'rp-guest-value' in j,'no_cpTax':'id="cpTax"' not in h,'explicit_pay':'cpPrimaryAmount' in j and 'cpRemaining' in h,'backend_exact':'if total != due' in a,'kitchen_skip':"'received': {'preparing','ready','cancelled'}" in a,'kitchen_ui':"received: [{ to: 'ready'" in k,'embedded':'historyKitchenWorkspace' in h and 'loadHistoryKitchen' in j,'cancel_report':'cancellation_analytics' in a and 'renderCancellationReport' in j}
for x,v in C.items():print(('PASS ' if v else 'FAIL ')+x)
assert all(C.values())
