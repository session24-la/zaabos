(function(global){
'use strict';
// Classic scripts share the global lexical environment, but top-level `let`
// bindings are intentionally not window properties. Expose a narrow bridge for
// the grouped-table extension. Mutable order-list bindings get controlled
// setters so the extension can preserve existing board rendering functions.
const defs=[
  ['boot',()=>boot,null],
  ['me',()=>me,null],
  ['currentBranchId',()=>currentBranchId,v=>{currentBranchId=v;}],
  ['activeOrders',()=>activeOrders,v=>{activeOrders=v;}],
  ['lastOrdersFlat',()=>lastOrdersFlat,v=>{lastOrdersFlat=v;}]
];
for (const [name,getter,setter] of defs) {
  try {
    if (!Object.prototype.hasOwnProperty.call(global,name)) {
      const d={configurable:true,enumerable:false,get:getter};
      if(setter)d.set=setter;
      Object.defineProperty(global,name,d);
    }
  } catch (e) {}
}
try { if (typeof STATUS_PRIORITY!=='undefined') STATUS_PRIORITY.completed=4; } catch(e) {}
})(window);
