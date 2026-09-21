const ZAABOS_RESTAURANT_TZ = 'Asia/Vientiane';
function zaabosDateTime(value, options={}) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(localeFor(currentLang), {timeZone: ZAABOS_RESTAURANT_TZ, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', ...options}).format(d);
}
function zaabosTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(localeFor(currentLang), {timeZone: ZAABOS_RESTAURANT_TZ, hour:'2-digit', minute:'2-digit'}).format(d);
}
function formatDateTime(value) { return zaabosDateTime(value); }

'use strict';
// A future optional UI control must not blank the whole SPA on startup.
window.addEventListener('error', () => {
  const login = document.querySelector('#loginView');
  const root = document.querySelector('#appRoot');
  if (login && root && login.classList.contains('hidden') && root.classList.contains('hidden')) {
    login.classList.remove('hidden');
  }
});

/* ZaabOS admin/staff SPA. Vanilla JS, no build step — same approach as CASHFLOW24. */

let me = null;
let boot = { branches: [], tables: [], categories: [], items: [] };
let currentBranchId = null;
let optGroupsDraft = []; // working copy while editing a menu item's option groups
let menuItemImageDraft = null; // working copy of the menu item image (data:image/... URI, or null) while editing
let cart = []; // staff take-order cart: {menu_item_id,name,unit_price,qty,selected_options:{gid:oid},optionLabels,notes}
let pendingCartItem = null; // item being configured in the option picker
let activeOrders = []; // live, non-terminal orders for the current branch (feeds the table board + side panel)
let ordersPollTimer = null;

let zaabosOfflineMode=false, zaabosSyncRunning=false, offlineOutboxRows=[];
const ZAABOS_OFFLINE_DB='ZaabOSOfflineV1', ZAABOS_OFFLINE_MAX_AGE=24*60*60*1000;
function offlineDb(){return new Promise((resolve,reject)=>{const q=indexedDB.open(ZAABOS_OFFLINE_DB,1);q.onupgradeneeded=()=>{const d=q.result;if(!d.objectStoreNames.contains('kv'))d.createObjectStore('kv');if(!d.objectStoreNames.contains('outbox')){const s=d.createObjectStore('outbox',{keyPath:'client_request_id'});s.createIndex('created_at','created_at');}};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}
async function offlinePut(store,key,value){const d=await offlineDb();return new Promise((res,rej)=>{const tx=d.transaction(store,'readwrite');const st=tx.objectStore(store);key===undefined?st.put(value):st.put(value,key);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});}
async function offlineGet(store,key){const d=await offlineDb();return new Promise((res,rej)=>{const q=d.transaction(store).objectStore(store).get(key);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});}
async function offlineAll(store){const d=await offlineDb();return new Promise((res,rej)=>{const q=d.transaction(store).objectStore(store).getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>rej(q.error);});}
async function offlineDelete(store,key){const d=await offlineDb();return new Promise((res,rej)=>{const tx=d.transaction(store,'readwrite');tx.objectStore(store).delete(key);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});}
function deviceId(){let id=localStorage.getItem('zaabos_device_id');if(!id){id=(crypto.randomUUID?crypto.randomUUID():'dev-'+Date.now()+'-'+Math.random().toString(16).slice(2));localStorage.setItem('zaabos_device_id',id);}return id;}
function requestId(){return crypto.randomUUID?crypto.randomUUID():'req-'+Date.now()+'-'+Math.random().toString(16).slice(2);}
async function cacheOfflineSession(){if(!me||me.role==='super_admin')return;await offlinePut('kv','session',{me,boot,cached_at:Date.now()});}
async function restoreOfflineSession(){const c=await offlineGet('kv','session');if(!c||!c.me||!c.boot||Date.now()-Number(c.cached_at||0)>ZAABOS_OFFLINE_MAX_AGE)return false;me=c.me;boot=c.boot;zaabosOfflineMode=true;if(!currentBranchId||!boot.branches.some(b=>b.id===currentBranchId))currentBranchId=boot.branches[0]?.id||null;return true;}
async function queueOfflineOrder(payload){
  const rec={client_request_id:payload.client_request_id||requestId(),client_device_id:deviceId(),offline_created_at:new Date().toISOString(),created_at:Date.now(),status:'pending',last_error:'',payload:{...payload}};
  rec.payload.client_request_id=rec.client_request_id;rec.payload.client_device_id=rec.client_device_id;rec.payload.offline_created_at=rec.offline_created_at;
  await offlinePut('outbox',undefined,rec);await renderOfflineQueue();return rec;
}
async function renderOfflineQueue(){
  const box=$('#offlineQueuePanel');if(!box)return;const rows=(await offlineAll('outbox')).sort((a,b)=>a.created_at-b.created_at);offlineOutboxRows=rows;
  box.classList.toggle('hidden',!rows.length);$('#offlineQueueSummary').textContent=`${rows.length} รายการ`;
  $('#offlineQueueList').innerHTML=rows.map(x=>`<div class="offline-queue-row"><span>${x.payload.order_type==='dine_in'?'โต๊ะ '+escapeHtml((boot.tables.find(t=>t.id===x.payload.table_id)||{}).name||''):escapeHtml(orderTypeLabel(x.payload.order_type))}</span><b>${x.status==='conflict'?'ต้องตรวจสอบ':'รอส่ง'}</b>${x.last_error?`<small>${escapeHtml(x.last_error)}</small>`:''}<div class="offline-queue-actions">${x.status==='conflict'?`<button class="ghost-btn" data-offline-retry="${x.client_request_id}">ลองใหม่</button>`:''}<button class="ghost-btn danger" data-offline-remove="${x.client_request_id}">ลบคิว</button></div></div>`).join('');
  if(typeof renderTableBoard==='function'){renderTableBoard();renderOtherOrders();}
}
async function syncOfflineOrders(){
  if(zaabosSyncRunning||!navigator.onLine||!me)return;zaabosSyncRunning=true;
  try{
    const rows=(await offlineAll('outbox')).sort((a,b)=>a.created_at-b.created_at);
    for(const rec of rows){
      if(rec.status==='conflict')continue;
      try{
        await apiJson('/api/orders','POST',rec.payload);
        await offlineDelete('outbox',rec.client_request_id);
      }catch(e){
        if(!navigator.onLine || e.transient || !e.status){rec.status='pending';rec.last_error=e.message||'';await offlinePut('outbox',undefined,rec);break;}
        rec.status='conflict';rec.last_error=e.message;await offlinePut('outbox',undefined,rec);
      }
    }
  }finally{zaabosSyncRunning=false;await renderOfflineQueue();if(navigator.onLine&&!zaabosOfflineMode){loadOrders();loadBoardData();}}
}


// Resize/compress an <input type=file> image client-side into a small JPEG
// data: URI, so it can ride along in the existing image_url text column with
// no file storage/volume needed. Keeps typical photos well under ~150KB.
function resizeImageFile(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith('image/')) { reject(new Error(t('err_image_invalid_type'))); return; }
    if (file.size > 15 * 1024 * 1024) { reject(new Error(t('err_image_too_large'))); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height) { if (width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; } }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error(t('err_image_invalid_type')));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error(t('err_generic')));
    reader.readAsDataURL(file);
  });
}

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

function fmtMoney(n) {
  const cur = (me && me.tenant && me.tenant.currency) || 'LAK';
  const symbols = { LAK: '₭', THB: '฿', USD: '$', CNY: '¥' };
  const sym = symbols[cur] || '';
  const num = Math.round(Number(n) || 0);
  return sym + num.toLocaleString('en-US');
}

function toast(msg, type) {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function api(url, opts) {
  opts = opts || {};
  const silent = opts.silent; // true for background refreshes — see below
  opts.headers = opts.headers || {};
  opts.credentials = 'same-origin';
  if (opts.method && opts.method !== 'GET') {
    opts.headers['X-CSRF-Token'] = (me && me.csrf_token) || '';
  }
  let r;
  try { r = await fetch(url, opts); }
  catch (e) {
    if (!silent) toast('การเชื่อมต่อขัดข้อง กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง','err');
    const err=new Error('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้'); err.status=0; err.transient=true; throw err;
  }
  let body = null;
  try { body = await r.json(); } catch (e) { /* no body */ }
  if (r.status === 401) {
    // A background poll (the 8-second table-board refresh) must NEVER force
    // everyone back to the login screen on its own — that was silently closing
    // whatever the staff had open (take-order, edit modals, ...) within a few
    // seconds, on every page, since the poll runs everywhere. Only an action
    // the user actually took (clicking save/submit/etc, silent not set) is
    // allowed to show the login screen — a real expired session is then
    // caught the moment someone tries to do something, instead of yanked away
    // mid-task by a request nobody triggered.
    if (!silent) { me = null; showLogin(); }
    const err=new Error((body && body.error) || t('err_please_login')); err.status=401; err.transient=false; throw err;
  }
  if (!r.ok) {
    const fallback = r.status >= 500 ? 'ระบบบันทึกข้อมูลขัดข้อง กรุณาลองอีกครั้ง' : t('err_generic');
    const err=new Error((body && body.error) || fallback); err.status=r.status; err.transient=(r.status>=500||r.status===408||r.status===429); throw err;
  }
  return body;
}
function apiJson(url, method, data) {
  return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
}

function openModal(sel) { $(sel).classList.add('show'); }
function closeModals() { $$('.modal').forEach(m => m.classList.remove('show')); }
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]') || e.target.classList.contains('modal')) closeModals();
});

// ===================== i18n wiring =====================

initLangSwitcher('#langSelect');
initLangSwitcher('#loginLangSelect');
applyI18n();
onLangChange(() => {
  applyI18n();
  if (me) {
    $('#whoRole').textContent = t('role_' + me.role) || me.role;
    refreshCurrentTab();
  }
  if ($('#menuItemModal').classList.contains('show')) renderMenuItemImagePreview();
});

// ===================== Auth =====================

function showLogin() {
  $('#appRoot').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
}

function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appRoot').classList.remove('hidden');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#loginUsername').value.trim(), password: $('#loginPassword').value }),
    });
    const body = await r.json();
    if (!r.ok) { $('#loginError').textContent = body.error || t('err_login_failed'); return; }
    me = body;
    await afterLogin();
  } catch (err) { $('#loginError').textContent = t('err_connect_failed'); }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await apiJson('/api/logout', 'POST'); } catch (e) {}
  try { await offlinePut('kv','session',null); } catch(e) {}
  me = null; location.reload();
});

$('#whoBtn').addEventListener('click', () => $('#whoMenu').classList.toggle('hidden'));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.who-wrap')) $('#whoMenu').classList.add('hidden');
});

async function afterLogin() {
  showApp();
  $('#whoAvatar').textContent = (me.display_name || me.username || '?').slice(0, 1).toUpperCase();
  $('#whoName').textContent = me.display_name || me.username;
  $('#whoRole').textContent = t('role_' + me.role) || me.role;

  if (me.role === 'super_admin') {
    $('#tenantSwitcher').classList.remove('hidden');
    $('#tenantsTabBtn').classList.remove('hidden');
    const sel = $('#tenantSwitcher');
    sel.innerHTML = `<option value="all">${escapeHtml(t('tenant_switcher_all'))}</option>` + (me.tenants || []).map(t2 => `<option value="${t2.id}">${escapeHtml(t2.icon || '')} ${escapeHtml(t2.name)}</option>`).join('');
    sel.value = me.tenant_id ? String(me.tenant_id) : 'all';
    sel.onchange = async () => {
      await apiJson('/api/switch-tenant', 'POST', { tenant_id: sel.value === 'all' ? 'all' : parseInt(sel.value, 10) });
      location.reload();
    };
  }

  applyRoleVisibility();

  if (me.must_change_password) openModal('#pwModal');

  await loadBootstrap();
  renderBranchSelect();
  switchTab('orders');

  if (ordersPollTimer) clearInterval(ordersPollTimer);
  ordersPollTimer = setInterval(() => { if (me) loadBoardData(); }, 8000);
}

function applyRoleVisibility() {
  const isOwner = me.role === 'owner' || me.role === 'super_admin';
  const isManagerPlus = isOwner || me.role === 'manager';
  $$('.tabs button[data-tab="branches"], .tabs button[data-tab="users"]').forEach(b => {
    b.classList.toggle('hidden', !isOwner);
  });
  $$('.tabs button[data-tab="reports"], .tabs button[data-tab="pricing"], .tabs button[data-tab="inventory"]').forEach(b => b.classList.toggle('hidden', !isManagerPlus));
  $('#addTableBtn').classList.toggle('hidden', !isManagerPlus);
  $('#bulkAddTablesBtn').classList.toggle('hidden', !isManagerPlus);
  $('#addCategoryBtn').classList.toggle('hidden', !isManagerPlus);
  $('#addMenuItemBtn').classList.toggle('hidden', !isManagerPlus);
}

// ===================== Bootstrap / branch scope =====================

async function loadBootstrap() {
  boot = await api('/api/bootstrap');
  zaabosOfflineMode = false;
  if (!currentBranchId || !boot.branches.some(b => b.id === currentBranchId)) {
    currentBranchId = boot.branches.length ? boot.branches[0].id : null;
  }
  await cacheOfflineSession();
}

function renderBranchSelect() {
  const sel = $('#branchSelect');
  sel.innerHTML = boot.branches.map(b => `<option value="${b.id}">${escapeHtml(b.icon || '')} ${escapeHtml(b.name)}</option>`).join('');
  if (currentBranchId) sel.value = String(currentBranchId);
  sel.onchange = () => { currentBranchId = parseInt(sel.value, 10); refreshCurrentTab(); };
  $('#branchScopeBar').classList.toggle('hidden', boot.branches.length === 0 && me.role !== 'owner' && me.role !== 'super_admin');
}

function branchTables() { return boot.tables.filter(t => t.branch_id === currentBranchId); }
function branchCategories() { return boot.categories.filter(c => c.branch_id === currentBranchId); }
function branchItems() { return boot.items.filter(i => i.branch_id === currentBranchId); }

// ===================== Tabs =====================

$('#mainTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) { switchTab(btn.dataset.tab); $('#moreNavMenu').classList.add('hidden'); $('#moreNavBtn').setAttribute('aria-expanded','false'); }
});
$('#moreNavBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu=$('#moreNavMenu'); const open=menu.classList.toggle('hidden');
  $('#moreNavBtn').setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => { if (!e.target.closest('.nav-more-wrap')) { $('#moreNavMenu').classList.add('hidden'); $('#moreNavBtn').setAttribute('aria-expanded','false'); } });
let historyView='orders';
$('#historyWorkspaceSwitch').addEventListener('click',e=>{const b=e.target.closest('[data-history-view]');if(!b)return;historyView=b.dataset.historyView;$$('#historyWorkspaceSwitch button').forEach(x=>x.classList.toggle('active',x===b));$('#ordersList').classList.toggle('hidden',historyView!=='orders');$('#historyKitchenWorkspace').classList.toggle('hidden',historyView!=='kitchen');if(historyView==='kitchen')loadHistoryKitchen();});

function switchTab(tab) {
  $$('#mainTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + tab));
  refreshCurrentTab(tab);
}
function activeTab() {
  const b = $('#mainTabs button.active');
  return b ? b.dataset.tab : 'orders';
}
function refreshCurrentTab(tab) {
  if (!me) return;
  tab = tab || activeTab();
  if (tab === 'orders') { loadBoardData(); }
  else if (tab === 'history') loadOrders();
  else if (tab === 'tables') renderTables();
  else if (tab === 'menu') loadBootstrap().then(renderMenu); // re-fetch so stock counts (which change from orders placed elsewhere — staff or customer QR) are current whenever this tab is opened
  else if (tab === 'pricing') loadPricing();
  else if (tab === 'inventory') loadInventory();
  else if (tab === 'operations') loadOperations();
  else if (tab === 'receiptsettings') loadReceiptSettings();
  else if (tab === 'reports') loadReports();
  else if (tab === 'branches') renderBranches();
  else if (tab === 'users') loadUsers();
  else if (tab === 'tenants') loadTenants();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===================== Change password / username =====================

$('#changePwBtn').addEventListener('click', () => { $('#whoMenu').classList.add('hidden'); $('#pwError').textContent = ''; $('#pwCurrent').value = ''; $('#pwNew').value = ''; openModal('#pwModal'); });
$('#pwSave').addEventListener('click', async () => {
  $('#pwError').textContent = '';
  const current = $('#pwCurrent').value, next = $('#pwNew').value;
  if (!current || !next) { $('#pwError').textContent = t('err_fill_all'); return; }
  if (next.length < 6) { $('#pwError').textContent = t('err_pw_new_len'); return; }
  try {
    await apiJson('/api/change-password', 'POST', { current_password: current, new_password: next });
    me.must_change_password = false;
    closeModals(); toast(t('toast_password_changed'), 'ok');
  } catch (e) { $('#pwError').textContent = e.message; }
});

$('#changeUsernameBtn').addEventListener('click', () => {
  $('#whoMenu').classList.add('hidden');
  $('#usernameCurrentDisplay').value = me.username; $('#usernameNew').value = ''; $('#usernamePassword').value = ''; $('#usernameError').textContent = '';
  openModal('#usernameModal');
});
$('#usernameSave').addEventListener('click', async () => {
  $('#usernameError').textContent = '';
  const newUsername = $('#usernameNew').value.trim(), pw = $('#usernamePassword').value;
  if (!newUsername || !pw) { $('#usernameError').textContent = t('err_fill_all'); return; }
  if (newUsername.length < 3) { $('#usernameError').textContent = t('err_username_len'); return; }
  try {
    const r = await apiJson('/api/change-username', 'POST', { new_username: newUsername, password: pw });
    me.username = r.username; $('#whoName').textContent = me.display_name || me.username;
    closeModals(); toast(t('toast_username_changed'), 'ok');
  } catch (e) { $('#usernameError').textContent = e.message; }
});

// ===================== Reports (sales summary + income/expense) =====================

let reportFrom = null, reportTo = null;
let lastReportSummary = null;

function isoDate(d) { return d.toISOString().slice(0, 10); }

function presetRange(preset) {
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth(), dt = today.getDate();
  if (preset === 'today') return [isoDate(today), isoDate(today)];
  if (preset === 'yesterday') { const d = new Date(y, m, dt - 1); return [isoDate(d), isoDate(d)]; }
  if (preset === '7d') { const d = new Date(y, m, dt - 6); return [isoDate(d), isoDate(today)]; }
  if (preset === 'month') { return [isoDate(new Date(y, m, 1)), isoDate(today)]; }
  if (preset === 'year') { return [isoDate(new Date(y, 0, 1)), isoDate(today)]; }
  return [isoDate(today), isoDate(today)];
}

$('#reportPresets').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preset]');
  if (!btn) return;
  $$('#reportPresets button').forEach(b => b.classList.toggle('active', b === btn));
  const [f, tt] = presetRange(btn.dataset.preset);
  reportFrom = f; reportTo = tt;
  $('#reportFromDate').value = f; $('#reportToDate').value = tt;
  loadReports();
});
$('#reportApplyBtn').addEventListener('click', () => {
  const f = $('#reportFromDate').value, tt = $('#reportToDate').value;
  if (!f || !tt) return;
  $$('#reportPresets button').forEach(b => b.classList.remove('active'));
  reportFrom = f; reportTo = tt;
  loadReports();
});

async function loadReports() {
  if (!currentBranchId) return;
  if (!reportFrom || !reportTo) {
    const [f, tt] = presetRange('today');
    reportFrom = f; reportTo = tt;
    $('#reportFromDate').value = f; $('#reportToDate').value = tt;
    $$('#reportPresets button').forEach(b => b.classList.toggle('active', b.dataset.preset === 'today'));
  }
  const qs = new URLSearchParams({ from: reportFrom, to: reportTo, branch_id: currentBranchId });
  try {
    const [summary, expenses] = await Promise.all([
      api('/api/reports/summary?' + qs.toString()),
      api('/api/expenses?' + qs.toString()),
    ]);
    lastReportSummary = summary;
    renderReportCards(summary);
    renderTopItems(summary.top_items);
    renderExpensesList(expenses.expenses);
  } catch (e) { toast(e.message, 'err'); }
}

function renderReportCards(s) {
  const profit = s.net_profit;
  $('#reportCards').innerHTML = `
    <div class="report-card"><div class="rc-label">${escapeHtml(t('label_total_sales'))}</div><div class="rc-value">${fmtMoney(s.total_sales)}</div></div>
    <div class="report-card"><div class="rc-label">${escapeHtml(t('label_order_count'))}</div><div class="rc-value">${s.order_count}</div></div>
    <div class="report-card"><div class="rc-label">${escapeHtml(t('label_guest_total'))}</div><div class="rc-value">${s.guests}</div></div>
    <div class="report-card"><div class="rc-label">${escapeHtml(t('label_total_expenses'))}</div><div class="rc-value">${fmtMoney(s.expense_total)}</div></div>
    <div class="report-card"><div class="rc-label">บิลเฉลี่ย</div><div class="rc-value">${fmtMoney(s.average_bill||0)}</div></div>
    <div class="report-card"><div class="rc-label">บิลค้างชำระ</div><div class="rc-value">${s.open_order_count||0} · ${fmtMoney(s.open_order_total||0)}</div></div>
    <div class="report-card"><div class="rc-label">ค่าส่ง</div><div class="rc-value">${fmtMoney(s.delivery_fee||0)}</div></div>
    <div class="report-card rc-profit ${profit < 0 ? 'rc-loss' : ''}"><div class="rc-label">${escapeHtml(t('label_net_profit'))}</div><div class="rc-value">${fmtMoney(profit)}</div></div>
  `;
  const labels={cash:'เงินสด',qr:'QR',card:'บัตร',bank_transfer:'โอนธนาคาร',other:'อื่น ๆ'};
  if (s.refund_total > 0) $('#reportCards').insertAdjacentHTML('beforeend', `<div class="report-card"><div class="rc-label">คืนเงิน</div><div class="rc-value">-${fmtMoney(s.refund_total)}</div><div class="hint">${s.refund_count||0} รายการ · ยอดสุทธิ ${fmtMoney(s.net_sales)}</div></div>`);
  const pb=$('#paymentBreakdown'); if(pb) pb.innerHTML=(s.payment_breakdown||[]).length ? s.payment_breakdown.map(x=>`<div class="report-card"><div class="rc-label">${labels[x.payment_method]||escapeHtml(x.payment_method)}</div><div class="rc-value">${fmtMoney(x.total)}</div><div class="hint">${x.count} รายการ</div></div>`).join('') : emptyState('💳','ยังไม่มีรายการชำระเงิน');
  renderCancellationReport(s.cancellations||{});
}
function renderCancellationReport(c){const el=$('#cancellationReport');if(!el)return;const reasons=c.reasons||[],recent=c.recent||[];if(!(c.total||0)){el.innerHTML=emptyState('✅','ช่วงนี้ไม่มีการยกเลิก');return;}el.innerHTML=`<div class="cancel-summary-cards"><div><b>${c.total}</b><span>เหตุการณ์ยกเลิก</span></div><div><b>${c.order_count}</b><span>ยกเลิกทั้งบิล</span></div><div><b>${c.item_count}</b><span>ยกเลิกรายการ</span></div></div><div class="cancel-reason-list">${reasons.map((x,i)=>`<div class="cancel-reason-row"><span>${i+1}</span><div><b>${escapeHtml(x.reason)}</b><small>${x.order_count} บิล · ${x.item_count} รายการ</small></div><strong>${x.count}</strong></div>`).join('')}</div><details class="cancel-audit"><summary>ดูรายการล่าสุด</summary>${recent.map(x=>`<div class="cancel-audit-row"><span>${x.operation_type==='cancel_order'?'ทั้งบิล':'รายการ'}</span><b>${escapeHtml(x.reason_text||'ไม่ระบุเหตุผล')}</b><small>${escapeHtml(x.performed_by_name||'-')} · ${formatDateTime(x.created_at)}</small></div>`).join('')}</details>`;}

function renderTopItems(items) {
  const el = $('#reportTopItems');
  if (!items || !items.length) { el.innerHTML = emptyState('📊', t('label_no_data')); return; }
  const maxQty = Math.max(...items.map(x => Number(x.qty||0)), 1);
  el.innerHTML = `<div class="top-items-chart">${items.map((it,i)=>{
    const pct=Math.max(4,Math.round((Number(it.qty||0)/maxQty)*100));
    return `<div class="top-bar-row">
      <div class="top-bar-head"><div><span class="top-item-rank">${i+1}</span><b>${escapeHtml(it.name)}</b></div><div><b>${Number(it.qty||0)}</b> รายการ · ${fmtMoney(it.revenue)}</div></div>
      <div class="top-bar-track"><div class="top-bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('')}</div>`;
}

function renderExpensesList(expenses) {
  const el = $('#expensesList');
  if (!expenses || !expenses.length) { el.innerHTML = emptyState('🧾', t('label_no_data')); return; }
  el.innerHTML = expenses.map(ex => `
    <div class="row">
      <div>
        <div style="font-weight:700">${escapeHtml(ex.category)} · ${fmtMoney(ex.amount)}</div>
        <div class="hint">${escapeHtml(ex.expense_date)}${ex.created_by_name ? ' · ' + escapeHtml(ex.created_by_name) : ''}${ex.note ? ' · ' + escapeHtml(ex.note) : ''}</div>
      </div>
      <div class="row-right"><button class="icon-btn danger" data-del-expense="${ex.id}">🗑️</button></div>
    </div>`).join('');
}
$('#expensesList').addEventListener('click', (e) => {
  const delId = e.target.dataset.delExpense;
  if (!delId) return;
  if (!confirm(t('confirm_delete_expense'))) return;
  apiJson('/api/expenses/' + delId, 'DELETE').then(() => { loadReports(); toast(t('toast_deleted'), 'ok'); }).catch(e2 => toast(e2.message, 'err'));
});

$('#addExpenseBtn').addEventListener('click', async () => {
  $('#expenseError').textContent = '';
  $('#expenseCategory').value = ''; $('#expenseAmount').value = ''; $('#expenseNote').value = '';
  $('#expenseDate').value = isoDate(new Date());
  try {
    const r = await api('/api/expense-categories');
    $('#expenseCategoryList').innerHTML = r.categories.map(c => `<option value="${escapeHtml(c)}">`).join('');
  } catch (e) { /* datalist is a nice-to-have, not blocking */ }
  openModal('#expenseModal');
});
$('#expenseSave').addEventListener('click', async () => {
  $('#expenseError').textContent = '';
  const category = $('#expenseCategory').value.trim();
  const amount = parseFloat($('#expenseAmount').value);
  if (!category) { $('#expenseError').textContent = t('err_expense_category_required'); return; }
  if (isNaN(amount) || amount <= 0) { $('#expenseError').textContent = t('err_expense_amount_invalid'); return; }
  try {
    await apiJson('/api/expenses', 'POST', {
      category, amount, expense_date: $('#expenseDate').value || isoDate(new Date()),
      note: $('#expenseNote').value.trim(), branch_id: currentBranchId,
    });
    closeModals(); toast(t('toast_saved'), 'ok'); loadReports();
  } catch (e) { $('#expenseError').textContent = e.message; }
});

// ===================== Branches =====================

function renderBranches() {
  const list = $('#branchesList');
  if (!boot.branches.length) { list.innerHTML = emptyState('🏠', t('empty_branches')); return; }
  list.innerHTML = boot.branches.map(b => `
    <div class="row">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="avatar-badge">${escapeHtml(b.icon || '🏠')}</span>
        <div><div style="font-weight:700">${escapeHtml(b.name)}</div><small>${escapeHtml(t('label_branch_code_prefix'))} #${b.id}</small></div>
      </div>
      <div class="row-right">
        <button class="icon-btn" data-edit-branch="${b.id}">✏️</button>
        <button class="icon-btn danger" data-del-branch="${b.id}">🗑️</button>
      </div>
    </div>`).join('');
}
$('#addBranchBtn').addEventListener('click', () => {
  $('#branchModalTitle').textContent = t('modal_add_branch_title'); $('#branchId').value = ''; $('#branchIcon').value = '🏠'; $('#branchName').value = ''; $('#branchError').textContent = '';
  openModal('#branchModal');
});
$('#branchesList').addEventListener('click', (e) => {
  const editId = e.target.dataset.editBranch, delId = e.target.dataset.delBranch;
  if (editId) {
    const b = boot.branches.find(x => x.id === parseInt(editId, 10));
    $('#branchModalTitle').textContent = t('modal_edit_branch_title'); $('#branchId').value = b.id; $('#branchIcon').value = b.icon; $('#branchName').value = b.name; $('#branchError').textContent = '';
    openModal('#branchModal');
  } else if (delId) {
    if (!confirm(t('confirm_delete_branch'))) return;
    apiJson('/api/branches/' + delId, 'DELETE').then(async () => { await loadBootstrap(); renderBranchSelect(); renderBranches(); toast(t('toast_deleted'), 'ok'); }).catch(e => toast(e.message, 'err'));
  }
});
$('#branchSave').addEventListener('click', async () => {
  $('#branchError').textContent = '';
  const id = $('#branchId').value, name = $('#branchName').value.trim(), icon = $('#branchIcon').value.trim() || '🏠';
  if (!name) { $('#branchError').textContent = t('err_branch_name_required'); return; }
  try {
    if (id) await apiJson('/api/branches/' + id, 'PUT', { name, icon });
    else await apiJson('/api/branches', 'POST', { name, icon });
    closeModals(); await loadBootstrap(); renderBranchSelect(); renderBranches(); toast(t('toast_saved'), 'ok');
  } catch (e) { $('#branchError').textContent = e.message; }
});

// ===================== Tables & QR =====================

function tableOrderUrl(token) { return location.origin + '/order/' + token; }

function renderTables() {
  const grid = $('#tableGrid');
  const tables = branchTables();
  if (!tables.length) { grid.innerHTML = emptyState('🍽️', t('empty_tables')); return; }
  grid.innerHTML = tables.map(t => `
    <div class="table-chip">
      <div class="tc-name">${escapeHtml(t.name)}</div>
      <div class="tc-actions">
        <button data-qr="${t.id}">QR</button>
        <button data-edit-table="${t.id}">✏️</button>
        <button data-del-table="${t.id}">🗑️</button>
      </div>
    </div>`).join('');
}
$('#addTableBtn').addEventListener('click', () => {
  $('#tableModalTitle').textContent = t('modal_add_table_title'); $('#tableId').value = ''; $('#tableName').value = ''; $('#tableError').textContent = '';
  openModal('#tableModal');
});
$('#tableSave').addEventListener('click', async () => {
  $('#tableError').textContent = '';
  const id = $('#tableId').value, name = $('#tableName').value.trim();
  if (!name) { $('#tableError').textContent = t('err_table_name_required'); return; }
  try {
    if (id) await apiJson('/api/tables/' + id, 'PUT', { name });
    else await apiJson('/api/tables', 'POST', { name, branch_id: currentBranchId });
    closeModals(); await loadBootstrap(); renderTables(); toast(t('toast_saved'), 'ok');
  } catch (e) { $('#tableError').textContent = e.message; }
});
$('#bulkAddTablesBtn').addEventListener('click', () => { $('#bulkTableError').textContent = ''; $('#bulkTableCount').value = 10; openModal('#bulkTableModal'); });
$('#bulkTableSave').addEventListener('click', async () => {
  $('#bulkTableError').textContent = '';
  const count = parseInt($('#bulkTableCount').value, 10);
  try {
    const r = await apiJson('/api/tables/bulk', 'POST', { branch_id: currentBranchId, count });
    closeModals(); await loadBootstrap(); renderTables(); toast(t('toast_tables_created', { n: r.created }), 'ok');
  } catch (e) { $('#bulkTableError').textContent = e.message; }
});
$('#tableGrid').addEventListener('click', (e) => {
  const qrId = e.target.dataset.qr, editId = e.target.dataset.editTable, delId = e.target.dataset.delTable;
  if (qrId) showTableQr(parseInt(qrId, 10));
  else if (editId) {
    const tb = boot.tables.find(x => x.id === parseInt(editId, 10));
    $('#tableModalTitle').textContent = t('modal_edit_table_title'); $('#tableId').value = tb.id; $('#tableName').value = tb.name; $('#tableError').textContent = '';
    openModal('#tableModal');
  } else if (delId) {
    if (!confirm(t('confirm_delete_table'))) return;
    apiJson('/api/tables/' + delId, 'DELETE').then(async () => { await loadBootstrap(); renderTables(); toast(t('toast_deleted'), 'ok'); }).catch(e => toast(e.message, 'err'));
  }
});

function qrImgUrl(text, size) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size || 220}x${size || 220}&data=${encodeURIComponent(text)}`;
}
function showTableQr(tableId) {
  const tb = boot.tables.find(x => x.id === tableId);
  const url = tableOrderUrl(tb.qr_token);
  $('#qrModalTitle').textContent = t('qr_table_prefix') + ': ' + tb.name;
  $('#qrModalBody').innerHTML = `
    <div style="text-align:center">
      <img src="${qrImgUrl(url)}" alt="QR" style="border-radius:16px;border:1px solid var(--border)">
      <p class="hint" style="word-break:break-all">${escapeHtml(url)}</p>
      <button class="ghost-btn" id="copyQrUrlBtn">${escapeHtml(t('btn_copy_link'))}</button>
      <a class="ghost-btn" href="${url}" target="_blank" style="text-decoration:none;display:inline-block;margin-left:8px">${escapeHtml(t('btn_open_order_page'))}</a>
    </div>`;
  $('#copyQrUrlBtn').onclick = () => { navigator.clipboard.writeText(url).then(() => toast(t('toast_link_copied'), 'ok')); };
  openModal('#qrModal');
}
$('#qrOverviewBtn').addEventListener('click', () => {
  const tables = branchTables();
  if (!tables.length) { toast(t('empty_tables'), 'err'); return; }
  $('#qrModalTitle').textContent = t('qr_modal_title_all');
  $('#qrModalBody').innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px">` +
    tables.map(tb => {
      const url = tableOrderUrl(tb.qr_token);
      return `<div style="text-align:center"><img src="${qrImgUrl(url, 150)}" style="border-radius:12px;border:1px solid var(--border)"><div style="font-weight:700;margin-top:6px">${escapeHtml(tb.name)}</div></div>`;
    }).join('') + `</div>`;
  openModal('#qrModal');
});

// ===================== Menu (categories + items) =====================

let selectedMenuCategoryId = null;

function renderMenu() {
  const cats=branchCategories();
  if(selectedMenuCategoryId!=null && !cats.some(c=>Number(c.id)===Number(selectedMenuCategoryId))) selectedMenuCategoryId=null;
  if(selectedMenuCategoryId==null && cats.length) selectedMenuCategoryId=cats[0].id;
  renderCategoriesList();
  renderMenuItemsGrid();
  fillCategorySelect();
}
function renderCategoriesList() {
  const cats = branchCategories();
  const list = $('#categoriesList');
  if (!cats.length) { list.innerHTML = emptyState('🍜', t('empty_categories')); return; }
  list.innerHTML = cats.map((c,i) => {
    const count=branchItems().filter(x=>Number(x.category_id)===Number(c.id)).length;
    const active=Number(selectedMenuCategoryId)===Number(c.id);
    return `<div class="menu-category-row ${active?'active':''}" data-select-cat="${c.id}">
      <button class="menu-category-main" type="button" data-select-cat="${c.id}">
        <span class="menu-category-icon">${escapeHtml(c.icon || '🍜')}</span>
        <span class="menu-category-copy"><b>${escapeHtml(c.name)}</b><small>${count} รายการ</small></span>
      </button>
      <div class="menu-category-tools">
        <button class="icon-btn" data-edit-cat="${c.id}" title="แก้ไข">✎</button>
        <button class="icon-btn danger" data-del-cat="${c.id}" title="ลบ">×</button>
      </div>
    </div>`;
  }).join('');
}
$('#categoriesList').addEventListener('click', (e) => {
  const editBtn=e.target.closest('[data-edit-cat]'), delBtn=e.target.closest('[data-del-cat]');
  const editId = editBtn && editBtn.dataset.editCat, delId = delBtn && delBtn.dataset.delCat;
  if (editId) {
    const c = boot.categories.find(x => x.id === parseInt(editId, 10));
    $('#categoryModalTitle').textContent = t('modal_edit_category_title'); $('#categoryId').value = c.id; $('#categoryIcon').value = c.icon; $('#categoryName').value = c.name; $('#categoryError').textContent = '';
    openModal('#categoryModal');
  } else if (delId) {
    if (!confirm(t('confirm_delete_category'))) return;
    apiJson('/api/menu-categories/' + delId, 'DELETE').then(async () => { if(Number(selectedMenuCategoryId)===Number(delId)) selectedMenuCategoryId=null; await loadBootstrap(); renderMenu(); toast(t('toast_deleted'), 'ok'); }).catch(e => toast(e.message, 'err'));
  } else {
    const pick=e.target.closest('[data-select-cat]');
    if(pick){selectedMenuCategoryId=Number(pick.dataset.selectCat);renderCategoriesList();renderMenuItemsGrid();}
  }
});
$('#addCategoryBtn').addEventListener('click', () => {
  $('#categoryModalTitle').textContent = t('modal_add_category_title'); $('#categoryId').value = ''; $('#categoryIcon').value = '🍜'; $('#categoryName').value = ''; $('#categoryError').textContent = '';
  openModal('#categoryModal');
});
$('#categorySave').addEventListener('click', async () => {
  $('#categoryError').textContent = '';
  const id = $('#categoryId').value, name = $('#categoryName').value.trim(), icon = $('#categoryIcon').value.trim() || '🍜';
  if (!name) { $('#categoryError').textContent = t('err_category_name_required'); return; }
  try {
    if (id) await apiJson('/api/menu-categories/' + id, 'PUT', { name, icon });
    else await apiJson('/api/menu-categories', 'POST', { name, icon, branch_id: currentBranchId });
    closeModals(); await loadBootstrap(); renderMenu(); toast(t('toast_saved'), 'ok');
  } catch (e) { $('#categoryError').textContent = e.message; }
});

function fillCategorySelect() {
  const sel = $('#menuItemCategory');
  const cats = branchCategories();
  sel.innerHTML = `<option value="">${escapeHtml(t('option_no_category'))}</option>` + cats.map(c => `<option value="${c.id}">${escapeHtml(c.icon || '')} ${escapeHtml(c.name)}</option>`).join('');
}

function renderMenuItemsGrid() {
  const allItems = branchItems();
  const cat=branchCategories().find(c=>Number(c.id)===Number(selectedMenuCategoryId));
  const items = selectedMenuCategoryId==null ? allItems : allItems.filter(it=>Number(it.category_id)===Number(selectedMenuCategoryId));
  const grid = $('#menuItemsGrid');
  const title=$('#menuWorkspaceTitle'), count=$('#menuWorkspaceCount');
  if(title) title.textContent=cat ? `${cat.icon||'🍜'} ${cat.name}` : 'เมนูทั้งหมด';
  if(count) count.textContent=`${items.length} รายการ`;
  if (!items.length) { grid.innerHTML = emptyState('📋', cat ? 'ยังไม่มีรายการในหมวดหมู่นี้' : t('empty_menu_items')); return; }
  grid.innerHTML = items.map(it => {
    const low = it.track_stock && it.stock_qty != null && it.stock_qty <= it.low_stock_threshold;
    return `<article class="menu-card menu-manager-card ${it.sold_out ? 'sold-out' : ''}">
      <div class="menu-card-media">${it.image_url ? `<img class="mc-photo" src="${it.image_url}" alt="${escapeHtml(it.name)}">` : `<div class="menu-photo-placeholder">🍽️</div>`}
      ${it.sold_out ? `<span class="mc-badge">${escapeHtml(t('badge_sold_out'))}</span>` : (low ? `<span class="mc-badge-stock">${escapeHtml(it.stock_qty <= 0 ? t('badge_out_of_stock') : t('badge_low_stock'))}</span>` : '')}</div>
      <div class="menu-card-body">
        <div class="mc-top"><span class="mc-name">${escapeHtml(it.name)}</span><strong class="mc-price">${fmtMoney(it.base_price)}</strong></div>
        ${it.description ? `<div class="mc-desc">${escapeHtml(it.description)}</div>` : ''}
        <div class="menu-card-meta">${it.option_groups.length ? `<span>ตัวเลือก ${it.option_groups.length}</span>` : ''}${it.track_stock ? `<span>📦 ${it.stock_qty != null ? it.stock_qty : 0}</span>` : ''}</div>
        <div class="mc-actions">
          <button class="ghost-btn" data-edit-item="${it.id}">${escapeHtml(t('btn_edit'))}</button>
          ${it.track_stock ? `<button class="ghost-btn" data-adjust-stock="${it.id}">${escapeHtml(t('btn_adjust_stock'))}</button>` : ''}
          <button class="ghost-btn" data-toggle-soldout="${it.id}">${escapeHtml(it.sold_out ? t('btn_mark_available') : t('btn_mark_sold_out'))}</button>
          <button class="icon-btn danger" data-del-item="${it.id}">🗑️</button>
        </div>
      </div>
    </article>`;
  }).join('');
}
$('#menuItemsGrid').addEventListener('click', (e) => {
  const editId = e.target.dataset.editItem, delId = e.target.dataset.delItem, soId = e.target.dataset.toggleSoldout, adjId = e.target.dataset.adjustStock;
  if (editId) openMenuItemModal(parseInt(editId, 10));
  else if (delId) {
    if (!confirm(t('confirm_delete_menu_item'))) return;
    apiJson('/api/menu-items/' + delId, 'DELETE').then(async () => { await loadBootstrap(); renderMenu(); toast(t('toast_deleted'), 'ok'); }).catch(e => toast(e.message, 'err'));
  } else if (soId) {
    const it = boot.items.find(x => x.id === parseInt(soId, 10));
    apiJson('/api/menu-items/' + soId + '/sold-out', 'PUT', { sold_out: !it.sold_out }).then(async () => { await loadBootstrap(); renderMenu(); }).catch(e => toast(e.message, 'err'));
  } else if (adjId) {
    const it = boot.items.find(x => x.id === parseInt(adjId, 10));
    const raw = prompt(t('label_stock_adjust_amount') + ` (${it.name}, ${t('label_stock_qty')}: ${it.stock_qty || 0})`, '');
    if (raw === null) return;
    const delta = parseInt(raw, 10);
    if (isNaN(delta) || delta === 0) return;
    apiJson('/api/menu-items/' + adjId + '/stock-adjust', 'PUT', { delta }).then(async () => { await loadBootstrap(); renderMenu(); toast(t('toast_saved'), 'ok'); }).catch(e => toast(e.message, 'err'));
  }
});

$('#addMenuItemBtn').addEventListener('click', () => {
  openMenuItemModal(null);
  if(selectedMenuCategoryId!=null) $('#menuItemCategory').value=String(selectedMenuCategoryId);
});

function openMenuItemModal(id) {
  fillCategorySelect();
  fillKitchenStationSelect();
  $('#menuItemError').textContent = '';
  if (id) {
    const it = boot.items.find(x => x.id === id);
    $('#menuItemModalTitle').textContent = t('modal_edit_menu_item_title');
    $('#menuItemId').value = it.id;
    $('#menuItemName').value = it.name;
    $('#menuItemDesc').value = it.description || '';
    $('#menuItemCategory').value = it.category_id || '';
    $('#menuItemPrice').value = it.base_price;
    $('#menuItemSoldOut').checked = !!it.sold_out;
    $('#menuItemCostPrice').value = it.cost_price || 0;
    $('#menuItemTrackStock').checked = !!it.track_stock;
    $('#menuItemStockQty').value = it.stock_qty != null ? it.stock_qty : '';
    $('#menuItemLowStockThreshold').value = it.low_stock_threshold != null ? it.low_stock_threshold : 5;
    $('#menuItemKitchenStation').value = it.kitchen_station_id || '';
    optGroupsDraft = JSON.parse(JSON.stringify(it.option_groups || []));
    menuItemImageDraft = it.image_url || null;
  } else {
    $('#menuItemModalTitle').textContent = t('modal_add_menu_item_title');
    $('#menuItemId').value = ''; $('#menuItemName').value = ''; $('#menuItemDesc').value = '';
    $('#menuItemCategory').value = ''; $('#menuItemPrice').value = ''; $('#menuItemSoldOut').checked = false;
    $('#menuItemCostPrice').value = ''; $('#menuItemTrackStock').checked = false;
    $('#menuItemStockQty').value = ''; $('#menuItemLowStockThreshold').value = 5;
    $('#menuItemKitchenStation').value = '';
    optGroupsDraft = [];
    menuItemImageDraft = null;
  }
  updateStockFieldsVisibility();
  renderOptGroupsBox();
  renderMenuItemImagePreview();
  openModal('#menuItemModal');
}
function updateStockFieldsVisibility() {
  $('#menuItemStockFields').classList.toggle('hidden', !$('#menuItemTrackStock').checked);
}
$('#menuItemTrackStock').addEventListener('change', updateStockFieldsVisibility);

function renderMenuItemImagePreview() {
  const has = !!menuItemImageDraft;
  $('#menuItemImagePreviewWrap').classList.toggle('hidden', !has);
  $('#menuItemImageEmpty').classList.toggle('hidden', has);
  $('#menuItemImageRemoveBtn').classList.toggle('hidden', !has);
  $('#menuItemImageChooseBtn').textContent = t(has ? 'btn_change_image' : 'btn_choose_image');
  if (has) $('#menuItemImagePreview').src = menuItemImageDraft;
}
$('#menuItemImageChooseBtn').addEventListener('click', () => $('#menuItemImageFile').click());
$('#menuItemImageFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('#menuItemError').textContent = '';
  try {
    menuItemImageDraft = await resizeImageFile(file, 900, 0.75);
    renderMenuItemImagePreview();
  } catch (err) { $('#menuItemError').textContent = err.message; }
});
$('#menuItemImageRemoveBtn').addEventListener('click', () => { menuItemImageDraft = null; renderMenuItemImagePreview(); });

function renderOptGroupsBox() {
  const box = $('#optionGroupsBox');
  box.innerHTML = optGroupsDraft.map((g, gi) => `
    <div class="opt-group-box" data-gi="${gi}">
      <div class="og-head">
        <input placeholder="${escapeHtml(t('placeholder_group_name'))}" value="${escapeHtml(g.name || '')}" data-og-name="${gi}" style="margin:0">
        <select data-og-type="${gi}" style="margin:0;min-width:125px"><option value="single" ${g.selection_type !== 'multiple' ? 'selected' : ''}>เลือกได้ 1</option><option value="multiple" ${g.selection_type === 'multiple' ? 'selected' : ''}>เลือกได้หลายข้อ</option></select>
        <label style="margin:0;display:flex;align-items:center;gap:4px;white-space:nowrap"><input type="checkbox" ${g.required || Number(g.min_select||0)>0 ? 'checked' : ''} data-og-required="${gi}" style="width:auto">${escapeHtml(t('label_required_choice'))}</label>
        ${g.selection_type === 'multiple' ? `<label style="margin:0;font-size:12px">สูงสุด <input type="number" min="1" max="20" value="${Number(g.max_select||2)}" data-og-max="${gi}" style="width:65px;margin:0"></label>` : ''}
        <button type="button" data-og-del="${gi}" class="icon-btn danger">🗑️</button>
      </div>
      ${(g.options || []).map((o, oi) => `
        <div class="opt-row" data-oi="${oi}">
          <input placeholder="${escapeHtml(t('placeholder_option_name'))}" value="${escapeHtml(o.name || '')}" data-opt-name="${gi}:${oi}">
          <input type="number" step="0.01" placeholder="${escapeHtml(t('placeholder_option_price'))}" value="${o.price_delta || 0}" data-opt-delta="${gi}:${oi}">
          <button type="button" data-opt-del="${gi}:${oi}" class="icon-btn danger">✕</button>
        </div>`).join('')}
      <button class="add-opt-btn" type="button" data-add-opt="${gi}">${escapeHtml(t('btn_add_option'))}</button>
    </div>`).join('');
}
$('#addOptGroupBtn').addEventListener('click', () => { optGroupsDraft.push({ name: '', required: false, selection_type: 'single', min_select: 0, max_select: 1, options: [] }); renderOptGroupsBox(); });
$('#optionGroupsBox').addEventListener('click', (e) => {
  const addOpt = e.target.dataset.addOpt, delGrp = e.target.dataset.ogDel, delOpt = e.target.dataset.optDel;
  if (addOpt !== undefined) { optGroupsDraft[addOpt].options.push({ name: '', price_delta: 0 }); renderOptGroupsBox(); }
  else if (delGrp !== undefined) { optGroupsDraft.splice(delGrp, 1); renderOptGroupsBox(); }
  else if (delOpt !== undefined) { const [gi, oi] = delOpt.split(':').map(Number); optGroupsDraft[gi].options.splice(oi, 1); renderOptGroupsBox(); }
});
$('#optionGroupsBox').addEventListener('input', (e) => {
  const nameGi = e.target.dataset.ogName, optNameKey = e.target.dataset.optName, optDeltaKey = e.target.dataset.optDelta;
  if (nameGi !== undefined) optGroupsDraft[nameGi].name = e.target.value;
  else if (optNameKey !== undefined) { const [gi, oi] = optNameKey.split(':').map(Number); optGroupsDraft[gi].options[oi].name = e.target.value; }
  else if (optDeltaKey !== undefined) { const [gi, oi] = optDeltaKey.split(':').map(Number); optGroupsDraft[gi].options[oi].price_delta = parseFloat(e.target.value) || 0; }
});
$('#optionGroupsBox').addEventListener('change', (e) => {
  const reqGi = e.target.dataset.ogRequired, typeGi = e.target.dataset.ogType, maxGi = e.target.dataset.ogMax;
  if (reqGi !== undefined) { optGroupsDraft[reqGi].required = e.target.checked; optGroupsDraft[reqGi].min_select = e.target.checked ? 1 : 0; }
  else if (typeGi !== undefined) { optGroupsDraft[typeGi].selection_type = e.target.value; optGroupsDraft[typeGi].max_select = e.target.value === 'multiple' ? Math.max(2, Number(optGroupsDraft[typeGi].max_select||2)) : 1; renderOptGroupsBox(); }
  else if (maxGi !== undefined) optGroupsDraft[maxGi].max_select = Math.max(1, parseInt(e.target.value,10)||1);
});

$('#menuItemSave').addEventListener('click', async () => {
  $('#menuItemError').textContent = '';
  const id = $('#menuItemId').value;
  const name = $('#menuItemName').value.trim();
  const price = parseFloat($('#menuItemPrice').value);
  if (!name) { $('#menuItemError').textContent = t('err_menu_item_name_required'); return; }
  if (isNaN(price) || price < 0) { $('#menuItemError').textContent = t('err_price_invalid'); return; }
  const costPrice = parseFloat($('#menuItemCostPrice').value);
  if ($('#menuItemCostPrice').value !== '' && (isNaN(costPrice) || costPrice < 0)) { $('#menuItemError').textContent = t('err_cost_price_invalid'); return; }
  const trackStock = $('#menuItemTrackStock').checked;
  let stockQty = null, lowStockThreshold = parseInt($('#menuItemLowStockThreshold').value, 10);
  if (isNaN(lowStockThreshold) || lowStockThreshold < 0) lowStockThreshold = 5;
  if (trackStock) {
    stockQty = parseInt($('#menuItemStockQty').value, 10);
    if (isNaN(stockQty) || stockQty < 0) { $('#menuItemError').textContent = t('err_stock_invalid'); return; }
  }
  const payload = {
    name, description: $('#menuItemDesc').value.trim(), category_id: $('#menuItemCategory').value || null,
    base_price: price, sold_out: $('#menuItemSoldOut').checked, option_groups: optGroupsDraft,
    image_url: menuItemImageDraft,
    cost_price: isNaN(costPrice) ? 0 : costPrice, track_stock: trackStock,
    stock_qty: stockQty, low_stock_threshold: lowStockThreshold,
    kitchen_station_id: $('#menuItemKitchenStation').value || null,
  };
  try {
    if (id) await apiJson('/api/menu-items/' + id, 'PUT', payload);
    else await apiJson('/api/menu-items', 'POST', Object.assign({ branch_id: currentBranchId }, payload));
    closeModals(); await loadBootstrap(); renderMenu(); toast(t('toast_saved'), 'ok');
  } catch (e) { $('#menuItemError').textContent = e.message; }
});

// ===================== Users =====================

async function loadUsers() {
  const users = await api('/api/users');
  const list = $('#usersList');
  if (!users.length) { list.innerHTML = emptyState('👥', t('empty_users')); return; }
  list.innerHTML = users.map(u => `
    <div class="row">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="avatar-badge">${escapeHtml((u.display_name || u.username || '?').slice(0, 1).toUpperCase())}</span>
        <div><div style="font-weight:700">${escapeHtml(u.display_name)} ${u.active ? '' : `<small>${escapeHtml(t('label_inactive_suffix'))}</small>`}</div><small>@${escapeHtml(u.username)} · ${escapeHtml(t('role_' + u.role) || u.role)}</small></div>
      </div>
      <div class="row-right">
        <button class="icon-btn" data-edit-user="${u.id}">✏️</button>
        <button class="icon-btn danger" data-del-user="${u.id}">🗑️</button>
      </div>
    </div>`).join('');
  list.dataset.cache = JSON.stringify(users);
}
$('#addUserBtn').addEventListener('click', () => {
  $('#userModalTitle').textContent = t('modal_add_user_title'); $('#userId').value = ''; $('#userUsername').value = ''; $('#userUsername').disabled = false;
  $('#userDisplayName').value = ''; $('#userRole').value = 'staff'; $('#userPassword').value = ''; $('#userPasswordLbl').textContent = t('label_password');
  $('#userActiveRow').classList.add('hidden'); $('#userError').textContent = '';
  openModal('#userModal');
});
$('#usersList').addEventListener('click', (e) => {
  const editId = e.target.dataset.editUser, delId = e.target.dataset.delUser;
  const users = JSON.parse($('#usersList').dataset.cache || '[]');
  if (editId) {
    const u = users.find(x => x.id === parseInt(editId, 10));
    $('#userModalTitle').textContent = t('modal_edit_user_title'); $('#userId').value = u.id; $('#userUsername').value = u.username; $('#userUsername').disabled = true;
    $('#userDisplayName').value = u.display_name; $('#userRole').value = u.role; $('#userPassword').value = ''; $('#userPasswordLbl').textContent = t('label_password_new_optional');
    $('#userActiveRow').classList.remove('hidden'); $('#userActive').checked = !!u.active; $('#userError').textContent = '';
    openModal('#userModal');
  } else if (delId) {
    if (!confirm(t('confirm_deactivate_user'))) return;
    apiJson('/api/users/' + delId, 'DELETE').then(() => { loadUsers(); toast(t('toast_deactivated'), 'ok'); }).catch(e => toast(e.message, 'err'));
  }
});
$('#userSave').addEventListener('click', async () => {
  $('#userError').textContent = '';
  const id = $('#userId').value;
  const displayName = $('#userDisplayName').value.trim(), role = $('#userRole').value, password = $('#userPassword').value;
  try {
    if (id) {
      const payload = { display_name: displayName, role, active: $('#userActive').checked };
      if (password) payload.password = password;
      await apiJson('/api/users/' + id, 'PUT', payload);
    } else {
      const username = $('#userUsername').value.trim();
      if (!username || !displayName || !password) { $('#userError').textContent = t('err_fill_all'); return; }
      await apiJson('/api/users', 'POST', { username, display_name: displayName, role, password });
    }
    closeModals(); loadUsers(); toast(t('toast_saved'), 'ok');
  } catch (e) { $('#userError').textContent = e.message; }
});

// ===================== Tenants (super_admin) =====================

let tenantRows=[];
function subLabel(s){return ({trialing:'Trial',active:'Active',past_due:'Past due',suspended:'Suspended',canceled:'Canceled',expired:'Expired'})[s]||s||'-'}
function renderTenants(){const list=$('#tenantsList'),q=($('#tenantSearch').value||'').toLowerCase(),f=$('#tenantStatusFilter').value;const rows=tenantRows.filter(tn=>{const attention=!tn.active||['past_due','suspended','expired','canceled'].includes(tn.subscription_status);return(!q||tn.name.toLowerCase().includes(q))&&(!f||(f==='attention'?attention:tn.subscription_status===f))});if(!rows.length){list.innerHTML=emptyState('🏢',t('empty_tenants'));return;}list.innerHTML=rows.map(tn=>`<div class="tenant-card"><div class="tenant-card-main"><span class="avatar-badge">${escapeHtml(tn.icon||'🍽️')}</span><div><b>${escapeHtml(tn.name)}</b><small>${escapeHtml(tn.plan_code||'starter')} · ${subLabel(tn.subscription_status)} · ${tn.branch_count}/${tn.max_branches} สาขา · ${tn.user_count}/${tn.max_users} ผู้ใช้</small></div></div><div class="tenant-card-actions"><button class="ghost-btn" data-sub-tenant="${tn.id}">แพ็กเกจ</button>${tn.active?`<button class="ghost-btn danger" data-del-tenant="${tn.id}">ระงับ</button>`:`<button class="ghost-btn" data-reactivate-tenant="${tn.id}">เปิดใช้งาน</button>`}</div></div>`).join('')}
async function loadTenants(){const [r,sum]=await Promise.all([api('/api/tenants'),api('/api/admin/saas-summary')]);tenantRows=r.tenants;renderTenants();$('#saasSummary').innerHTML=`<div><b>${sum.total||0}</b><span>ร้านทั้งหมด</span></div><div><b>${sum.trialing||0}</b><span>Trial</span></div><div><b>${sum.subscribed||0}</b><span>Active</span></div><div><b>${sum.attention||0}</b><span>ต้องตรวจสอบ</span></div>`}
$('#tenantSearch').addEventListener('input',renderTenants);$('#tenantStatusFilter').addEventListener('change',renderTenants);
function localInput(v){if(!v)return '';const d=new Date(v);if(Number.isNaN(d.getTime()))return '';const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`}
$('#tenantsList').addEventListener('click',async e=>{const sub=e.target.closest('[data-sub-tenant]');if(sub){const tn=tenantRows.find(x=>x.id===Number(sub.dataset.subTenant));if(!tn)return;$('#subTenantId').value=tn.id;$('#subTenantName').textContent=tn.name;$('#subPlan').value=tn.plan_code||'starter';$('#subStatus').value=tn.subscription_status||'active';$('#subMaxBranches').value=tn.max_branches||1;$('#subMaxUsers').value=tn.max_users||5;$('#subTrialEnd').value=localInput(tn.trial_ends_at);$('#subPeriodEnd').value=localInput(tn.current_period_end);$('#subNote').value=tn.subscription_note||'';openModal('#subscriptionModal');return;}const del=e.target.closest('[data-del-tenant]');if(del){if(!confirm(t('confirm_suspend_tenant')))return;try{await apiJson('/api/tenants/'+del.dataset.delTenant,'DELETE');toast('ระงับร้านแล้ว','ok');loadTenants()}catch(err){toast(err.message,'err')}return;}const react=e.target.closest('[data-reactivate-tenant]');if(react){try{await apiJson('/api/tenants/'+react.dataset.reactivateTenant+'/reactivate','POST',{});toast('เปิดใช้งานร้านแล้ว','ok');loadTenants()}catch(err){toast(err.message,'err')}}});
$('#subSave').addEventListener('click',async()=>{const id=$('#subTenantId').value,payload={plan_code:$('#subPlan').value,subscription_status:$('#subStatus').value,max_branches:Number($('#subMaxBranches').value),max_users:Number($('#subMaxUsers').value),trial_ends_at:$('#subTrialEnd').value?new Date($('#subTrialEnd').value).toISOString():null,current_period_end:$('#subPeriodEnd').value?new Date($('#subPeriodEnd').value).toISOString():null,subscription_note:$('#subNote').value.trim()};try{await apiJson('/api/tenants/'+id+'/subscription','PUT',payload);closeModals();toast('อัปเดตแพ็กเกจแล้ว','ok');loadTenants()}catch(e){toast(e.message,'err')}});

$('#addTenantBtn').addEventListener('click', () => {
  $('#tenantName').value = ''; $('#tenantOwnerUsername').value = ''; $('#tenantOwnerDisplay').value = ''; $('#tenantOwnerPassword').value = ''; $('#tenantError').textContent = '';
  openModal('#tenantModal');
});
$('#tenantSave').addEventListener('click', async () => {
  $('#tenantError').textContent = '';
  const payload = {
    name: $('#tenantName').value.trim(), owner_username: $('#tenantOwnerUsername').value.trim(),
    owner_display: $('#tenantOwnerDisplay').value.trim(), owner_password: $('#tenantOwnerPassword').value,
    plan_code: $('#tenantPlan').value, trial_days: Number($('#tenantTrialDays').value || 0),
  };
  try {
    await apiJson('/api/tenants', 'POST', payload);
    closeModals(); toast(t('toast_tenant_created'), 'ok');
  } catch (e) { $('#tenantError').textContent = e.message; }
});

// ===================== Orders (staff view) =====================

const STATUS_FLOW = { received: 'preparing', preparing: 'ready', ready: 'served', served: 'completed' };
function statusLabel(s) { return t('status_' + s) || s; }
function orderTypeLabel(s) { return t('order_type_' + s) || s; }

async function loadOrders() {
  const status = $('#orderStatusFilter').value;
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  const r = await api('/api/orders?' + qs.toString());
  renderOrdersList(r.orders);
}
$('#orderStatusFilter').addEventListener('change', loadOrders);
$('#refreshOrdersBtn').addEventListener('click',()=>{loadOrders();if(historyView==='kitchen')loadHistoryKitchen();});
$('#refreshPosBtn').addEventListener('click', loadBoardData);
async function loadHistoryKitchenStations(){if(!currentBranchId)return;try{const rows=await api('/api/kitchen/stations?branch_id='+currentBranchId),sel=$('#historyKitchenStation'),cur=sel.value;sel.innerHTML='<option value="">ทุกสถานี</option>'+rows.map(x=>`<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');sel.value=rows.some(x=>String(x.id)===cur)?cur:'';}catch(e){}}
async function loadHistoryKitchen(){if(!currentBranchId)return;await loadHistoryKitchenStations();const qs=new URLSearchParams({branch_id:currentBranchId}),station=$('#historyKitchenStation').value;if(station)qs.set('station_id',station);try{const r=await api('/api/kitchen/orders?'+qs),rows=(r.orders||[]).filter(o=>['received','preparing','ready'].includes(o.status));$('#historyKitchenCount').textContent=rows.length;$('#historyKitchenBoard').innerHTML=rows.length?rows.map(o=>`<article class="hk-card ${o.status}"><div class="hk-head"><div><b>#${escapeHtml(o.order_no)}</b><span>${escapeHtml(o.table_name_snapshot||orderTypeLabel(o.order_type))}</span></div><time>${fmtClock(o.created_at)}</time></div><div class="hk-items">${o.items.filter(it=>it.kitchen_sent_at&&Number(it.quantity||0)>Number(it.cancelled_quantity||0)).map(it=>`<div><b>${Number(it.quantity||0)-Number(it.cancelled_quantity||0)}×</b><span>${escapeHtml(it.item_name_snapshot)}</span></div>`).join('')}</div><div class="hk-actions">${o.status!=='ready'?`<button data-hk-status="${o.id}:ready" class="hk-ready">✓ พร้อมเสิร์ฟ</button>`:`<button data-hk-status="${o.id}:served" class="hk-served">✓ เสิร์ฟแล้ว</button>`}</div></article>`).join(''):emptyState('👨‍🍳','ไม่มีออเดอร์ที่ต้องติดตามในครัว');}catch(e){toast(e.message,'err')}}
$('#historyKitchenStation').addEventListener('change',loadHistoryKitchen);
$('#historyKitchenBoard').addEventListener('click',async e=>{const b=e.target.closest('[data-hk-status]');if(!b)return;const [id,status]=b.dataset.hkStatus.split(':');try{await apiJson('/api/orders/'+id+'/status','PUT',{status});toast(status==='ready'?'พร้อมเสิร์ฟแล้ว':'บันทึกว่าเสิร์ฟแล้ว','ok');loadHistoryKitchen();loadOrders();}catch(err){toast(err.message,'err')}});

function fmtClock(iso) {
  try { return zaabosTime(iso); }
  catch (e) { return ''; }
}

function orderCardHtml(o) {
  const nextStatus = STATUS_FLOW[o.status];
  const kitchenEligible = o.status !== 'cancelled';
  const itemsHtml = o.items.map(it => {
    const optsHtml = it.options.length ? ` <span class="hint">(${it.options.map(op => escapeHtml(op.option_name_snapshot)).join(', ')})</span>` : '';
    const sentBadge = it.kitchen_sent_at
      ? `<span class="oc-kitchen-sent-badge" title="${escapeHtml(t('label_kitchen_sent_at'))} ${fmtClock(it.kitchen_sent_at)}">🔔 ${fmtClock(it.kitchen_sent_at)}</span>` : '';
    const activeQty = Math.max(0, Number(it.quantity || 0) - Number(it.cancelled_quantity || 0));
    const editable = kitchenEligible && o.payment_status === 'unpaid' && o.status !== 'completed';
    const cb = editable && activeQty > 0 && !it.kitchen_sent_at
      ? `<input type="checkbox" class="oc-item-cb" data-item-id="${it.id}">` : '';
    const editControls = editable && activeQty > 0 ? `<span class="oc-edit-controls"><button type="button" class="mini-step" data-item-qty="${o.id}:${it.id}:${Math.max(1,activeQty-1)}:${activeQty}" ${activeQty<=1?'disabled':''}>−</button><b>${activeQty}</b><button type="button" class="mini-step" data-item-qty="${o.id}:${it.id}:${activeQty+1}:${activeQty}">+</button><button type="button" class="mini-cancel" data-cancel-item="${o.id}:${it.id}:${activeQty}">ยกเลิกรายการ</button></span>` : '';
    return `<li class="oc-item-row">
      <label class="oc-item-label">${cb}<span><b>${activeQty}×</b> ${escapeHtml(it.item_name_snapshot)}${optsHtml}${it.cancelled_quantity ? ` <small class="cancelled-note">ยกเลิก ${it.cancelled_quantity}</small>` : ''}</span></label>${editControls}
      ${sentBadge}
    </li>`;
  }).join('');
  return `
    <div class="order-card" data-order-id="${o.id}">
      <div class="oc-head">
        <div>
          <div class="oc-no">#${escapeHtml(o.order_no)} — ${escapeHtml(orderTypeLabel(o.order_type))}${o.table_name_snapshot ? ' · ' + escapeHtml(o.table_name_snapshot) : ''}</div>
          <div class="oc-meta">${escapeHtml(o.customer_name)}${o.customer_phone ? ' · ' + escapeHtml(o.customer_phone) : ''} · ${zaabosDateTime(o.created_at)}${o.scheduled_for ? ' · ⏰ '+escapeHtml(zaabosDateTime(o.scheduled_for)) : ''}${o.order_type==='delivery' && Number(o.delivery_fee||0)>0 ? ' · 🛵 '+fmtMoney(o.delivery_fee) : ''}</div>
        </div>
        <div style="text-align:right">
          <span class="pill ${o.status}"><span class="pill-dot ${o.status}"></span>${escapeHtml(statusLabel(o.status))}</span><br>
          ${o.status !== 'cancelled' ? `<span class="pill ${o.payment_status}" style="margin-top:6px">${escapeHtml(o.payment_status === 'paid' ? t('payment_paid') : t('payment_unpaid'))}</span>` : ''}
        </div>
      </div>
      <ul class="oc-items">${itemsHtml}</ul>
      ${o.notes ? `<div class="hint">${escapeHtml(t('label_notes'))}: ${escapeHtml(o.notes)}</div>` : ''}
      <div class="row" style="border-top:1px dashed var(--border)"><b>${escapeHtml(t('label_total_short'))}</b><b>${fmtMoney(o.total_amount)}</b></div>
      <div class="head-actions" style="margin-top:8px">
        ${o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn" data-set-status="${o.id}:cancelled">${escapeHtml(t('kt_btn_cancel'))}</button>` : ''}
        ${o.order_type !== 'dine_in' && o.status !== 'cancelled' ? `<button class="ghost-btn" data-fulfillment="${o.id}:confirmed">รับออเดอร์</button><button class="ghost-btn" data-fulfillment="${o.id}:ready">พร้อมรับ</button>${o.order_type==='delivery'?`<button class="ghost-btn" data-fulfillment="${o.id}:out_for_delivery">กำลังจัดส่ง</button><button class="ghost-btn" data-fulfillment="${o.id}:delivered">ส่งสำเร็จ</button>`:`<button class="ghost-btn" data-fulfillment="${o.id}:picked_up">รับแล้ว</button>`}` : ''}

      </div>
      ${kitchenEligible && o.items.some(it => !it.kitchen_sent_at && (Number(it.quantity||0)-Number(it.cancelled_quantity||0))>0) ? `
      <div class="oc-kitchen-actions">
        <span class="hint">รายการใหม่ที่ยังไม่เข้าครัว:</span>
        <label class="oc-select-all"><input type="checkbox" data-select-all-kitchen="${o.id}"> ${escapeHtml(t('label_select_all'))}</label>
        <button class="ghost-btn btn-send-kitchen" data-send-kitchen="${o.id}" disabled>🔔 ${escapeHtml(t('btn_send_to_kitchen'))}</button>
      </div>` : `<div class="hint oc-auto-kitchen">✅ รายการที่ต้องส่งเข้าครัวถูกส่งแล้ว</div>`}
      <div class="oc-pay-actions">
        ${o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn primary" data-add-items="${o.id}">➕ เพิ่มอาหาร</button>` : ''}
        ${o.order_type === 'dine_in' && o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn" data-move-order="${o.id}">↔️ ย้ายโต๊ะ</button>` : ''}
        ${o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn btn-confirm-pay" data-confirm-payment="${o.id}">${escapeHtml(t('btn_confirm_payment_done'))}</button>` : ''}
        <button class="ghost-btn" data-print-receipt="${o.id}">${escapeHtml(t('btn_print_receipt'))}</button>
        ${o.payment_status === 'paid' && (me.role === 'owner' || me.role === 'manager' || me.role === 'super_admin') ? `<button class="ghost-btn danger" data-refund-order="${o.id}">↩️ คืนเงิน</button>` : ''}
        ${o.payment_status === 'paid' ? `<button class="ghost-btn" data-reopen-order="${o.id}">↩️ เปิดบิลกลับมาแก้ไข</button>` : ''}
        ${o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn" data-bill-manager="${o.id}">🧾 จัดการบิล</button>` : ''}\n
      </div>
    </div>`;
}

function renderOrdersList(orders) {
  const list = $('#ordersList');
  if (!orders.length) { list.innerHTML = emptyState('🧾', t('empty_orders')); return; }
  list.innerHTML = orders.map(o => `<div style="margin-top:12px">${orderCardHtml(o)}</div>`).join('');
}

function updateSendKitchenBtnState(card) {
  const anyChecked = !!card.querySelector('.oc-item-cb:checked');
  const btn = card.querySelector('.btn-send-kitchen');
  if (btn) btn.disabled = !anyChecked;
  const cbs = card.querySelectorAll('.oc-item-cb');
  const allChecked = cbs.length > 0 && Array.from(cbs).every(cb => cb.checked);
  const selectAll = card.querySelector('[data-select-all-kitchen]');
  if (selectAll) selectAll.checked = allChecked;
}

async function sendSelectedToKitchen(orderId, card) {
  const item_ids = Array.from(card.querySelectorAll('.oc-item-cb:checked')).map(cb => parseInt(cb.dataset.itemId, 10));
  if (!item_ids.length) return;
  try {
    await apiJson('/api/orders/' + orderId + '/send-to-kitchen', 'PUT', { item_ids });
    toast(t('toast_sent_to_kitchen'), 'ok');
    printKitchenTicket(orderId, item_ids);
    onOrderActionDone();
  } catch (e) { toast(e.message, 'err'); }
}


const DEFAULT_OPERATION_REASONS = ['กดรายการผิด','สินค้าหมด / หมดสต็อก','ลูกค้ารอนานเกินไป','ลูกค้าเปลี่ยนใจ / ไม่รับรายการ','ราคา / จำนวนไม่ถูกต้อง'];
let reasonResolve = null, selectedReason = '';
function chooseOperationReason(actionLabel){
  return new Promise(resolve=>{
    reasonResolve=resolve; selectedReason=''; $('#reasonModalTitle').textContent=`เลือกเหตุผล${actionLabel}`; $('#reasonCustom').value=''; $('#reasonError').textContent='';
    $('#reasonChoices').innerHTML=DEFAULT_OPERATION_REASONS.map((x,i)=>`<button type="button" class="reason-choice" data-reason-index="${i}">${escapeHtml(x)}</button>`).join('');
    openModal('#reasonModal');
  });
}
$('#reasonChoices').addEventListener('click',e=>{const b=e.target.closest('[data-reason-index]');if(!b)return; selectedReason=DEFAULT_OPERATION_REASONS[Number(b.dataset.reasonIndex)]; $$('.reason-choice',$('#reasonChoices')).forEach(x=>x.classList.toggle('active',x===b));});
$('#reasonConfirmBtn').addEventListener('click',()=>{const reason=($('#reasonCustom').value.trim()||selectedReason).trim();if(!reason){$('#reasonError').textContent='กรุณาเลือกเหตุผล';return;} const r=reasonResolve;reasonResolve=null;closeModals();if(r)r(reason);});

async function criticalActionPayload(actionLabel) {
  const reason=await chooseOperationReason(actionLabel);
  if(!reason) return null;
  const payload={reason:reason.trim()};
  if(me && me.role==='staff'){
    const username=prompt('รายการนี้ต้องได้รับอนุมัติจาก Owner/Manager\nชื่อผู้ใช้ผู้อนุมัติ:');
    if(username===null) return null;
    const password=prompt('รหัสผ่านผู้อนุมัติ:');
    if(password===null) return null;
    payload.approval_username=username.trim(); payload.approval_password=password;
  }
  return payload;
}
async function cancelOrderItemCritical(oid,iid,qty){
  const payload=await criticalActionPayload('การยกเลิกรายการ'); if(!payload) return;
  if(!confirm('ยืนยันยกเลิกรายการนี้?')) return;
  payload.quantity=Number(qty);
  try{ await apiJson(`/api/orders/${oid}/items/${iid}/cancel`,'PUT',payload); toast('ยกเลิกรายการและบันทึกประวัติแล้ว','ok'); onOrderActionDone(); }catch(e){ toast(e.message,'err'); }
}
async function setOrderStatusCritical(id,status){
  let payload={status};
  if(status==='cancelled'){
    const c=await criticalActionPayload('การยกเลิกออเดอร์'); if(!c) return;
    payload={...payload,...c}; if(!confirm('ยืนยันยกเลิกออเดอร์นี้?')) return;
  }
  try{ await apiJson('/api/orders/'+id+'/status','PUT',payload); if(status==='cancelled'){ closeModals(); toast('ยกเลิกออเดอร์แล้ว โต๊ะกลับเป็นว่าง','ok'); } onOrderActionDone(); }catch(e){ toast(e.message,'err'); }
}

function wireOrderActionClicks(container) {
  container.addEventListener('click', (e) => {
    const s = e.target.dataset.setStatus, p = e.target.dataset.setPayment;
    const cp = e.target.dataset.confirmPayment, pr = e.target.dataset.printReceipt;
    const sk = e.target.dataset.sendKitchen, ai = e.target.dataset.addItems, mv = e.target.dataset.moveOrder;
    const rf = e.target.dataset.refundOrder, mg = e.target.dataset.mergeOrder, sp = e.target.dataset.splitOrder, bm=e.target.dataset.billManager, ff=e.target.dataset.fulfillment, ro=e.target.dataset.reopenOrder;
    const iq = e.target.dataset.itemQty, ci = e.target.dataset.cancelItem;
    if (ff) { const [oid,status]=ff.split(':'); apiJson(`/api/orders/${oid}/fulfillment`,'PUT',{fulfillment_status:status}).then(onOrderActionDone).catch(err=>toast(err.message,'err')); }
    else if (iq) {
      const [oid,iid,qty,oldQty]=iq.split(':');
      const target=Number(qty), previous=Number(oldQty);
      if(target < previous){
        criticalActionPayload('การลดจำนวนสินค้า').then(payload=>{
          if(!payload) return; payload.quantity=target;
          apiJson(`/api/orders/${oid}/items/${iid}/quantity`,'PUT',payload).then(onOrderActionDone).catch(err=>toast(err.message,'err'));
        });
      } else { apiJson(`/api/orders/${oid}/items/${iid}/quantity`,'PUT',{quantity:target}).then(onOrderActionDone).catch(err=>toast(err.message,'err')); }
    }
    else if (ci) { const [oid,iid,qty]=ci.split(':'); cancelOrderItemCritical(oid,iid,qty); }
    else if (ai) { openAddItemsToOrder(parseInt(ai,10)); }
    else if (mv) { openMoveTable(parseInt(mv,10)); }
    else if (s) { const [id, status] = s.split(':'); setOrderStatusCritical(id,status); }
    else if (p) { const [id, payment_status] = p.split(':'); apiJson('/api/orders/' + id + '/payment', 'PUT', { payment_status }).then(onOrderActionDone).catch(err => toast(err.message, 'err')); }
    else if (cp) { openConfirmPaymentModal(parseInt(cp, 10)); }
    else if (pr) { printReceipt(parseInt(pr, 10)); }
    else if (rf) { refundOrder(parseInt(rf,10)); }
    else if (ro) { reopenPaidOrder(parseInt(ro,10)); }
    else if (bm) { openBillManager(parseInt(bm,10)); }
    else if (mg) { mergeOrder(parseInt(mg,10)); }
    else if (sp) { splitOrder(parseInt(sp,10)); }
    else if (sk) { const card = e.target.closest('.order-card'); if (card) sendSelectedToKitchen(parseInt(sk, 10), card); }
  });
  container.addEventListener('change', (e) => {
    const card = e.target.closest('.order-card');
    if (!card) return;
    if (e.target.matches('[data-select-all-kitchen]')) {
      card.querySelectorAll('.oc-item-cb').forEach(cb => { cb.checked = e.target.checked; });
      updateSendKitchenBtnState(card);
    } else if (e.target.matches('.oc-item-cb')) {
      updateSendKitchenBtnState(card);
    }
  });
}
wireOrderActionClicks($('#ordersList'));
wireOrderActionClicks($('#orderDetailBody'));

async function reopenPaidOrder(orderId){
  const payload=await criticalActionPayload('การเปิดบิลที่ชำระแล้วกลับมาแก้ไข'); if(!payload) return;
  reopenOrderId=orderId; reopenPayload=payload; $('#reopenError').textContent=''; $('#reopenQuickShift').classList.add('hidden'); $('#reopenOpeningCash').value=''; openModal('#reopenModal');
}

let refundOrderId=null,reopenOrderId=null,reopenPayload=null;
async function submitReopenOrder(){
  if(reopenOrderId==null)return false; const id=reopenOrderId,payload=reopenPayload||{}; $('#reopenError').textContent='';
  try{await apiJson(`/api/orders/${id}/reopen`,'POST',payload);closeModals();reopenOrderId=null;reopenPayload=null;toast('เปิดบิลกลับมาแก้ไขแล้ว โต๊ะกลับมาใช้งานอีกครั้ง','ok');onOrderActionDone();setTimeout(()=>switchTab('orders'),100);return true}
  catch(e){$('#reopenError').textContent=e.message;if((e.message||'').includes('เปิดกะ'))$('#reopenQuickShift').classList.remove('hidden');return false}
}
$('#reopenSubmit').addEventListener('click',submitReopenOrder);
$('#reopenOpenShiftBtn').addEventListener('click',async()=>{
  if(!currentBranchId)return; const opening=Number($('#reopenOpeningCash').value||0);
  if(!Number.isFinite(opening)||opening<0){$('#reopenError').textContent='เงินทอนตั้งต้นไม่ถูกต้อง';return}
  try{await apiJson('/api/operations/shift/open','POST',{branch_id:currentBranchId,opening_cash:opening,notes:'เปิดกะจากขั้นตอน Reopen บิลเงินสด'});toast('เปิดกะแล้ว กำลังเปิดบิลกลับมาแก้ไข','ok');refreshPosShiftBadge();await submitReopenOrder()}catch(e){$('#reopenError').textContent=e.message}
});

async function refundOrder(orderId) {
  const order=findOrderById(orderId);
  const paidTotal=order ? Number(order.grand_total || order.total_amount || 0) : 0;
  const alreadyRefunded=order ? Number(order.refund_total || 0) : 0;
  const maxAmount=Math.max(0,paidTotal-alreadyRefunded);
  refundOrderId=orderId; $('#refundMax').textContent=fmtMoney(maxAmount); $('#refundAmount').value=''; $('#refundAmount').max=maxAmount||''; $('#refundReason').value=''; $('#refundError').textContent=''; openModal('#refundModal');
}
$('#refundSubmit').addEventListener('click',async()=>{
  if(refundOrderId==null)return; const raw=$('#refundAmount').value.trim(),amount=raw===''?null:Number(raw),reason=$('#refundReason').value.trim(); $('#refundError').textContent='';
  if(amount!==null&&(!Number.isFinite(amount)||amount<=0)){ $('#refundError').textContent='ยอดคืนเงินไม่ถูกต้อง'; return; }
  const max=Number($('#refundAmount').max||0); if(amount!==null&&max>0&&amount>max){$('#refundError').textContent='ยอดคืนเงินเกินยอดที่คืนได้';return;}
  if(!reason){$('#refundError').textContent='กรุณาระบุเหตุผลการคืนเงิน';return;}
  const payload={reason};if(amount!==null)payload.amount=amount;const id=refundOrderId;
  try{const r=await apiJson(`/api/orders/${id}/refund`,'POST',payload);closeModals();refundOrderId=null;toast(`คืนเงิน ${fmtMoney(r.amount)} แล้ว · คืนได้อีก ${fmtMoney(r.remaining_refundable||0)}`,'ok');onOrderActionDone()}catch(e){$('#refundError').textContent=e.message}
});

let billManagerSource=null,billManagerMode='move';
function openBillManager(sourceId){
  billManagerSource=findOrderById(sourceId); if(!billManagerSource)return;
  billManagerMode='move'; $$('#billManagerModal [data-bm-mode]').forEach((b,i)=>b.classList.toggle('active',i===0));
  renderBillManager(); openModal('#billManagerModal');
}
$$('#billManagerModal [data-bm-mode]').forEach(b=>b.addEventListener('click',()=>{billManagerMode=b.dataset.bmMode;$$('#billManagerModal [data-bm-mode]').forEach(x=>x.classList.toggle('active',x===b));renderBillManager();}));
function bmSelectedItems(body){
  const items=[];
  body.querySelectorAll('[data-bm-qty]').forEach(x=>{const q=Number(x.textContent);if(q>0)items.push({item_id:Number(x.dataset.bmQty),quantity:q})});
  return items;
}
function renderBillManager(){
  const o=billManagerSource, body=$('#billManagerBody'); if(!o)return;
  if(billManagerMode==='move'){
    const tables=branchTables().filter(t=>String(t.id)!==String(o.table_id));
    body.innerHTML=`<div class="bm-move-head"><div><span class="bm-kicker">ย้ายทั้งบิล</span><h3>${escapeHtml(o.table_name_snapshot||'โต๊ะปัจจุบัน')} <span>→</span> เลือกโต๊ะปลายทาง</h3><p>โต๊ะที่มีออเดอร์อยู่จะย้ายทั้งบิลเข้าไปไม่ได้ เพื่อป้องกันบิลชนกัน</p></div><span class="bm-bill-no">#${escapeHtml(o.order_no)}</span></div>
      <div class="bm-grid bm-table-grid">${tables.map(t=>{const active=tableActiveOrders(t.id).filter(x=>x.id!==o.id&&!['cancelled','completed'].includes(x.status));const occupied=active.length>0;return `<button class="bm-choice bm-table-choice ${occupied?'is-occupied':''}" ${occupied?'disabled':''} data-bm-table="${t.id}"><span class="bm-table-icon">${occupied?'●':'▦'}</span><span><b>${escapeHtml(t.name||('โต๊ะ '+t.id))}</b><small>${occupied?'มีออเดอร์อยู่ · ย้ายทั้งบิลไม่ได้':'ว่าง · แตะเพื่อย้ายทั้งบิล'}</small></span><span class="bm-arrow">${occupied?'ล็อก':'→'}</span></button>`}).join('')||'<div class="bm-empty">ไม่มีโต๊ะปลายทาง</div>'}</div>`;
  }else if(billManagerMode==='merge'){
    const targets=(activeOrders||[]).filter(x=>x.id!==o.id&&x.branch_id===o.branch_id&&x.payment_status==='unpaid'&&!['cancelled','completed'].includes(x.status));
    body.innerHTML=`<div class="bm-section-head"><div><span class="bm-kicker">รวมทั้งบิล</span><h3>เลือกบิลปลายทาง</h3><p>รายการทั้งหมดจากบิลนี้จะถูกรวมเข้าบิลที่เลือก</p></div></div><div class="bm-grid">${targets.map(x=>`<button class="bm-choice" data-bm-target="${x.id}"><b>${escapeHtml(x.table_name_snapshot||'ไม่มีโต๊ะ')}</b><small>#${escapeHtml(x.order_no)} · ${fmtMoney(x.total_amount)}</small></button>`).join('')||'<div class="bm-empty">ไม่มีบิลที่รวมได้</div>'}</div>`;
  }else{
    const rows=o.items.filter(it=>Number(it.quantity||0)-Number(it.cancelled_quantity||0)>0);
    const occupiedTargets=(activeOrders||[]).filter(x=>x.id!==o.id&&x.branch_id===o.branch_id&&x.order_type==='dine_in'&&x.payment_status==='unpaid'&&!['cancelled','completed'].includes(x.status));
    body.innerHTML=`<div class="bm-section-head"><div><span class="bm-kicker">ย้ายบางรายการ</span><h3>เลือกรายการและจำนวน</h3><p>ใช้เมื่อลูกค้าย้ายบางเมนูไปอีกโต๊ะ หรืออยากแยกเป็นบิลใหม่ โดยสต็อกและครัวจะไม่ถูกนับซ้ำ</p></div></div>
      <div class="bm-items">${rows.map(it=>{const q=Number(it.quantity||0)-Number(it.cancelled_quantity||0);return `<div class="bm-item"><div><b>${escapeHtml(it.item_name_snapshot)}</b><small>ในบิล ${q}</small></div><div class="qty-stepper"><button data-bm-minus="${it.id}">−</button><span data-bm-qty="${it.id}" data-max="${q}">0</span><button data-bm-plus="${it.id}">+</button></div></div>`}).join('')}</div>
      <div class="bm-destination"><span class="bm-kicker">ปลายทาง</span><div class="bm-destination-actions"><button class="bm-new-bill" id="bmSplitConfirm">＋ แยกเป็นบิลใหม่</button></div>
      ${occupiedTargets.length?`<div class="bm-target-label">หรือย้ายรายการที่เลือกไปยังบิล/โต๊ะที่มีออเดอร์อยู่</div><div class="bm-grid bm-target-grid">${occupiedTargets.map(x=>`<button class="bm-choice bm-target-choice" data-bm-split-target="${x.id}"><span><b>${escapeHtml(x.table_name_snapshot||'ไม่มีโต๊ะ')}</b><small>#${escapeHtml(x.order_no)} · ${fmtMoney(x.total_amount)}</small></span><span class="bm-arrow">→</span></button>`).join('')}</div>`:'<div class="bm-target-label">ตอนนี้ไม่มีโต๊ะอื่นที่มีบิลเปิดอยู่</div>'}</div>`;
    $('#bmSplitConfirm').onclick=async()=>{const items=bmSelectedItems(body);if(!items.length){toast('เลือกรายการก่อน','err');return;}try{const r=await apiJson(`/api/orders/${o.id}/split`,'POST',{items});closeModals();toast(`แยกเป็นบิล #${r.new_order_no}`,'ok');onOrderActionDone()}catch(e){toast(e.message,'err')}};
  }
}
$('#billManagerBody').addEventListener('click',async e=>{
  const t=e.target.closest('[data-bm-table]');if(t&&!t.disabled){const destination=t.querySelector('b')?.textContent||'โต๊ะปลายทาง';if(!confirm(`ยืนยันย้ายทั้งบิลไป ${destination}?`))return;try{await apiJson(`/api/orders/${billManagerSource.id}/move-table`,'PUT',{table_id:Number(t.dataset.bmTable)});closeModals();toast(`ย้ายไป ${destination} แล้ว`,'ok');onOrderActionDone()}catch(err){toast(err.message,'err')}return;}
  const m=e.target.closest('[data-bm-target]');if(m){const destination=m.querySelector('b')?.textContent||'บิลปลายทาง';if(!confirm(`ยืนยันรวมทั้งบิลเข้ากับ ${destination}?`))return;try{await apiJson(`/api/orders/${billManagerSource.id}/merge`,'POST',{target_order_id:Number(m.dataset.bmTarget)});closeModals();toast('รวมบิลแล้ว','ok');onOrderActionDone()}catch(err){toast(err.message,'err')}return;}
  const st=e.target.closest('[data-bm-split-target]');if(st){const body=$('#billManagerBody'),items=bmSelectedItems(body);if(!items.length){toast('เลือกรายการก่อน','err');return;}const destination=st.querySelector('b')?.textContent||'โต๊ะปลายทาง';if(!confirm(`ย้ายเฉพาะรายการที่เลือกไป ${destination}?`))return;try{await apiJson(`/api/orders/${billManagerSource.id}/split`,'POST',{items,target_order_id:Number(st.dataset.bmSplitTarget)});closeModals();toast(`ย้ายรายการไป ${destination} แล้ว`,'ok');onOrderActionDone()}catch(err){toast(err.message,'err')}return;}
  const id=e.target.dataset.bmPlus||e.target.dataset.bmMinus;if(id){const q=$(`#billManagerBody [data-bm-qty="${id}"]`);let n=Number(q.textContent),mx=Number(q.dataset.max);n=e.target.dataset.bmPlus?Math.min(mx,n+1):Math.max(0,n-1);q.textContent=n;}
});

async function mergeOrder(sourceId) {
  const candidates=activeOrders.filter(o=>o.id!==sourceId && o.payment_status==='unpaid' && o.status!=='cancelled' && o.status!=='completed');
  if(!candidates.length){ toast('ไม่มีบิลเปิดอื่นสำหรับรวม','err'); return; }
  const choices=candidates.map(o=>`${o.id}: #${o.order_no}${o.table_name_snapshot?' · '+o.table_name_snapshot:''}`).join('\n');
  const raw=prompt('กรอก ID บิลปลายทาง:\n'+choices); if(raw===null) return;
  const target=Number(raw); if(!Number.isInteger(target)){ toast('ID บิลไม่ถูกต้อง','err'); return; }
  if(!confirm('ยืนยันรวมบิล? รายการทั้งหมดจะย้ายไปบิลปลายทาง')) return;
  try { await apiJson(`/api/orders/${sourceId}/merge`,'POST',{target_order_id:target}); toast('รวมบิลเรียบร้อย','ok'); onOrderActionDone(); }
  catch(e){ toast(e.message,'err'); }
}

async function splitOrder(sourceId){
  const ord=findOrderById(sourceId); if(!ord){toast('ไม่พบบิล','err');return;}
  const rows=ord.items.map(it=>({it,active:Math.max(0,Number(it.quantity||0)-Number(it.cancelled_quantity||0))})).filter(x=>x.active>0);
  const guide=rows.map((x,i)=>`${i+1}. ${x.it.item_name_snapshot} — มี ${x.active}`).join('\n');
  const raw=prompt('แยกบิล — เลือกรายการและจำนวน\n\n'+guide+'\n\nพิมพ์แบบ 1x1, 2x2'); if(raw===null)return;
  const selected=[],used=new Set();
  for(const part of raw.split(',')){const m=part.trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/);if(!m){toast('รูปแบบไม่ถูกต้อง เช่น 1x1, 2x2','err');return;}const pos=Number(m[1])-1,qty=Number(m[2]);if(!rows[pos]||qty<1||qty>rows[pos].active||used.has(pos)){toast('รายการหรือจำนวนไม่ถูกต้อง','err');return;}used.add(pos);selected.push({item_id:rows[pos].it.id,quantity:qty});}
  const moved=selected.reduce((a,x)=>a+x.quantity,0),all=rows.reduce((a,x)=>a+x.active,0);if(!selected.length||moved>=all){toast('ต้องเหลืออย่างน้อย 1 รายการในบิลเดิม','err');return;}
  if(!confirm(`ยืนยันแยก ${moved} รายการเป็นบิลใหม่?\nจะไม่หักสต็อกหรือส่งครัวซ้ำ`))return;
  try{const r=await apiJson(`/api/orders/${sourceId}/split`,'POST',{items:selected});closeModals();toast(`แยกบิลสำเร็จ → #${r.new_order_no}`,'ok');onOrderActionDone();}catch(e){toast(e.message,'err');}
}

function onOrderActionDone() { loadOrders(); loadBoardData(); }

function findOrderById(orderId) {
  return activeOrders.find(x => x.id === orderId) || lastOrdersFlat.find(x => x.id === orderId);
}

let cpOrderId=null,extraPaymentParts=[];
function cpBaseDue(){const o=findOrderById(cpOrderId);if(!o)return 0;return Math.max(0,Number(o.total_amount||0)-Math.max(0,Number($('#cpDiscount').value||0)));}
function paymentMethodName(m){return({cash:'เงินสด',qr:'QR',card:'บัตร',bank_transfer:'โอนธนาคาร',other:'อื่น ๆ'})[m]||m}
function updateCpPaymentSummary(){const due=cpBaseDue(),method=$('#cpMethod').value;$('#cpCashLabel').classList.toggle('hidden',method!=='cash');const primary=Math.max(0,Number($('#cpPrimaryAmount').value||0)),extras=extraPaymentParts.reduce((a,x)=>a+Math.max(0,Number(x.amount||0)),0),paid=primary+extras,remaining=Math.max(0,due-paid),cash=method==='cash'?Math.max(0,Number($('#cpCash').value||0)):0;$('#cpPaidTotal').textContent=fmtMoney(paid);$('#cpRemaining').textContent=fmtMoney(remaining);$('#cpRemaining').classList.toggle('payment-ok',Math.abs(paid-due)<.005);$('#cpChange').textContent=fmtMoney(method==='cash'?Math.max(0,cash-primary):0);}
function renderPaymentParts(){const el=$('#cpPaymentParts');if(!el)return;el.innerHTML=extraPaymentParts.map((p,i)=>`<div class="payment-part-row"><select data-part-method="${i}"><option value="cash">💵 เงินสด</option><option value="qr">📱 QR</option><option value="card">💳 บัตร</option><option value="bank_transfer">🏦 โอน</option><option value="other">อื่น ๆ</option></select><input data-part-amount="${i}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="ยอดช่องทางนี้" value="${p.amount||''}"><button class="icon-btn danger" data-remove-part="${i}">×</button></div>`).join('');extraPaymentParts.forEach((p,i)=>{const m=el.querySelector(`[data-part-method="${i}"]`);if(m)m.value=p.method});updateCpPaymentSummary();}
function openConfirmPaymentModal(orderId){const o=findOrderById(orderId);if(!o)return;cpOrderId=orderId;extraPaymentParts=[];$('#cpTotal').textContent=fmtMoney(o.total_amount);$('#cpPromo').value='';$('#cpDiscount').value='';$('#cpDiscountReason').value='';$('#cpApprovalUser').value='';$('#cpApprovalPass').value='';$('#cpAdvanced').open=false;$('#cpMethod').value=o.payment_method&&o.payment_method!=='split'?o.payment_method:'cash';$('#cpPrimaryAmount').value=String(Number(o.total_amount||0));$('#cpCash').value=String(Number(o.total_amount||0));$('#cpError').textContent='';renderPaymentParts();openModal('#confirmPaymentModal');}
$('#cpMethod').addEventListener('change',()=>{if($('#cpMethod').value==='cash'&&!$('#cpCash').value)$('#cpCash').value=$('#cpPrimaryAmount').value;updateCpPaymentSummary()});$('#cpPrimaryAmount').addEventListener('input',updateCpPaymentSummary);$('#cpCash').addEventListener('input',updateCpPaymentSummary);
$('#cpDiscount').addEventListener('input',()=>{const due=cpBaseDue(),extras=extraPaymentParts.reduce((a,x)=>a+Number(x.amount||0),0);$('#cpPrimaryAmount').value=String(Math.max(0,due-extras));updateCpPaymentSummary()});
$('#cpAddPayment').addEventListener('click',()=>{const due=cpBaseDue(),paid=Number($('#cpPrimaryAmount').value||0)+extraPaymentParts.reduce((a,x)=>a+Number(x.amount||0),0);extraPaymentParts.push({method:'qr',amount:Math.max(0,due-paid)});renderPaymentParts()});
$('#cpPaymentParts').addEventListener('input',e=>{let i=e.target.dataset.partAmount;if(i!==undefined)extraPaymentParts[+i].amount=Number(e.target.value||0);i=e.target.dataset.partMethod;if(i!==undefined)extraPaymentParts[+i].method=e.target.value;updateCpPaymentSummary()});$('#cpPaymentParts').addEventListener('click',e=>{const i=e.target.dataset.removePart;if(i!==undefined){extraPaymentParts.splice(+i,1);renderPaymentParts()}});
$('#cpSubmit').addEventListener('click',async()=>{if(cpOrderId==null)return;$('#cpError').textContent='';const id=cpOrderId,method=$('#cpMethod').value,primary=Number($('#cpPrimaryAmount').value||0);if(primary<=0){$('#cpError').textContent='กรุณาระบุยอดชำระ';return}const parts=[{method,amount:primary,cash_received:method==='cash'?(Number($('#cpCash').value||0)||primary):null},...extraPaymentParts.map(x=>({method:x.method,amount:Number(x.amount||0)}))],due=cpBaseDue(),paid=parts.reduce((a,x)=>a+Number(x.amount||0),0);if(Math.abs(paid-due)>.005){$('#cpError').textContent=`ยอดชำระยังไม่ครบ: ชำระ ${fmtMoney(paid)} / ${fmtMoney(due)}`;return}if(parts.some(x=>x.amount<=0)){ $('#cpError').textContent='ยอดแต่ละช่องทางต้องมากกว่า 0';return}const payload={payment_status:'paid',payment_method:method,payments:parts},promo=$('#cpPromo').value.trim(),disc=$('#cpDiscount').value.trim(),dr=$('#cpDiscountReason').value.trim(),au=$('#cpApprovalUser').value.trim(),ap=$('#cpApprovalPass').value;if(promo)payload.promotion_code=promo;if(disc)payload.discount_amount=parseFloat(disc);if(dr)payload.discount_reason=dr;if(au)payload.approval_username=au;if(ap)payload.approval_password=ap;try{const result=await apiJson('/api/orders/'+id+'/payment','PUT',payload);toast('ชำระเงินสำเร็จ · '+result.payments.map(x=>paymentMethodName(x.method)+' '+fmtMoney(x.amount)).join(' + '),'ok');closeModals();cpOrderId=null;const fresh=await api('/api/orders?branch_id='+encodeURIComponent(currentBranchId||''));lastOrdersFlat=fresh.orders||[];activeOrders=lastOrdersFlat.filter(o=>o.status!=='completed'&&o.status!=='cancelled');renderTableBoard();renderOtherOrders();renderSidePanel();printReceipt(id)}catch(e){$('#cpError').textContent=e.message}});

function printElement(el) {
  // Print isolation: only .print-target is shown at print time (see the
  // body>* {display:none} rule in style.css) — this is what keeps a small
  // 80mm receipt to a single page instead of also pulling in the whole
  // (invisible but still full-height) app layout underneath it.
  el.classList.add('print-target');
  const cleanup = () => el.classList.remove('print-target');
  window.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(() => { window.print(); setTimeout(cleanup, 1000); }, 50);
}

async function printReceipt(orderId) {
  const o = findOrderById(orderId);
  if (!o) return;
  const branch = (boot && boot.branches && boot.branches.find(b => Number(b.id) === Number(o.branch_id))) || null;
  let rs={}; try{rs=await api('/api/settings/receipt?branch_id='+encodeURIComponent(o.branch_id))}catch(e){}
  const shopName = rs.shop_name || ((me && me.tenant && me.tenant.name) || 'ZaabOS');
  const displayBranch = rs.branch_name || (branch&&branch.name) || '';
  const receiptClass=`paper-${rs.paper_width||'80'} font-${rs.font_scale||'normal'} head-${rs.header_align||'center'}`;
  const tax = Number(o.tax_amount || 0);
  const subtotal = Number(o.total_amount || 0);
  const discount = Number(o.discount_amount || 0);
  const service = Number(o.service_charge_amount || 0);
  const grandTotal = Math.max(0, subtotal - discount) + service + tax;
  const paymentNames = {cash:'Cash / ເງິນສົດ',qr:'QR',card:'Card',bank_transfer:'Bank transfer',other:'Other'};
  const paymentRows = Array.isArray(o.payments) ? o.payments : [];
  const activeCashRows = paymentRows.filter(p => p.payment_method === 'cash');
  const cash = activeCashRows.length
    ? activeCashRows.reduce((sum,p)=>sum+Number(p.cash_received != null ? p.cash_received : p.amount || 0),0)
    : ((o.cash_received != null && o.cash_received !== '') ? Number(o.cash_received) : null);
  const cashDue = activeCashRows.reduce((sum,p)=>sum+Number(p.amount||0),0);
  const change = cash != null ? Math.max(0, cash - (activeCashRows.length ? cashDue : grandTotal)) : null;
  const paymentBreakdown = paymentRows.length
    ? paymentRows.map(p => `<div class=\"rp-row\"><span>${escapeHtml(paymentNames[p.payment_method] || p.payment_method)}</span><span>${fmtMoney(Number(p.amount||0))}</span></div>`).join('')
    : (o.payment_method ? `<div class=\"rp-row\"><span>Payment</span><span>${escapeHtml(paymentNames[o.payment_method] || o.payment_method)}</span></div>` : '');
  const paidAt = o.paid_at ? new Date(o.paid_at) : null;
  const createdAt = o.created_at ? new Date(o.created_at) : new Date();
  const activeItems = (o.items || []).filter(it => Number(it.quantity || 0) - Number(it.cancelled_quantity || 0) > 0);
  const itemsRows = activeItems.map(it => {
    const qty = Number(it.quantity || 0) - Number(it.cancelled_quantity || 0);
    const amount = qty * Number(it.unit_price || 0);
    const opts = (it.options || []).length ? `<div class="rp-item-sub">${escapeHtml(it.options.map(op => op.option_name_snapshot).join(' / '))}</div>` : '';
    const note = it.notes ? `<div class="rp-item-sub">${escapeHtml(it.notes)}</div>` : '';
    return `<tr><td class="rp-qty">${qty}</td><td class="rp-item">${escapeHtml(it.item_name_snapshot)}${opts}${note}</td><td class="rp-price">${fmtMoney(amount)}</td></tr>`;
  }).join('');
  const guest = o.guest_count != null ? o.guest_count : '-';
  $('#receiptPrintArea').className='receipt-print '+receiptClass;
  $('#receiptPrintArea').innerHTML = `
    <div class="rp-brand">${escapeHtml(shopName)}</div>
    ${rs.subtitle!=='' ? `<div class="rp-brand-sub">${escapeHtml(rs.subtitle||'RESTAURANT · POS')}</div>` : ''}
    ${rs.show_branch!==false && displayBranch ? `<div class="rp-center">${escapeHtml(displayBranch)}</div>` : ''}
    ${rs.address ? `<div class="rp-center rp-shop-detail">${escapeHtml(rs.address)}</div>` : ''}
    ${rs.phone ? `<div class="rp-center rp-shop-detail">${escapeHtml(rs.phone)}</div>` : ''}
    ${rs.tax_id ? `<div class="rp-center rp-shop-detail">Tax ID: ${escapeHtml(rs.tax_id)}</div>` : ''}
    <div class="rp-sep"></div>
    <div class="rp-meta"><span>${escapeHtml(t('label_table') || 'Table')}</span><b>${escapeHtml(o.table_name_snapshot || orderTypeLabel(o.order_type))}</b>${rs.show_guest!==false?`<span class="rp-guest-label">${escapeHtml(t('label_guest_count_short') || 'Guests')}</span><b class="rp-guest-value">${escapeHtml(String(guest))}</b>`:''}</div>
    <div class="rp-meta rp-order"><span>Order</span><b>#${escapeHtml(o.order_no)}</b></div>
    <div class="rp-sep"></div>
    <table class="rp-items"><tbody>${itemsRows}</tbody></table>
    <div class="rp-sep"></div>
    <div class="rp-row"><span>${escapeHtml(t('label_subtotal'))}</span><span>${fmtMoney(subtotal)}</span></div>
    ${discount > 0 ? `<div class="rp-row"><span>ส่วนลด${o.discount_label?' · '+escapeHtml(o.discount_label):''}</span><span>−${fmtMoney(discount)}</span></div>` : ''}
    ${service > 0 ? `<div class="rp-row"><span>Service charge</span><span>${fmtMoney(service)}</span></div>` : ''}
    ${tax > 0 ? `<div class="rp-row"><span>${escapeHtml(t('label_tax_amount'))}</span><span>${fmtMoney(tax)}</span></div>` : ''}
    <div class="rp-total"><span>${escapeHtml(t('label_total_short'))}</span><span>${fmtMoney(grandTotal)}</span></div>
    ${o.payment_status === 'paid' ? `<div class="rp-paid">【 PAID · ຊຳລະແລ້ວ 】</div>` : ''}
    ${rs.show_payment_breakdown!==false ? paymentBreakdown : (o.payment_method ? `<div class="rp-row"><span>Payment</span><span>${escapeHtml(paymentNames[o.payment_method] || o.payment_method)}</span></div>` : '')}
    ${cash != null ? `<div class="rp-row"><span>${escapeHtml(t('label_cash_received'))}</span><span>${fmtMoney(cash)}</span></div>` : ''}
    ${change != null ? `<div class="rp-row"><span>${escapeHtml(t('label_change'))}</span><span>${fmtMoney(change)}</span></div>` : ''}
    <div class="rp-sep"></div>
    ${rs.show_order_time!==false?`<div class="rp-footrow"><span>Order time</span><span>${zaabosDateTime(createdAt)}</span></div>`:''}
    ${paidAt && rs.show_paid_time!==false ? `<div class="rp-footrow"><span>Paid time</span><span>${zaabosDateTime(paidAt)}</span></div>` : ''}
    ${o.created_by_name && rs.show_cashier!==false ? `<div class="rp-footrow"><span>Cashier</span><span>${escapeHtml(o.created_by_name)}</span></div>` : ''}
    <div class="rp-thanks">${escapeHtml(rs.footer||t('receipt_thank_you'))}</div>
    <div class="rp-powered">ZaabOS</div>`;
  printElement($('#receiptPrintArea'));
}

function printKitchenTicket(orderId, itemIds) {
  const o = findOrderById(orderId);
  if (!o) return;
  const items = o.items.filter(it => itemIds.includes(it.id));
  if (!items.length) return;
  const itemsHtml = items.map(it => {
    const optLine = it.options.length ? `<div class="kt-print-opts">${escapeHtml(it.options.map(op => op.option_name_snapshot).join(', '))}</div>` : '';
    const noteLine = it.notes ? `<div class="kt-print-notes">📝 ${escapeHtml(it.notes)}</div>` : '';
    return `<div class="kt-print-item">${it.quantity}× ${escapeHtml(it.item_name_snapshot)}${optLine}${noteLine}</div>`;
  }).join('');
  $('#kitchenTicketPrintArea').innerHTML = `
    <div class="kt-print-head">${escapeHtml(t('kitchen_ticket_header'))}</div>
    <div class="rp-sub">#${escapeHtml(o.order_no)} · ${escapeHtml(orderTypeLabel(o.order_type))}${o.table_name_snapshot ? ' · ' + escapeHtml(o.table_name_snapshot) : ''}</div>
    <div class="rp-sub">${zaabosDateTime(new Date())}</div>
    <div class="rp-line"></div>
    ${itemsHtml}
    ${o.notes ? `<div class="rp-line"></div><div class="kt-print-notes">📝 ${escapeHtml(o.notes)}</div>` : ''}`;
  printElement($('#kitchenTicketPrintArea'));
}

// ===================== Live table board + side panel =====================

let lastOrdersFlat = []; // most recent unfiltered branch order fetch (feeds board/panel + card lookups)
const STATUS_PRIORITY = { received: 0, preparing: 1, ready: 2, served: 3 };

async function refreshPosShiftBadge(){
  const el=$('#posShiftBadge'); if(!el||!currentBranchId)return;
  try{const d=await api('/api/operations/shift?branch_id='+currentBranchId);if(d.shift){el.className='pos-shift-badge open';el.textContent=`● กะเปิด · ${formatDateTime(d.shift.opened_at)}`;}else{el.className='pos-shift-badge closed';el.textContent='○ ยังไม่เปิดกะ · แตะเพื่อเปิด';}el.onclick=()=>switchTab('operations');}catch(e){el.textContent='กะ: ตรวจสอบไม่ได้';}
}

async function loadBoardData() {
  if (!currentBranchId) { activeOrders = []; renderTableBoard(); renderOtherOrders(); renderSidePanel(); return; }
  try {
    const qs = new URLSearchParams({ branch_id: currentBranchId });
    const r = await api('/api/orders?' + qs.toString(), { silent: true });
    lastOrdersFlat = r.orders;
    activeOrders = r.orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled');
  } catch (e) { return; }
  renderTableBoard();
  renderOtherOrders();
  renderSidePanel();
}

function tableActiveOrders(tableId) {
  return activeOrders.filter(o => o.order_type === 'dine_in' && o.table_id === tableId)
    .sort((a, b) => a.id - b.id);
}

function renderTableBoard() {
  const board = $('#tableBoard');
  const tables = branchTables();
  if (!tables.length) { board.innerHTML = emptyState('🍽️', t('empty_tables')); return; }
  board.innerHTML = tables.map(tb => {
    const orders = tableActiveOrders(tb.id);
    if (!orders.length) {
      const local=offlineOutboxRows.filter(x=>x.status!=='conflict'&&x.payload.order_type==='dine_in'&&Number(x.payload.table_id)===Number(tb.id));
      if(local.length)return `<button type="button" class="board-tile offline-pending" data-board-table="${tb.id}" disabled><span class="bt-badge">OFFLINE</span><div class="bt-name">${escapeHtml(tb.name)}</div><div class="bt-empty-lbl">${local.length} ออเดอร์ · รอ Sync</div></button>`;
      return `<button type="button" class="board-tile" data-board-table="${tb.id}">
        <div class="bt-name">${escapeHtml(tb.name)}</div>
        <div class="bt-empty-lbl">${escapeHtml(t('board_table_empty'))}</div>
      </button>`;
    }
    const worst = orders.reduce((w, o) => (STATUS_PRIORITY[o.status] < STATUS_PRIORITY[w.status] ? o : w), orders[0]);
    const hasNew = orders.some(o => o.status === 'received');
    const hasUnpaid = orders.some(o => o.payment_status === 'unpaid');
    const itemCount = orders.reduce((s, o) => s + o.items.reduce((s2, it) => s2 + it.quantity, 0), 0);
    const total = orders.reduce((s, o) => s + o.total_amount, 0);
    return `<button type="button" class="board-tile status-${worst.status}" data-board-table="${tb.id}">
      ${hasNew ? `<span class="bt-badge">${escapeHtml(t('board_badge_new'))}</span>` : ''}
      <div class="bt-name">${escapeHtml(tb.name)}</div>
      <div class="bt-meta">
        <span class="pill ${worst.status}" style="margin:0"><span class="pill-dot ${worst.status}"></span>${escapeHtml(statusLabel(worst.status))}</span><br>
        ${itemCount} ${escapeHtml(t('label_qty_short'))} · ${fmtMoney(total)}
        ${hasUnpaid ? `<br><span class="bt-pay-dot"></span>${escapeHtml(t('board_awaiting_payment'))}` : ''}
      </div>
    </button>`;
  }).join('');
}
$('#tableBoard').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-board-table]');
  if (!btn) return;
  const tableId = parseInt(btn.dataset.boardTable, 10);
  const tb = boot.tables.find(x => x.id === tableId);
  const orders = tableActiveOrders(tableId);
  if (!orders.length) { openTakeOrderForTable(tableId); return; }
  openOrderDetail(orders, tb ? tb.name : '');
});

function renderOtherOrders() {
  const wrap = $('#otherOrdersWrap');
  const list = $('#otherOrdersList');
  const orders = activeOrders.filter(o => o.order_type !== 'dine_in').sort((a, b) => b.id - a.id);
  const local=offlineOutboxRows.filter(x=>x.status!=='conflict'&&x.payload.order_type!=='dine_in');
  if (!orders.length && !local.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  list.innerHTML = local.map(x=>`<div class="side-row offline-local-row"><div class="sr-main"><div class="sr-no"><span class="sr-new-dot"></span>OFFLINE</div><div class="sr-meta">${escapeHtml(orderTypeLabel(x.payload.order_type))} · ${escapeHtml(x.payload.customer_name||'')}</div></div><div class="sr-right"><span class="pill received">รอ Sync</span></div></div>`).join('') + orders.map(o => sidePanelRowHtml(o)).join('');
}
$('#otherOrdersList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-side-order]');
  if (!btn) return;
  const o = activeOrders.find(x => x.id === parseInt(btn.dataset.sideOrder, 10));
  if (o) openOrderDetail([o], orderTypeLabel(o.order_type));
});

function sidePanelRowHtml(o) {
  return `<button type="button" class="side-row" data-side-order="${o.id}">
    <div class="sr-main">
      <div class="sr-no">${o.status === 'received' ? '<span class="sr-new-dot"></span>' : ''}#${escapeHtml(o.order_no)}</div>
      <div class="sr-meta">${escapeHtml(orderTypeLabel(o.order_type))}${o.table_name_snapshot ? ' · ' + escapeHtml(o.table_name_snapshot) : ''} · ${escapeHtml(o.customer_name)}</div>
    </div>
    <div class="sr-right">
      <span class="pill ${o.status}" style="margin:0"><span class="pill-dot ${o.status}"></span>${escapeHtml(statusLabel(o.status))}</span>
      <div class="sr-amt">${fmtMoney(o.total_amount)}</div>
    </div>
  </button>`;
}

function renderSidePanel() {
  const list = $('#sidePanelList');
  const orders = [...activeOrders].sort((a, b) => b.id - a.id);
  if (!orders.length) { list.innerHTML = `<p class="hint" style="margin:0">${escapeHtml(t('side_panel_empty'))}</p>`; return; }
  list.innerHTML = orders.map(o => sidePanelRowHtml(o)).join('');
}
$('#sidePanelList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-side-order]');
  if (!btn) return;
  const o = activeOrders.find(x => x.id === parseInt(btn.dataset.sideOrder, 10));
  if (o) openOrderDetail([o], o.table_name_snapshot || orderTypeLabel(o.order_type));
});

function openOrderDetail(orders, titleSuffix) {
  $('#orderDetailTitle').textContent = t('order_detail_title') + (titleSuffix ? ' — ' + titleSuffix : '');
  $('#orderDetailBody').innerHTML = orders.map(o => orderCardHtml(o)).join('');
  openModal('#orderDetailModal');
}

// ===================== Staff take-order =====================

let takeOrderType = 'dine_in';
let addItemsOrderId = null;

function openTakeOrderForTable(tableId=null) {
  addItemsOrderId = null; cart = []; takeOrderType = 'dine_in';
  $$('#takeOrderType button').forEach(b => b.classList.toggle('active', b.dataset.type === 'dine_in'));
  $('#takeOrderTableRow').classList.remove('hidden'); $('#takeOrderDeliveryFields').classList.add('hidden');
  $('#takeOrderCustomerName').value = ''; $('#takeOrderPhone').value = ''; $('#takeOrderAddress').value = '';
  $('#takeOrderGuestCount').value = ''; $('#takeOrderScheduledFor').value=''; $('#takeOrderDeliveryFee').value='0';
  $('#takeOrderError').textContent = '';
  const tsel = $('#takeOrderTable');
  tsel.innerHTML = branchTables().map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  renderTakeOrderCategories();
  renderTakeOrderMenu();
  renderCart();
  openModal('#takeOrderModal');
  if (tableId) $('#takeOrderTable').value = String(tableId);
}
$('#takeOrderBtn').addEventListener('click', () => openTakeOrderForTable());
$('#takeOrderType').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  takeOrderType = btn.dataset.type;
  $$('#takeOrderType button').forEach(b => b.classList.toggle('active', b === btn));
  $('#takeOrderTableRow').classList.toggle('hidden', takeOrderType !== 'dine_in');
  $('#takeOrderDeliveryFields').classList.toggle('hidden', takeOrderType !== 'delivery');
  $('#takeOrderScheduleRow').classList.toggle('hidden', takeOrderType === 'dine_in');
});

let takeOrderActiveCat = null;
function renderTakeOrderCategories() {
  const cats = branchCategories();
  takeOrderActiveCat = null;
  const el = $('#takeOrderCatScroll');
  el.innerHTML = `<button class="cat-chip active" data-cat="">${escapeHtml(t('cat_all'))}</button>` + cats.map(c => `<button class="cat-chip" data-cat="${c.id}">${escapeHtml(c.icon || '')} ${escapeHtml(c.name)}</button>`).join('');
}
$('#takeOrderCatScroll').addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-chip');
  if (!btn) return;
  takeOrderActiveCat = btn.dataset.cat || null;
  $$('#takeOrderCatScroll .cat-chip').forEach(b => b.classList.toggle('active', b === btn));
  renderTakeOrderMenu();
});
function renderTakeOrderMenu() {
  let items = branchItems();
  if (takeOrderActiveCat) items = items.filter(i => String(i.category_id) === String(takeOrderActiveCat));
  const grid = $('#takeOrderMenuGrid');
  if (!items.length) { grid.innerHTML = emptyState('📋', t('empty_menu')); return; }
  grid.innerHTML = items.map(it => `
    <div class="menu-card ${it.sold_out ? 'sold-out' : ''}" data-pick-item="${it.id}" style="cursor:${it.sold_out ? 'default' : 'pointer'}">
      ${it.sold_out ? `<span class="mc-badge">${escapeHtml(t('badge_sold_out'))}</span>` : ''}
      ${it.image_url ? `<img class="mc-photo" src="${it.image_url}" alt="">` : ''}
      <span class="mc-name">${escapeHtml(it.name)}</span>
      <div class="mc-price">${fmtMoney(it.base_price)}</div>
    </div>`).join('');
}
$('#takeOrderMenuGrid').addEventListener('click', (e) => {
  const id = e.target.closest('[data-pick-item]');
  if (!id) return;
  const item = boot.items.find(x => x.id === parseInt(id.dataset.pickItem, 10));
  if (item.sold_out) return;
  if (!item.option_groups || !item.option_groups.length) {
    const found=cart.find(c=>c.menu_item_id===item.id && !c.optionLabels.length && !c.notes);
    if(found) found.qty += 1; else cart.push({menu_item_id:item.id,name:item.name,unit_price:item.base_price,qty:1,selected_options:{},optionLabels:[],notes:''});
    renderCart(); return;
  }
  openItemOptionPicker(item);
});

function openItemOptionPicker(item) {
  pendingCartItem = { item, selected: {}, qty: 1, notes: '' };
  $('#itemOptionTitle').textContent = item.name;
  $('#itemOptionNotes').value = ''; $('#itemOptionQty').textContent = '1'; $('#itemOptionError').textContent = '';
  const body = $('#itemOptionBody');
  const photoHtml = item.image_url ? `<img class="item-modal-photo" src="${item.image_url}" alt="">` : '';
  if (!item.option_groups.length) {
    body.innerHTML = photoHtml + `<p class="hint">${escapeHtml(t('hint_no_options'))}</p>`;
  } else {
    body.innerHTML = photoHtml + item.option_groups.map(g => `
      <label style="margin:14px 0 4px">${escapeHtml(g.name)}${g.required ? ' <span style="color:var(--neg)">*</span>' : ''}</label>
      <div class="option-pick" data-group="${g.id}">
        ${g.options.map(o => `<label><input type="${g.selection_type === 'multiple' ? 'checkbox' : 'radio'}" name="grp-${g.id}" value="${o.id}" data-delta="${o.price_delta}">${escapeHtml(o.name)}${o.price_delta ? ` (+${fmtMoney(o.price_delta)})` : ''}</label>`).join('')}
        ${g.selection_type === 'multiple' ? `<div class="hint">เลือกได้สูงสุด ${g.max_select || 1} รายการ</div>` : ''}
      </div>`).join('');
  }
  openModal('#itemOptionModal');
}
$('#itemOptionBody').addEventListener('change', (e) => {
  if (!['radio','checkbox'].includes(e.target.type)) return;
  const group = e.target.closest('[data-group]');
  $$('label', group).forEach(l => l.classList.toggle('checked', l.querySelector('input').checked));
});
$('#itemOptionMinus').addEventListener('click', () => { const q = Math.max(1, parseInt($('#itemOptionQty').textContent, 10) - 1); $('#itemOptionQty').textContent = q; });
$('#itemOptionPlus').addEventListener('click', () => { const q = Math.min(50, parseInt($('#itemOptionQty').textContent, 10) + 1); $('#itemOptionQty').textContent = q; });
$('#itemOptionAdd').addEventListener('click', () => {
  $('#itemOptionError').textContent = '';
  const item = pendingCartItem.item;
  const selected = {}; const labels = [];
  let unitPrice = item.base_price;
  for (const g of item.option_groups) {
    const checked = $$(`input[name="grp-${g.id}"]:checked`);
    const minSel = Number(g.min_select != null ? g.min_select : (g.required ? 1 : 0));
    const maxSel = Number(g.selection_type === 'multiple' ? (g.max_select || 1) : 1);
    if (checked.length < minSel) { $('#itemOptionError').textContent = `${t('err_choose_option_group')} "${g.name}"`; return; }
    if (checked.length > maxSel) { $('#itemOptionError').textContent = `เลือก "${g.name}" ได้ไม่เกิน ${maxSel} รายการ`; return; }
    if (checked.length) {
      const opts = checked.map(el => g.options.find(o => String(o.id) === el.value)).filter(Boolean);
      selected[g.id] = g.selection_type === 'multiple' ? opts.map(o => o.id) : opts[0].id;
      opts.forEach(opt => { unitPrice += opt.price_delta; labels.push(opt.name); });
    }
  }
  const qty = parseInt($('#itemOptionQty').textContent, 10);
  cart.push({ menu_item_id: item.id, name: item.name, unit_price: unitPrice, qty, selected_options: selected, optionLabels: labels, notes: $('#itemOptionNotes').value.trim() });
  closeModals(); openModal('#takeOrderModal'); renderCart();
});

function renderCart() {
  const el = $('#takeOrderCart');
  if (!cart.length) { el.innerHTML = `<p class="hint">${escapeHtml(t('empty_cart_staff'))}</p>`; $('#takeOrderTotal').textContent = fmtMoney(0); return; }
  let total = 0;
  el.innerHTML = cart.map((c, idx) => {
    const lineTotal = c.unit_price * c.qty; total += lineTotal;
    return `<div class="cart-line">
      <div><div class="cl-name">${c.qty}× ${escapeHtml(c.name)}</div>${c.optionLabels.length ? `<div class="cl-opts">${c.optionLabels.map(escapeHtml).join(', ')}</div>` : ''}${c.notes ? `<div class="cl-opts">${escapeHtml(t('label_notes'))}: ${escapeHtml(c.notes)}</div>` : ''}</div>
      <div style="text-align:right"><div class="cl-price">${fmtMoney(lineTotal)}</div><div class="cart-steps"><button data-cart-minus="${idx}">−</button><b>${c.qty}</b><button data-cart-plus="${idx}">+</button><button class="icon-btn danger" data-cart-remove="${idx}">✕</button></div></div>
    </div>`;
  }).join('');
  $('#takeOrderTotal').textContent = fmtMoney(total);
}
$('#takeOrderCart').addEventListener('click', (e) => {
  const idx = e.target.dataset.cartRemove;
  if (idx !== undefined) { cart.splice(idx, 1); renderCart(); return; }
  const mi=e.target.dataset.cartMinus, pl=e.target.dataset.cartPlus;
  if(mi!==undefined){ cart[Number(mi)].qty=Math.max(1,cart[Number(mi)].qty-1); renderCart(); }
  if(pl!==undefined){ cart[Number(pl)].qty=Math.min(99,cart[Number(pl)].qty+1); renderCart(); }
});

$('#takeOrderSubmit').addEventListener('click', async () => {
  $('#takeOrderError').textContent = '';
  if (!cart.length) { $('#takeOrderError').textContent = t('err_cart_empty_min1'); return; }
  if ($('#takeOrderSubmit').disabled) return; // already submitting — ignore extra clicks/taps
  const payload = {
    branch_id: currentBranchId, order_type: takeOrderType,
    customer_name: $('#takeOrderCustomerName').value.trim() || t('placeholder_customer_name'),
    cart: cart.map(c => ({ menu_item_id: c.menu_item_id, quantity: c.qty, selected_options: c.selected_options, notes: c.notes })),
  };
  const guestCountRaw = $('#takeOrderGuestCount').value.trim();
  if (guestCountRaw) payload.guest_count = parseInt(guestCountRaw, 10);
  if (takeOrderType === 'dine_in') payload.table_id = parseInt($('#takeOrderTable').value, 10);
  if (takeOrderType !== 'dine_in') payload.scheduled_for = $('#takeOrderScheduledFor').value || null;
  if (takeOrderType === 'delivery') { payload.customer_phone = $('#takeOrderPhone').value.trim(); payload.customer_address = $('#takeOrderAddress').value.trim(); payload.delivery_fee = Number($('#takeOrderDeliveryFee').value || 0); }
  const btn = $('#takeOrderSubmit');
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.textContent = t('btn_submitting') || originalLabel;
  try {
    const endpoint = addItemsOrderId ? `/api/orders/${addItemsOrderId}/items` : '/api/orders';
    const sendPayload = addItemsOrderId ? {items: payload.cart} : {...payload,client_request_id:requestId(),client_device_id:deviceId()};
    let r;
    if (!addItemsOrderId && (!navigator.onLine || zaabosOfflineMode)) {
      const q=await queueOfflineOrder(sendPayload); closeModals(); toast('บันทึกออเดอร์ไว้ในเครื่องแล้ว · รอ Sync','ok'); addItemsOrderId=null; cart=[]; renderOfflineQueue(); return;
    }
    try { r = await apiJson(endpoint, 'POST', sendPayload); }
    catch (netErr) {
      if (!addItemsOrderId && (!navigator.onLine || /เชื่อมต่อเซิร์ฟเวอร์|ระบบบันทึกข้อมูลขัดข้อง/.test(netErr.message))) {
        await queueOfflineOrder(sendPayload); closeModals(); toast('Server ไม่พร้อม · เก็บออเดอร์ไว้ในเครื่องเพื่อ Sync แล้ว','ok'); addItemsOrderId=null; cart=[]; return;
      }
      throw netErr;
    }
    closeModals(); toast(addItemsOrderId ? 'เพิ่มรายการแล้ว — กรุณากดส่งเข้าครัว' : (t('toast_order_saved', { no: r.order_no }) + ' — กรุณากดส่งเข้าครัว'), 'ok');
    addItemsOrderId = null; loadOrders(); loadBoardData();
    // items with stock tracking just got decremented server-side — refresh the
    // cached menu (boot.items) so the Menu tab shows the real count, not what
    // it was before this order was placed
    loadBootstrap().then(() => { if (activeTab() === 'menu') renderMenu(); });
  } catch (e) { $('#takeOrderError').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = originalLabel; }
});


function openAddItemsToOrder(orderId) {
  const ord=findOrderById(orderId); if(!ord) return;
  addItemsOrderId=orderId; cart=[]; takeOrderType=ord.order_type;
  $('#takeOrderTableRow').classList.toggle('hidden', ord.order_type!=='dine_in');
  $('#takeOrderDeliveryFields').classList.add('hidden');
  $('#takeOrderCustomerName').value=ord.customer_name||''; $('#takeOrderGuestCount').value=ord.guest_count||'';
  const tsel=$('#takeOrderTable'); tsel.innerHTML=branchTables().map(t=>`<option value="${t.id}">${escapeHtml(t.name)}</option>`).join(''); if(ord.table_id) tsel.value=String(ord.table_id);
  renderTakeOrderCategories(); renderTakeOrderMenu(); renderCart(); closeModals(); openModal('#takeOrderModal');
}
async function openMoveTable(orderId) {
  const ord=findOrderById(orderId); if(!ord) return;
  openBillManager(orderId);
}

// ===================== Misc =====================

function emptyState(icon, text) { return `<div class="empty-state"><span class="es-ic">${icon}</span>${escapeHtml(text)}</div>`; }

// ===================== Bootstrap on load =====================

(async function initApp() {
  try {
    me = await api('/api/me');
    await afterLogin();
    await renderOfflineQueue(); syncOfflineOrders();
  } catch (e) {
    try {
      if ((e.transient || !e.status) && await restoreOfflineSession()) {
        showApp();
        $('#whoAvatar').textContent=(me.display_name||me.username||'?').slice(0,1).toUpperCase();
        $('#whoName').textContent=(me.display_name||me.username)+' · OFFLINE';
        $('#whoRole').textContent=t('role_'+me.role)||me.role;
        applyRoleVisibility(); renderBranchSelect(); switchTab('orders'); renderTableBoard(); renderOtherOrders(); renderSidePanel(); await renderOfflineQueue();
        toast('เปิดโหมดออฟไลน์ — รับออเดอร์ใหม่ได้ และจะ Sync อัตโนมัติเมื่อระบบกลับมา','ok');
      } else showLogin();
    } catch (_) { showLogin(); }
  }
})();


// ===================== Round 14A Operations =====================
async function loadOperations(){
  refreshPosShiftBadge();
  if(!currentBranchId)return;
  try{
    const data=await api('/api/operations/shift?branch_id='+currentBranchId), sh=data.shift, sum=data.summary||{};
    const status=$('#shiftStatus'), actions=$('#shiftActionArea');
    if(sh){
      const opened=formatDateTime(sh.opened_at), pb=sum.payment_breakdown||{};
      status.innerHTML=`
        <div class="shift-state-card is-open"><span class="shift-dot"></span><div><small>สถานะ</small><b>กะเปิดอยู่</b><span class="shift-sub">${escapeHtml(opened)}</span></div></div>
        <div class="shift-state-card shift-kpi"><small>ยอดรับชำระในกะ</small><b>${fmtMoney(sum.gross_received||0)}</b><span class="shift-sub">${Number(sum.bill_count||0)} บิล</span></div>
        <div class="shift-state-card shift-kpi"><small>เงินสด</small><b>${fmtMoney(pb.cash||0)}</b><span class="shift-sub">รับเงินจริงในกะนี้</span></div>
        <div class="shift-state-card shift-kpi"><small>QR / โอน</small><b>${fmtMoney((pb.qr||0)+(pb.transfer||0)+(pb.bank_transfer||0))}</b><span class="shift-sub">ไม่รวมในลิ้นชักเงินสด</span></div>
        <div class="shift-state-card shift-kpi"><small>คืนเงิน</small><b>${fmtMoney(sum.refund_total||0)}</b><span class="shift-sub">${Number(sum.refund_count||0)} รายการ</span></div>
        <div class="shift-state-card shift-kpi accent"><small>ยอดสุทธิในกะ</small><b>${fmtMoney(sum.net_received||0)}</b><span class="shift-sub">รับชำระ − คืนเงิน</span></div>
        <div class="shift-state-card shift-kpi cash-expected"><small>เงินสดที่ควรมีในลิ้นชัก</small><b>${fmtMoney(sum.expected_cash||0)}</b><span class="shift-sub">เริ่ม ${fmtMoney(sh.opening_cash)} · เข้า ${fmtMoney(sum.cash_in||0)} · ออก ${fmtMoney(sum.cash_out||0)}</span></div>
        <div class="shift-state-card"><small>พนักงาน</small><b>${escapeHtml(sh.opened_by_name||'')}</b><span class="shift-sub">กะนี้ไม่ตัดยอดตอน 00:00</span></div>`;
      actions.innerHTML=`<div class="shift-close-box"><div><b>ปิดกะ</b><div class="muted">ให้นับเงินจริงในลิ้นชักเพียงครั้งเดียว ระบบจะเทียบกับยอดที่ควรมีอัตโนมัติ</div></div><div class="shift-close-controls"><input id="shiftCountedCash" type="number" min="0" step="0.01" inputmode="decimal" placeholder="เงินสดนับจริง"><input id="shiftCloseNote" maxlength="300" placeholder="หมายเหตุ (ถ้ามี)"><button class="danger-btn" id="closeShiftBtn" type="button">ปิดกะ &amp; ตรวจยอด</button></div></div>`;
      $('#closeShiftBtn').onclick=()=>openCloseShiftConfirmation(sum);
    }else{
      status.innerHTML=`<div class="shift-state-card"><small>สถานะ</small><b>ยังไม่ได้เปิดกะ</b></div>`;
      actions.innerHTML=`<div class="shift-open-box"><div><b>เริ่มกะใหม่</b><div class="muted">กรอกเฉพาะเงินทอนที่มีอยู่จริงก่อนเริ่มขาย</div></div><div class="shift-open-controls"><input id="shiftOpeningCash" type="number" min="0" step="0.01" inputmode="decimal" placeholder="เงินทอนตั้งต้น"><input id="shiftOpenNote" maxlength="300" placeholder="หมายเหตุ (ถ้ามี)"><button class="save" id="openShiftBtn" type="button">เปิดกะ</button></div></div>`;
      $('#openShiftBtn').onclick=()=>opsPost('/api/operations/shift/open',{branch_id:currentBranchId,opening_cash:Number($('#shiftOpeningCash').value||0),notes:$('#shiftOpenNote').value});
    }
    $('#cashMovementList').innerHTML=data.movements.length?data.movements.map(m=>`<div class="list-row"><div><b>${m.movement_type==='cash_in'?'เงินเข้า':'เงินออก'}</b><div class="muted">${escapeHtml(m.reason)} · ${escapeHtml(formatDateTime(m.created_at))}</div></div><strong>${m.movement_type==='cash_in'?'+':'−'}${fmtMoney(m.amount)}</strong></div>`).join(''):emptyState('💵','ยังไม่มีรายการเงินสดในกะนี้');
    loadShiftHistory();
    if(me && ['owner','manager'].includes(me.role)){const cr=await api('/api/operations/critical');$('#criticalOpsList').innerHTML=cr.length?cr.slice(0,50).map(x=>`<div class="list-row"><div><b>${escapeHtml(x.operation_type)}</b><div class="muted">${escapeHtml(x.reason)} · ทำโดย ${escapeHtml(x.performed_by_name||'')} · อนุมัติโดย ${escapeHtml(x.approved_by_name||'')}</div></div><small>${escapeHtml(formatDateTime(x.created_at))}</small></div>`).join(''):emptyState('🛡️','ยังไม่มีรายการอนุมัติ');}
  }catch(e){toast(e.message,'err')}
}
let pendingCloseShift=null;
function openCloseShiftConfirmation(sum={}){
  const countedEl=$('#shiftCountedCash'), noteEl=$('#shiftCloseNote');
  if(!countedEl)return;
  const raw=String(countedEl.value||'').trim();
  if(raw===''){toast('กรุณานับและกรอกเงินสดจริงก่อนปิดกะ','err');countedEl.focus();return;}
  const counted=Number(raw), expected=Number(sum.expected_cash||0);
  if(!Number.isFinite(counted)||counted<0){toast('ยอดเงินสดนับจริงไม่ถูกต้อง','err');countedEl.focus();return;}
  const notes=(noteEl?.value||'').trim();
  pendingCloseShift={branch_id:currentBranchId,counted_cash:counted,notes};
  $('#shiftConfirmExpected').textContent=fmtMoney(expected);
  $('#shiftConfirmCounted').textContent=fmtMoney(counted);
  $('#shiftConfirmDiff').textContent=fmtMoney(counted-expected);
  const noteBox=$('#shiftConfirmNote'); noteBox.textContent=notes?'หมายเหตุ: '+notes:''; noteBox.classList.toggle('hidden',!notes);
  openModal('#closeShiftConfirmModal');
}
$('#confirmCloseShiftBtn').onclick=async()=>{
  if(!pendingCloseShift)return;
  const btn=$('#confirmCloseShiftBtn'), payload={...pendingCloseShift};
  btn.disabled=true; btn.textContent='กำลังปิดกะ…';
  try{closeModals();await opsPost('/api/operations/shift/close',payload);pendingCloseShift=null}
  finally{btn.disabled=false;btn.textContent='ยืนยันปิดกะ & พิมพ์'}
};

async function opsPost(url,payload){try{const r=await apiJson(url,'POST',payload);if(r.expected_cash!=null){toast(`ปิดกะแล้ว · ควรมี ${fmtMoney(r.expected_cash)} · ต่าง ${fmtMoney(r.difference)}`,'ok');await printShiftCloseReport(r);}else toast('บันทึกแล้ว','ok');$('#opsAmount').value='';$('#opsReason').value='';loadOperations();}catch(e){toast(e.message,'err')}}
async function printShiftCloseReport(sh){let rs={};try{rs=await api('/api/settings/receipt?branch_id='+encodeURIComponent(currentBranchId))}catch(e){}const b=(boot.branches||[]).find(x=>Number(x.id)===Number(currentBranchId));const sm=sh.summary||{},pb=sm.payment_breakdown||{};$('#receiptPrintArea').className='receipt-print paper-'+(rs.paper_width||'80')+' font-'+(rs.font_scale||'normal')+' head-'+(rs.header_align||'center');$('#receiptPrintArea').innerHTML=`<div class="rp-brand">${escapeHtml(rs.shop_name||((me&&me.tenant&&me.tenant.name)||'ZaabOS'))}</div><div class="rp-brand-sub">SHIFT CLOSING REPORT · สรุปปิดกะ</div><div class="rp-center">${escapeHtml(rs.branch_name||(b&&b.name)||'')}</div><div class="rp-sep"></div><div class="rp-footrow"><span>เปิดกะ</span><span>${escapeHtml(formatDateTime(sh.opened_at))}</span></div><div class="rp-footrow"><span>ปิดกะ</span><span>${escapeHtml(formatDateTime(sh.closed_at))}</span></div><div class="rp-sep"></div><div class="rp-row"><span>จำนวนบิล</span><span>${Number(sm.bill_count||0)}</span></div><div class="rp-row"><span>ยอดรับชำระ</span><span>${fmtMoney(sm.gross_received||0)}</span></div><div class="rp-row"><span>เงินสด</span><span>${fmtMoney(pb.cash||0)}</span></div><div class="rp-row"><span>QR / โอน</span><span>${fmtMoney((pb.qr||0)+(pb.bank_transfer||0)+(pb.transfer||0))}</span></div><div class="rp-row"><span>คืนเงิน</span><span>−${fmtMoney(sm.refund_total||0)}</span></div><div class="rp-total"><span>ยอดสุทธิ</span><span>${fmtMoney(sm.net_received||0)}</span></div><div class="rp-sep"></div><div class="rp-row"><span>เงินทอนตั้งต้น</span><span>${fmtMoney((sm.expected_cash||0)-(sm.cash_sales||0)-(sm.cash_in||0)+(sm.cash_out||0)+(sm.cash_refunds||0)+(sm.cash_reversals||0))}</span></div><div class="rp-row"><span>เงินเข้า</span><span>${fmtMoney(sm.cash_in||0)}</span></div><div class="rp-row"><span>เงินออก</span><span>${fmtMoney(sm.cash_out||0)}</span></div><div class="rp-row"><span>เงินสดที่ควรมี</span><span>${fmtMoney(sh.expected_cash||sm.expected_cash||0)}</span></div><div class="rp-row"><span>เงินสดนับจริง</span><span>${fmtMoney(sh.counted_cash||0)}</span></div><div class="rp-total"><span>ขาด / เกิน</span><span>${fmtMoney(sh.difference||0)}</span></div>${sh.notes?`<div class="rp-note">หมายเหตุ: ${escapeHtml(sh.notes)}</div>`:''}<div class="rp-thanks">ลงชื่อผู้ปิดกะ __________________</div><div class="rp-powered">ZaabOS</div>`;printElement($('#receiptPrintArea'));}
async function loadShiftHistory(){const el=$('#shiftHistoryList');if(!el)return;try{const rows=await api('/api/operations/shifts?branch_id='+currentBranchId);el.innerHTML=rows.length?rows.map(x=>`<div class="list-row shift-history-row"><div><b>${escapeHtml(formatDateTime(x.closed_at))}</b><div class="muted">${escapeHtml(x.opened_by_name||'')} · ${Number(x.summary?.bill_count||0)} บิล · สุทธิ ${fmtMoney(x.summary?.net_received||0)}</div></div><button class="ghost-btn" data-print-shift="${x.id}">🧾 พิมพ์</button></div>`).join(''):emptyState('🧾','ยังไม่มีประวัติกะที่ปิด');el.onclick=async e=>{const b=e.target.closest('[data-print-shift]');if(!b)return;const x=rows.find(r=>String(r.id)===String(b.dataset.printShift));if(x)await printShiftCloseReport({...x,expected_cash:x.expected_cash,counted_cash:x.counted_cash,difference:x.difference})}}catch(e){el.innerHTML=`<div class="error-text">${escapeHtml(e.message)}</div>`}}

$('#refreshOpsBtn').onclick=loadOperations;
$('#cashInBtn').onclick=()=>opsPost('/api/operations/cash-movement',{branch_id:currentBranchId,movement_type:'cash_in',amount:Number($('#opsAmount').value||0),reason:$('#opsReason').value});
$('#cashOutBtn').onclick=()=>opsPost('/api/operations/cash-movement',{branch_id:currentBranchId,movement_type:'cash_out',amount:Number($('#opsAmount').value||0),reason:$('#opsReason').value});

// Round 14D pricing / promotions
let receiptSettingsCache={};
function readReceiptSettingsForm(){return{branch_id:currentBranchId,shop_name:$('#rsShopName').value.trim(),branch_name:$('#rsBranchName').value.trim(),subtitle:$('#rsSubtitle').value.trim(),address:$('#rsAddress').value.trim(),phone:$('#rsPhone').value.trim(),tax_id:$('#rsTaxId').value.trim(),footer:$('#rsFooter').value.trim(),paper_width:$('#rsPaper').value,font_scale:$('#rsFont').value,header_align:$('#rsAlign').value,show_branch:$('#rsShowBranch').checked,show_guest:$('#rsShowGuest').checked,show_cashier:$('#rsShowCashier').checked,show_payment_breakdown:$('#rsShowPayments').checked,show_order_time:$('#rsShowOrderTime').checked,show_paid_time:$('#rsShowPaidTime').checked,receipt_printer_route:$('#rsReceiptPrinterRoute').value,kitchen_printer_route:$('#rsKitchenPrinterRoute').value,kitchen_auto_queue:$('#rsKitchenAutoQueue').checked}}
function renderReceiptSettingsPreview(){const r=readReceiptSettingsForm(),el=$('#receiptSettingsPreview');if(!el)return;el.className=`receipt-settings-preview paper-${r.paper_width} font-${r.font_scale} head-${r.header_align}`;el.innerHTML=`<div class="rp-brand">${escapeHtml(r.shop_name||'ชื่อร้าน')}</div>${r.subtitle?`<div class="rp-brand-sub">${escapeHtml(r.subtitle)}</div>`:''}${r.show_branch&&r.branch_name?`<div class="rp-center">${escapeHtml(r.branch_name)}</div>`:''}${r.address?`<div class="rp-center rp-shop-detail">${escapeHtml(r.address)}</div>`:''}${r.phone?`<div class="rp-center rp-shop-detail">${escapeHtml(r.phone)}</div>`:''}<div class="rp-sep"></div><div class="rp-meta"><span>โต๊ะ</span><b>โต๊ะ 4</b>${r.show_guest?'<span>ลูกค้า</span><b>3</b>':''}</div><table class="rp-items"><tbody><tr><td>1</td><td>เมนูตัวอย่าง</td><td class="rp-price">₭50,000</td></tr></tbody></table><div class="rp-sep"></div><div class="rp-total"><span>รวม</span><span>₭50,000</span></div>${r.show_payment_breakdown?'<div class="rp-row"><span>Cash</span><span>₭50,000</span></div>':''}<div class="rp-thanks">${escapeHtml(r.footer||'ขอบใจที่ใช้บริการ')}</div><div class="rp-powered">ZaabOS</div>`}
async function loadReceiptSettings(){if(!currentBranchId)return;try{const r=await api('/api/settings/receipt?branch_id='+currentBranchId);receiptSettingsCache=r;$('#rsShopName').value=r.shop_name||'';$('#rsBranchName').value=r.branch_name||'';$('#rsSubtitle').value=r.subtitle||'';$('#rsAddress').value=r.address||'';$('#rsPhone').value=r.phone||'';$('#rsTaxId').value=r.tax_id||'';$('#rsFooter').value=r.footer||'';$('#rsPaper').value=r.paper_width||'80';$('#rsFont').value=r.font_scale||'normal';$('#rsAlign').value=r.header_align||'center';$('#rsShowBranch').checked=r.show_branch!==false;$('#rsShowGuest').checked=r.show_guest!==false;$('#rsShowCashier').checked=r.show_cashier!==false;$('#rsShowPayments').checked=r.show_payment_breakdown!==false;$('#rsShowOrderTime').checked=r.show_order_time!==false;$('#rsShowPaidTime').checked=r.show_paid_time!==false;$('#rsReceiptPrinterRoute').value=r.receipt_printer_route||'front';$('#rsKitchenPrinterRoute').value=r.kitchen_printer_route||'kitchen';$('#rsKitchenAutoQueue').checked=r.kitchen_auto_queue!==false;renderReceiptSettingsPreview()}catch(e){toast(e.message,'err')}}
$('#tab-receiptsettings').addEventListener('input',renderReceiptSettingsPreview);$('#tab-receiptsettings').addEventListener('change',renderReceiptSettingsPreview);$('#saveReceiptSettingsBtn').onclick=async()=>{try{const r=await apiJson('/api/settings/receipt','PUT',readReceiptSettingsForm());receiptSettingsCache=r.settings||{};toast('บันทึกการตั้งค่าร้านและใบเสร็จแล้ว','ok');renderReceiptSettingsPreview()}catch(e){toast(e.message,'err')}};

async function loadPricing(){
  if(!currentBranchId) return;
  try{
    const st=await api('/api/pricing/settings?branch_id='+currentBranchId);
    $('#pricingTax').value=st.tax_rate||0; $('#pricingService').value=st.service_charge_rate||0;
    const promos=await api('/api/promotions');
    $('#promotionsList').innerHTML=promos.length?promos.map(x=>`<div class="list-card"><div><b>${escapeHtml(x.code)}</b> · ${escapeHtml(x.name)}<br><small>${x.discount_type==='percent'?x.discount_value+'%':fmtMoney(x.discount_value)} · ขั้นต่ำ ${fmtMoney(x.min_spend||0)} ${x.active?'':'· ปิดแล้ว'}</small></div>${x.active?`<button class="icon-btn danger" data-disable-promo="${x.id}">×</button>`:''}</div>`).join(''):emptyState('🏷️','ยังไม่มีโปรโมชั่น');
  }catch(e){toast(e.message,'err')}
}
$('#savePricingBtn').addEventListener('click',async()=>{try{await apiJson('/api/pricing/settings','PUT',{branch_id:currentBranchId,tax_rate:parseFloat($('#pricingTax').value)||0,service_charge_rate:parseFloat($('#pricingService').value)||0});toast('บันทึกอัตราแล้ว','ok');loadPricing()}catch(e){toast(e.message,'err')}});
$('#addPromoBtn').addEventListener('click',async()=>{try{await apiJson('/api/promotions','POST',{branch_id:currentBranchId,code:$('#promoCode').value.trim(),name:$('#promoName').value.trim(),discount_type:$('#promoType').value,discount_value:parseFloat($('#promoValue').value)||0,min_spend:parseFloat($('#promoMin').value)||0});toast('สร้างโปรโมชั่นแล้ว','ok');$('#promoCode').value='';$('#promoName').value='';loadPricing()}catch(e){toast(e.message,'err')}});
$('#promotionsList').addEventListener('click',async e=>{const b=e.target.closest('[data-disable-promo]');if(!b)return;if(!confirm('ปิดโปรโมชั่นนี้?'))return;try{await apiJson('/api/promotions/'+b.dataset.disablePromo,'DELETE');loadPricing()}catch(err){toast(err.message,'err')}});

async function loadInventory(){
  if(!currentBranchId)return;
  try{
    const rows=await api('/api/inventory/ingredients?branch_id='+currentBranchId);
    const low=rows.filter(x=>Number(x.stock_qty)<=Number(x.low_stock_threshold));
    $('#inventorySummary').innerHTML=`<div class="report-card"><small>วัตถุดิบ</small><b>${rows.length}</b></div><div class="report-card"><small>ใกล้หมด</small><b>${low.length}</b></div>`;
    $('#ingredientsList').innerHTML=rows.length?rows.map(x=>`<div class="ingredient-row ${Number(x.stock_qty)<=Number(x.low_stock_threshold)?'low':''}"><div><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.unit)} · เตือนที่ ${x.low_stock_threshold}</small></div><strong>${Number(x.stock_qty).toLocaleString()}</strong><button class="ghost-btn" data-ing-adjust="${x.id}">ปรับ</button></div>`).join(''):emptyState('📦','ยังไม่มีวัตถุดิบ');
  }catch(e){toast(e.message,'err')}
}
$('#addIngredientBtn').addEventListener('click',()=>openModal('#ingredientModal'));
$('#ingSave').addEventListener('click',async()=>{try{await apiJson('/api/inventory/ingredients','POST',{branch_id:currentBranchId,name:$('#ingName').value.trim(),unit:$('#ingUnit').value.trim()||'unit',stock_qty:Number($('#ingQty').value||0),low_stock_threshold:Number($('#ingLow').value||0),cost_per_unit:Number($('#ingCost').value||0)});closeModals();toast('เพิ่มวัตถุดิบแล้ว','ok');loadInventory()}catch(e){toast(e.message,'err')}});
$('#ingredientsList').addEventListener('click',async e=>{const b=e.target.closest('[data-ing-adjust]');if(!b)return;const q=prompt('ปรับจำนวน เช่น 10 หรือ -2');if(q===null)return;const reason=prompt('เหตุผลการปรับสต็อก');if(!reason)return;try{await apiJson(`/api/inventory/ingredients/${b.dataset.ingAdjust}/adjust`,'POST',{quantity:Number(q),reason});loadInventory()}catch(err){toast(err.message,'err')}});

// Round 17 operations
let kitchenStationsCache=[],recipeMenuId=null,recipeDraft=[];
async function fillKitchenStationSelect(){const sel=$('#menuItemKitchenStation');if(!sel||!currentBranchId)return;try{kitchenStationsCache=await api('/api/kitchen/stations?branch_id='+currentBranchId);const cur=sel.value;sel.innerHTML='<option value="">ไม่ระบุสถานี</option>'+kitchenStationsCache.map(x=>`<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');sel.value=cur||'';}catch(e){}}
async function openRecipeEditor(mid){if(!mid){toast('บันทึกเมนูก่อน แล้วจึงกำหนดสูตรวัตถุดิบ','err');return;}recipeMenuId=Number(mid);const it=boot.items.find(x=>x.id===recipeMenuId);$('#recipeMenuName').textContent=it?it.name:'';const [ings,recipe]=await Promise.all([api('/api/inventory/ingredients?branch_id='+currentBranchId),api('/api/inventory/recipes/'+recipeMenuId)]);window._recipeIngredients=ings;recipeDraft=recipe.map(x=>({ingredient_id:x.ingredient_id,quantity:Number(x.quantity)}));renderRecipeRows();openModal('#recipeModal');}
function renderRecipeRows(){const ings=window._recipeIngredients||[];$('#recipeRows').innerHTML=recipeDraft.map((r,i)=>`<div class="recipe-row"><select data-recipe-ing="${i}">${ings.map(x=>`<option value="${x.id}" ${Number(x.id)===Number(r.ingredient_id)?'selected':''}>${escapeHtml(x.name)} (${escapeHtml(x.unit)})</option>`).join('')}</select><input data-recipe-qty="${i}" type="number" min="0.0001" step="0.01" value="${r.quantity}"><button class="icon-btn danger" data-recipe-del="${i}">×</button></div>`).join('')||'<div class="muted">ยังไม่มีสูตร</div>';}
$('#menuItemRecipeBtn').addEventListener('click',()=>openRecipeEditor($('#menuItemId').value));
$('#recipeAddRow').addEventListener('click',()=>{const a=window._recipeIngredients||[];if(!a.length){toast('เพิ่มวัตถุดิบก่อน','err');return;}recipeDraft.push({ingredient_id:a[0].id,quantity:1});renderRecipeRows();});
$('#recipeRows').addEventListener('input',e=>{let i=e.target.dataset.recipeIng;if(i!==undefined)recipeDraft[+i].ingredient_id=Number(e.target.value);i=e.target.dataset.recipeQty;if(i!==undefined)recipeDraft[+i].quantity=Number(e.target.value||0);});
$('#recipeRows').addEventListener('click',e=>{const i=e.target.dataset.recipeDel;if(i!==undefined){recipeDraft.splice(+i,1);renderRecipeRows();}});
$('#recipeSave').addEventListener('click',async()=>{try{await apiJson('/api/inventory/recipes/'+recipeMenuId,'PUT',{items:recipeDraft});closeModals();toast('บันทึกสูตรแล้ว','ok')}catch(e){toast(e.message,'err')}});
$('#manageStationsBtn').addEventListener('click',async()=>{await loadStationsManager();openModal('#stationsModal')});
async function loadStationsManager(){kitchenStationsCache=await api('/api/kitchen/stations?branch_id='+currentBranchId);$('#stationsList').innerHTML=kitchenStationsCache.map(x=>`<div class="row"><b>${escapeHtml(x.name)}</b><button class="ghost-btn" data-station-off="${x.id}">ปิดใช้งาน</button></div>`).join('')||'<div class="muted">ยังไม่มีสถานีครัว</div>';}
$('#stationAdd').addEventListener('click',async()=>{const name=$('#newStationName').value.trim();if(!name)return;try{await apiJson('/api/kitchen/stations','POST',{branch_id:currentBranchId,name});$('#newStationName').value='';await loadStationsManager();await fillKitchenStationSelect()}catch(e){toast(e.message,'err')}});
$('#stationsList').addEventListener('click',async e=>{const b=e.target.closest('[data-station-off]');if(!b)return;try{await apiJson('/api/kitchen/stations/'+b.dataset.stationOff,'PUT',{active:false});await loadStationsManager();await fillKitchenStationSelect()}catch(err){toast(err.message,'err')}});
$('#inventoryHistoryBtn').addEventListener('click',async()=>{const box=$('#inventoryHistory');box.classList.toggle('hidden');if(box.classList.contains('hidden'))return;try{const rows=await api('/api/inventory/movements?branch_id='+currentBranchId+'&limit=100');box.innerHTML='<h3>ประวัติสต็อกล่าสุด</h3>'+rows.map(x=>`<div class="inventory-history-row"><div><b>${escapeHtml(x.ingredient_name)}</b><small>${escapeHtml(x.movement_type)} · ${escapeHtml(x.reason||'')}</small></div><strong>${Number(x.quantity)>0?'+':''}${Number(x.quantity).toLocaleString()} ${escapeHtml(x.unit)}</strong></div>`).join('')||'<div class="muted">ยังไม่มีประวัติ</div>';}catch(e){toast(e.message,'err')}});
const _r17LoadInventory=loadInventory;
loadInventory=async function(){await _r17LoadInventory();const rows=await api('/api/inventory/ingredients?branch_id='+currentBranchId);$('#ingredientsList').innerHTML=rows.length?rows.map(x=>`<div class="ingredient-row ${Number(x.stock_qty)<=Number(x.low_stock_threshold)?'low':''}"><div><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.unit)} · เตือนที่ ${x.low_stock_threshold}</small></div><strong>${Number(x.stock_qty).toLocaleString()}</strong><div class="ingredient-actions"><button class="ghost-btn" data-ing-adjust="${x.id}">ปรับ</button><button class="ghost-btn" data-ing-waste="${x.id}">ของเสีย</button><button class="ghost-btn" data-ing-count="${x.id}">ตรวจนับ</button></div></div>`).join(''):emptyState('📦','ยังไม่มีวัตถุดิบ');};
$('#ingredientsList').addEventListener('click',async e=>{const w=e.target.closest('[data-ing-waste]');if(w){const q=prompt('จำนวนวัตถุดิบที่เสีย/ทิ้ง');if(q===null)return;const reason=prompt('สาเหตุของเสีย');if(!reason)return;try{await apiJson(`/api/inventory/ingredients/${w.dataset.ingWaste}/waste`,'POST',{quantity:Number(q),reason});toast('บันทึกของเสียแล้ว','ok');loadInventory()}catch(err){toast(err.message,'err')}return;}const c=e.target.closest('[data-ing-count]');if(c){const q=prompt('จำนวนที่ตรวจนับได้จริง');if(q===null)return;const note=prompt('หมายเหตุการตรวจนับ (ถ้ามี)')||'';try{const r=await apiJson(`/api/inventory/ingredients/${c.dataset.ingCount}/count`,'POST',{counted_qty:Number(q),note});toast(`ตรวจนับแล้ว · ต่าง ${Number(r.difference).toLocaleString()}`,'ok');loadInventory()}catch(err){toast(err.message,'err')}}});

// Round 20 sync lifecycle
window.addEventListener('online',async()=>{zaabosOfflineMode=false;try{me=await api('/api/me',{silent:true});await loadBootstrap();renderBranchSelect();await syncOfflineOrders();toast('เชื่อมต่อแล้ว · Sync ออเดอร์เรียบร้อย','ok');}catch(e){}});
window.addEventListener('offline',()=>{zaabosOfflineMode=true;renderOfflineQueue();});
setInterval(()=>{if(navigator.onLine)syncOfflineOrders();},10000);
const offlineSyncBtn=$('#offlineSyncBtn');if(offlineSyncBtn)offlineSyncBtn.addEventListener('click',syncOfflineOrders);

const offlineQueueList=$('#offlineQueueList');
if(offlineQueueList)offlineQueueList.addEventListener('click',async e=>{
  const retry=e.target.closest('[data-offline-retry]');
  if(retry){const rec=await offlineGet('outbox',retry.dataset.offlineRetry);if(rec){rec.status='pending';rec.last_error='';await offlinePut('outbox',undefined,rec);await renderOfflineQueue();syncOfflineOrders();}return;}
  const rem=e.target.closest('[data-offline-remove]');
  if(rem&&confirm('ลบออเดอร์นี้ออกจากคิวออฟไลน์? ข้อมูลรายการนี้จะไม่ถูกส่งขึ้น Server')){await offlineDelete('outbox',rem.dataset.offlineRemove);await renderOfflineQueue();}
});

