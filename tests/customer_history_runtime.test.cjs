const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function run(pathname) {
  const intervals = [], requests = [];
  const elements = new Map();
  const element = id => {
    if (id === 'successTrackLink') return null;
    if (!elements.has(id)) elements.set(id, {classList:{toggle(){},add(){},remove(){}},textContent:'',innerHTML:''});
    return elements.get(id);
  };
  const context = {
    console, URL, URLSearchParams, Intl, Uint8Array, menuData:{branch_id:1},
    location:{pathname,href:'https://example.test'+pathname},
    document:{hidden:false,getElementById:element,querySelector:()=>({value:'en',addEventListener(){}})},
    localStorage:{getItem(){throw new Error('storage unavailable')},setItem(){throw new Error('storage unavailable')}},
    setInterval(fn,ms){intervals.push({fn,ms});return intervals.length},clearInterval(){},setTimeout(){},
    fetch:async (url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({orders:[]})}},
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('static/customer-history.js','utf8'),context);
  intervals.find(t=>t.ms===250).fn();
  await new Promise(resolve=>setImmediate(resolve));
  if(pathname.startsWith('/order/')) {
    const before=requests.length;
    intervals.find(t=>t.ms===15000).fn();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(requests.length,before+1,'an empty table must poll for orders from another phone');
  }
  await context.fetch('/api/public/orders',{method:'POST',body:'{}'});
  const created=JSON.parse(requests.at(-1).options.body).public_session_token;
  const history=JSON.parse(requests.find(r=>r.url==='/api/public/orders/history').options.body).public_session_token;
  assert.equal(created,history,'history and checkout need the same session when storage is blocked');
}
(async()=>{await run('/order/table-token');await run('/order?branch_id=1');console.log('CUSTOMER_HISTORY_RUNTIME_PASS')})().catch(e=>{console.error(e);process.exitCode=1});
