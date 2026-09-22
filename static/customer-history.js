(function(global){
  'use strict';

  // Per-table QR pages show one shared current table bill. Generic QR / other
  // flows keep a browser-scoped opaque session token.
  const TTL_MS=12*60*60*1000;
  const POLL_MS=15000;
  let historyRows=[];
  let menuReady=false;
  const memorySessions=new Map();

  const COPY={
    th:{view:'🧾 ดูรายการที่สั่งแล้ว',title:'รายการที่สั่งแล้ว',hint:'โต๊ะนี้จะแสดงรายการที่สั่งร่วมกันจากทุกเครื่องในบิลปัจจุบัน โดยไม่ต้องกรอกเลขออเดอร์หรือเบอร์โทร',empty:'ยังไม่มีรายการที่สั่งในบิลนี้',refresh:'↻ อัปเดตสถานะ',more:'🍽️ สั่งเพิ่ม',total:'รวมทั้งหมด',error:'อัปเดตรายการไม่ได้ กรุณาลองอีกครั้ง'},
    lo:{view:'🧾 ເບິ່ງລາຍການທີ່ສັ່ງແລ້ວ',title:'ລາຍການທີ່ສັ່ງແລ້ວ',hint:'QR ໂຕະນີ້ຈະສະແດງລາຍການຮ່ວມກັນຈາກທຸກເຄື່ອງໃນບິນປັດຈຸບັນ ບໍ່ຕ້ອງປ້ອນເລກອໍເດີ ຫຼື ເບີໂທ',empty:'ຍັງບໍ່ມີລາຍການໃນບິນນີ້',refresh:'↻ ອັບເດດສະຖານະ',more:'🍽️ ສັ່ງເພີ່ມ',total:'ລວມທັງໝົດ',error:'ອັບເດດລາຍການບໍ່ໄດ້ ກະລຸນາລອງໃໝ່'},
    zh:{view:'🧾 查看已点订单',title:'已点订单',hint:'桌台二维码会显示当前账单中所有设备共同点的菜，无需输入订单号或手机号',empty:'当前账单还没有订单',refresh:'↻ 更新状态',more:'🍽️ 继续点餐',total:'合计',error:'无法更新订单，请重试'},
    en:{view:'🧾 View my orders',title:'Current table bill',hint:'A table QR shows the shared current bill from every device at this table — no order number or phone required',empty:'Nothing has been ordered on this bill yet',refresh:'↻ Refresh status',more:'🍽️ Order more',total:'Total',error:'Could not refresh orders. Please try again.'}
  };

  function lang(){
    const v=(document.querySelector('#langSelect')||{}).value;
    return COPY[v]?v:'lo';
  }
  function c(key){ return COPY[lang()][key]||COPY.en[key]||key; }
  function esc(value){
    return String(value==null?'':value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function tableToken(){
    const m=location.pathname.match(/^\/order\/([^/]+)$/);
    return m?decodeURIComponent(m[1]):'';
  }
  function branchId(){
    try { if(typeof menuData!=='undefined'&&menuData&&menuData.branch_id)return String(menuData.branch_id); } catch(e){}
    return new URLSearchParams(location.search).get('branch_id')||'';
  }
  function storageKey(){
    const token=tableToken();
    return 'zaabos_public_order_session_v1:'+(token?'table:'+token:'branch:'+branchId());
  }
  function randomToken(){
    if(global.crypto&&crypto.randomUUID)return crypto.randomUUID()+'-'+crypto.randomUUID();
    if(global.crypto&&crypto.getRandomValues){
      const b=new Uint8Array(32);crypto.getRandomValues(b);
      return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
    }
    return 'z-'+Date.now()+'-'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
  }
  function sessionToken(){
    const key=storageKey(),now=Date.now();
    const remembered=memorySessions.get(key);
    if(remembered&&now-remembered.created_at<TTL_MS)return remembered.token;
    try{
      const saved=JSON.parse(localStorage.getItem(key)||'null');
      if(saved&&saved.token&&now-Number(saved.created_at||0)<TTL_MS){memorySessions.set(key,saved);return saved.token;}
    }catch(e){}
    const token=randomToken();
    const saved={token,created_at:now};memorySessions.set(key,saved);
    try{localStorage.setItem(key,JSON.stringify(saved));}catch(e){}
    return token;
  }
  function statusLabel(status){
    try { if(typeof t==='function')return t('status_'+status)||status; } catch(e){}
    return status||'';
  }
  function money(value){
    try { if(typeof fmtMoney==='function')return fmtMoney(value); } catch(e){}
    return Math.round(Number(value)||0).toLocaleString();
  }
  function timeText(value){
    const d=new Date(value);if(Number.isNaN(d.getTime()))return '';
    const locales={th:'th-TH',lo:'lo-LA',zh:'zh-CN',en:'en-US'};
    return new Intl.DateTimeFormat(locales[lang()]||'lo-LA',{timeZone:'Asia/Vientiane',hour:'2-digit',minute:'2-digit'}).format(d);
  }
  function notify(msg){
    try { if(typeof toast==='function'){toast(msg,'err');return;} } catch(e){}
    console.warn(msg);
  }

  function injectStyle(){
    if(document.getElementById('zaabosCustomerHistoryStyle'))return;
    const style=document.createElement('style');style.id='zaabosCustomerHistoryStyle';style.textContent=`
      .customer-history-btn{width:100%;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:14px;padding:12px 14px;margin:0 0 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-weight:800;box-shadow:var(--shadow-sm)}
      .customer-history-count{min-width:26px;height:26px;border-radius:99px;background:var(--primary);color:var(--primary-ink);display:inline-flex;align-items:center;justify-content:center;font-size:12px;padding:0 7px}
      .customer-history-card{margin-top:10px}.customer-history-card:first-child{margin-top:0}.customer-history-card .oc-items{margin:10px 0 8px;padding:0;list-style:none}.customer-history-card .oc-items li{padding:5px 0;border-top:1px dashed var(--border);font-size:13.5px}.customer-history-card .oc-items li:first-child{border-top:0}.customer-history-total{border-top:1px dashed var(--border);padding-top:10px}.customer-history-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}.customer-history-actions .save{margin:0}@media(max-width:480px){.customer-history-actions{grid-template-columns:1fr}}
    `;document.head.appendChild(style);
  }

  function ensureUi(){
    injectStyle();
    if(!document.getElementById('customerHistoryBtn')){
      const main=document.querySelector('#menuView main.narrow');
      if(main){
        const btn=document.createElement('button');btn.type='button';btn.id='customerHistoryBtn';btn.className='customer-history-btn hidden';
        btn.innerHTML='<span id="customerHistoryBtnLabel"></span><span class="customer-history-count" id="customerHistoryCount">0</span>';
        main.insertBefore(btn,main.firstChild);btn.addEventListener('click',openHistory);
      }
    }
    if(!document.getElementById('customerHistoryModal')){
      const modal=document.createElement('div');modal.className='modal';modal.id='customerHistoryModal';modal.innerHTML=`<div class="sheet"><div class="sheet-head"><h2 id="customerHistoryTitle"></h2><button data-close>×</button></div><p class="hint" id="customerHistoryHint"></p><div id="customerHistoryList"></div><div class="customer-history-actions"><button type="button" class="ghost-btn" id="customerHistoryRefresh"></button><button type="button" class="save secondary" id="customerHistoryMore"></button></div></div>`;
      document.body.appendChild(modal);
      modal.querySelector('#customerHistoryRefresh').addEventListener('click',()=>refreshHistory(false));
      modal.querySelector('#customerHistoryMore').addEventListener('click',()=>{modal.classList.remove('show');window.scrollTo({top:0,behavior:'smooth'});});
    }
    const success=document.getElementById('successTrackLink');
    if(success&&!success.dataset.historyBound){
      success.dataset.historyBound='1';success.removeAttribute('data-i18n');success.removeAttribute('href');success.setAttribute('role','button');
      success.addEventListener('click',async e=>{e.preventDefault();e.stopPropagation();const sm=document.getElementById('successModal');if(sm)sm.classList.remove('show');await openHistory();},true);
    }
    updateLabels();renderButton();renderHistory();
  }

  function updateLabels(){
    const set=(id,text)=>{const el=document.getElementById(id);if(el)el.textContent=text;};
    set('customerHistoryBtnLabel',c('view'));set('customerHistoryTitle',c('title'));set('customerHistoryHint',c('hint'));set('customerHistoryRefresh',c('refresh'));set('customerHistoryMore',c('more'));
    const success=document.getElementById('successTrackLink');if(success)success.textContent=c('view');
  }
  function renderButton(){
    const btn=document.getElementById('customerHistoryBtn');if(!btn)return;
    btn.classList.toggle('hidden',historyRows.length===0);
    const count=document.getElementById('customerHistoryCount');if(count)count.textContent=String(historyRows.length);
  }
  function renderHistory(){
    const list=document.getElementById('customerHistoryList');if(!list)return;
    if(!historyRows.length){list.innerHTML=`<div class="empty-state"><span class="es-ic">🧾</span>${esc(c('empty'))}</div>`;return;}
    list.innerHTML=historyRows.map(order=>{
      const items=(order.items||[]).map(it=>`<li><b>${Number(it.quantity)||0}×</b> ${esc(it.item_name_snapshot)}${it.options&&it.options.length?` <span class="hint">(${it.options.map(o=>esc(o.option_name_snapshot)).join(', ')})</span>`:''}</li>`).join('');
      const table=order.table_name_snapshot?` · ${esc(order.table_name_snapshot)}`:'';
      const st=String(order.status||'received');
      return `<div class="order-card customer-history-card"><div class="oc-head"><div><div class="oc-no">#${esc(order.order_no)}</div><div class="oc-meta">${esc(timeText(order.created_at))}${table}</div></div><span class="pill ${esc(st)}"><span class="pill-dot ${esc(st)}"></span>${esc(statusLabel(st))}</span></div><ul class="oc-items">${items}</ul><div class="row customer-history-total"><b>${esc(c('total'))}</b><b>${esc(money(order.total_amount))}</b></div></div>`;
    }).join('');
  }

  async function refreshHistory(silent){
    ensureUi();const bid=branchId();if(!bid)return;
    try{
      const r=await nativeFetch('/api/public/orders/history',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({branch_id:Number(bid),public_session_token:sessionToken(),table_token:tableToken()||null})});
      const body=await r.json();if(!r.ok){if(!silent)notify(body.error||c('error'));return;}
      historyRows=body.orders||[];renderButton();renderHistory();
    }catch(e){if(!silent)notify(c('error'));}
  }
  async function openHistory(){
    ensureUi();await refreshHistory(false);const modal=document.getElementById('customerHistoryModal');if(modal)modal.classList.add('show');
  }

  // Intercept only the customer create-order request and add the opaque session
  // token. Table-wide history uses the QR token; generic flow uses this token.
  const nativeFetch=global.fetch.bind(global);
  global.fetch=async function(input,init){
    let url='';try{url=new URL(typeof input==='string'?input:input.url,location.href).pathname;}catch(e){}
    const method=String((init&&init.method)||((input&&input.method)||'GET')).toUpperCase();
    if(url==='/api/public/orders'&&method==='POST'&&init&&typeof init.body==='string'){
      try{
        const data=JSON.parse(init.body);data.public_session_token=sessionToken();
        init=Object.assign({},init,{body:JSON.stringify(data)});
      }catch(e){}
      const response=await nativeFetch(input,init);
      if(response.ok)setTimeout(()=>refreshHistory(true),350);
      return response;
    }
    return nativeFetch(input,init);
  };

  function waitForMenu(){
    ensureUi();
    let tries=0;const timer=setInterval(()=>{
      tries++;
      try{menuReady=typeof menuData!=='undefined'&&!!menuData;}catch(e){menuReady=false;}
      if(menuReady){clearInterval(timer);refreshHistory(true);}else if(tries>120){clearInterval(timer);}
    },250);
  }
  document.querySelector('#langSelect')?.addEventListener('change',()=>setTimeout(()=>{updateLabels();renderHistory();},0));
  setInterval(()=>{if(!document.hidden&&menuReady&&(tableToken()||historyRows.length))refreshHistory(true);},POLL_MS);
  waitForMenu();
})(window);
