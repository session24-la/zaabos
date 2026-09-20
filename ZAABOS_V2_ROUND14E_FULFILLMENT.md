# Round 14E — Fulfillment / Delivery / Pre-order

Adds scheduled takeaway/delivery, delivery fee, fulfilment status, driver metadata fields, and staff fulfilment actions. Existing dine-in/takeaway/delivery order types remain compatible. A pre-order is represented as a takeaway or delivery order with `scheduled_for`, avoiding a destructive change to the existing order_type constraint. Payment includes delivery fee server-side.

Migration: 18 `fulfillment_delivery_preorder`. No database reset.

Test: create takeaway with future pickup time; create delivery with phone/address/fee; move delivery through confirmed → ready → out_for_delivery → delivered; verify payment includes delivery fee.
