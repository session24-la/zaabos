from pathlib import Path
r=Path(__file__).parent
a=(r/'app.py').read_text(); j=(r/'static/app.js').read_text(); c=(r/'static/style.css').read_text()
checks={
 'occupied_backend_block':"โต๊ะปลายทางมีออเดอร์อยู่" in a,
 'target_transfer_backend':"target_order_id" in a[a.index("def split_order(source_id):"):a.index("# ---------- Round 15:")],
 'same_branch_guard':"ย้ายรายการข้ามสาขาไม่ได้" in a,
 'no_inventory_mutation_in_transfer':"_decrement_stock" not in a[a.index("def split_order(source_id):"):a.index("# ---------- Round 15:")],
 'move_no_numeric_prompt':"เลือกหมายเลขโต๊ะปลายทาง" not in j,
 'correct_move_endpoint':"/move-table`,'PUT'" in j,
 'occupied_disabled_ui':"is-occupied" in j and "disabled" in j,
 'selective_target_ui':"data-bm-split-target" in j,
 'five_primary_nav':"1.08fr 1fr 1fr 1fr .92fr !important" in c,
 'modern_bill_manager':".bm-table-choice" in c,
}
for k,v in checks.items(): print(('PASS ' if v else 'FAIL ')+k)
assert all(checks.values())
