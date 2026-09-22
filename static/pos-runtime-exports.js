(function(global){
'use strict';
// Classic scripts share the global lexical environment, but top-level `let`
// bindings are intentionally not window properties. Expose read-only getters
// for the small amount of POS state used by the grouped-table extension.
for (const [name,getter] of [
  ['boot',()=>boot],
  ['me',()=>me],
  ['currentBranchId',()=>currentBranchId],
  ['activeOrders',()=>activeOrders],
  ['lastOrdersFlat',()=>lastOrdersFlat]
]) {
  try {
    if (!Object.prototype.hasOwnProperty.call(global,name)) {
      Object.defineProperty(global,name,{configurable:true,enumerable:false,get:getter});
    }
  } catch (e) {}
}
})(window);
