from pathlib import Path
r=Path(__file__).parent
a=(r/'app.py').read_text();j=(r/'static/app.js').read_text();h=(r/'templates/index.html').read_text()
checks={'migration25':'restaurant_operations_complete' in a,'station_assignment':'menuItemKitchenStation' in j,'station_filter':"od['items']=filtered" in a,'recipe_ui':'openRecipeEditor' in j,'waste':'def ingredient_waste' in a,'count':'def ingredient_stock_count' in a,'history':'def inventory_movements_list' in a,'print_queue':'def kitchen_print_jobs_list' in a}
bad=[]
for k,v in checks.items(): print(('PASS ' if v else 'FAIL ')+k); bad += [] if v else [k]
raise SystemExit(1 if bad else 0)
