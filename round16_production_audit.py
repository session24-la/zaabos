from pathlib import Path
root=Path(__file__).parent
app=(root/'app.py').read_text(); i18n=(root/'static/i18n.js').read_text()
checks={
 'migration24':"production_financial_safety" in app,
 'decimal_money':"ROUND_HALF_UP" in app and "money_decimal" in app,
 'payment_decimal':"total != due" in app and "money_sum" in app,
 'refund_decimal':"remaining_refundable=money_float" in app,
 'top_items_cancel_safe':"SUM(oi.quantity-COALESCE(oi.cancelled_quantity,0))" in app,
 'daily_close_deprecated':"Daily Closing เดิมถูกยกเลิกแล้ว" in app,
 'split_pg_lock':"lock_suffix=' FOR UPDATE' if IS_POSTGRES else ''" in app,
 'report_label_safe':"Net after refunds & recorded expenses" in i18n,
 'tenant_payment_claim':"WHERE id=? AND tenant_id=? AND payment_status='unpaid'" in app,
 'tenant_refund':"order_id=? AND tenant_id=?" in app,
}
bad=[]
for k,v in checks.items(): print(('PASS ' if v else 'FAIL ')+k); bad += ([] if v else [k])
raise SystemExit(1 if bad else 0)
