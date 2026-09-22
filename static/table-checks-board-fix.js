(function(global){
'use strict';
// A dine-in batch may reach the operational status "completed" before the
// customer pays. The table must stay occupied and payable until payment_status
// changes to paid. Replace only the board refresh filter; existing renderers and
// kitchen/history logic remain untouched.
if (typeof global.loadBoardData!=='function') return;
global.loadBoardData=async function(){
  if (!global.currentBranchId) {
    global.activeOrders=[];
    if(typeof global.renderTableBoard==='function')global.renderTableBoard();
    if(typeof global.renderOtherOrders==='function')global.renderOtherOrders();
    if(typeof global.renderSidePanel==='function')global.renderSidePanel();
    return;
  }
  try {
    const qs=new URLSearchParams({branch_id:global.currentBranchId});
    const r=await global.api('/api/orders?'+qs.toString(),{silent:true});
    global.lastOrdersFlat=r.orders||[];
    global.activeOrders=global.lastOrdersFlat.filter(o=>o.status!=='cancelled' && (o.status!=='completed' || o.payment_status==='unpaid'));
  } catch(e) { return; }
  if(typeof global.renderTableBoard==='function')global.renderTableBoard();
  if(typeof global.renderOtherOrders==='function')global.renderOtherOrders();
  if(typeof global.renderSidePanel==='function')global.renderSidePanel();
};
})(window);
