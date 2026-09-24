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
let printFailures = 0; // failed print jobs on this branch (header printer badge + notifications)
let customerOrdersCache = []; // orders opened from the Customers page, so bill actions can find them

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
  box.classList.toggle('hidden',!rows.length);$('#offlineQueueSummary').textContent=t('offline_queue_count').replace('{n}', rows.length);
  $('#offlineQueueList').innerHTML=rows.map(x=>`<div class="offline-queue-row"><span>${x.payload.order_type==='dine_in'?t('offline_table_prefix')+' '+escapeHtml((boot.tables.find(t=>t.id===x.payload.table_id)||{}).name||''):escapeHtml(orderTypeLabel(x.payload.order_type))}</span><b>${x.status==='conflict'?t('offline_conflict'):t('offline_pending')}</b>${x.last_error?`<small>${escapeHtml(x.last_error)}</small>`:''}<div class="offline-queue-actions">${x.status==='conflict'?`<button class="ghost-btn" data-offline-retry="${x.client_request_id}">${t('offline_retry')}</button>`:''}<button class="ghost-btn danger" data-offline-remove="${x.client_request_id}">${t('offline_remove')}</button></div></div>`).join('');
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

// A toast with one button (e.g. เลิกทำ) that stays a little longer.
function toastAction(msg, label, fn) {
  const el = document.createElement('div');
  el.className = 'toast ok toast-action';
  el.innerHTML = `<span>${escapeHtml(msg)}</span><button type="button">${escapeHtml(label)}</button>`;
  el.querySelector('button').addEventListener('click', () => { el.remove(); fn(); });
  $('#toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 6000);
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
    if (!silent) toast(t('err_network_check'),'err');
    const err=new Error(t('err_server_unreachable')); err.status=0; err.transient=true; throw err;
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
    const fallback = r.status >= 500 ? t('err_save_server') : t('err_generic');
    const err=new Error((body && body.error) || fallback); err.status=r.status; err.code=body&&body.code; err.transient=(r.status>=500||r.status===408||r.status===429); throw err;
  }
  return body;
}
function apiJson(url, method, data) {
  return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
}

function openModal(sel) { $(sel).classList.add('show'); }
function closeModals() { $$('.modal').forEach(m => m.classList.remove('show')); }
// × or a tap on the dimmed backdrop closes that sheet only (an option picker over the order workspace
// must not throw away the order being taken).
document.addEventListener('click', (e) => {
  const x = e.target.closest('[data-close]');
  if (x) { const m = x.closest('.modal'); if (m && m.id === 'takeOrderModal' && guardTakeOrderLeave()) return; if (m) m.classList.remove('show'); else closeModals(); }
  else if (e.target.classList.contains('modal') && !e.target.classList.contains('workspace')) e.target.classList.remove('show');
});

// ===================== i18n wiring =====================

initLangSwitcher('#langSelect');
initLangSwitcher('#loginLangSelect');
applyI18n();
onLangChange(() => {
  applyI18n();
  if (me) {
    $('#whoRole').textContent = t('role_' + me.role) || me.role;
    $('#navUserRole').textContent = $('#whoRole').textContent;
    buildMoreMenu();
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
  $('#navUserAvatar').textContent = $('#whoAvatar').textContent;
  $('#navUserName').textContent = me.display_name || me.username;
  $('#navUserRole').textContent = t('role_' + me.role) || me.role;

  if (me.role === 'super_admin') {
    $('#tenantSwitcher').classList.remove('hidden');
    $('#tenantsTabBtn').classList.remove('hidden');
    const sel = $('#tenantSwitcher');
    sel.innerHTML = `<option value="all">${escapeHtml(t('tenant_switcher_all'))}</option>` + (me.tenants || []).map(t2 => `<option value="${t2.id}">${escapeHtml(iconText(t2.icon))} ${escapeHtml(t2.name)}</option>`).join('');
    sel.value = me.tenant_id ? String(me.tenant_id) : 'all';
    sel.onchange = async () => {
      await apiJson('/api/switch-tenant', 'POST', { tenant_id: sel.value === 'all' ? 'all' : parseInt(sel.value, 10) });
      location.reload();
    };
  }

  applyRoleVisibility();
  buildMoreMenu();

  if (me.must_change_password) openModal('#pwModal');

  await loadBootstrap();
  renderBranchSelect();
  switchTab(['owner', 'manager', 'super_admin'].includes(me.role) ? 'dashboard' : 'orders');
  refreshPosShiftBadge(); refreshPrintStatus();

  if (ordersPollTimer) clearInterval(ordersPollTimer);
  ordersPollTimer = setInterval(() => { if (me) loadBoardData(); }, 8000);
}

function applyRoleVisibility() {
  const isOwner = me.role === 'owner' || me.role === 'super_admin';
  const isManagerPlus = isOwner || me.role === 'manager';
  $$('.tabs button[data-tab="branches"], .tabs button[data-tab="users"]').forEach(b => {
    b.classList.toggle('hidden', !isOwner);
  });
  $$('.tabs button[data-tab="reports"], .tabs button[data-tab="pricing"], .tabs button[data-tab="inventory"], .tabs button[data-tab="dashboard"]').forEach(b => b.classList.toggle('hidden', !isManagerPlus));
  $$('#settingsList [data-need]').forEach(b => b.classList.toggle('hidden', b.dataset.need === 'owner' ? !isOwner : !isManagerPlus));
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
  sel.innerHTML = boot.branches.map(b => `<option value="${b.id}">${escapeHtml(iconText(b.icon))} ${escapeHtml(b.name)}</option>`).join('');
  if (currentBranchId) sel.value = String(currentBranchId);
  sel.onchange = () => { currentBranchId = parseInt(sel.value, 10); refreshCurrentTab(); };
  $('#branchScopeBar').classList.toggle('hidden', boot.branches.length <= 1);
}

function branchTables() { return boot.tables.filter(t => t.branch_id === currentBranchId); }
function branchCategories() { return boot.categories.filter(c => c.branch_id === currentBranchId); }
function branchItems() { return boot.items.filter(i => i.branch_id === currentBranchId); }

// ===================== Tabs =====================

// Sub-pages reached from Settings keep "ตั้งค่า" highlighted in the sidebar.
const NAV_PARENT = { tables: 'settings', pricing: 'settings', receiptsettings: 'settings', branches: 'settings', inventory: 'settings' };
let currentTab = 'orders';
function setNavActive(tab) {
  const navTab = NAV_PARENT[tab] || tab;
  $$('#mainTabs button[data-tab], #moreNavMenu button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === navTab));
  const more = $('#moreNavBtn');
  if (more) more.classList.toggle('active', !!$('#moreNavMenu button.active'));
}
function closeMoreMenu() { $('#moreNavMenu').classList.add('hidden'); $('#moreNavBtn').setAttribute('aria-expanded', 'false'); }
function navigate(tab, anchor) {
  closeMoreMenu();
  if (guardTakeOrderLeave(() => navigate(tab, anchor))) return;
  if (tab === 'takeorder') { openTakeOrderForTable(); return; }
  closeModals();
  switchTab(tab);
  if (anchor) setTimeout(() => { const el = document.getElementById(anchor); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 250);
}
$('#mainTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) navigate(btn.dataset.tab);
});
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto-tab]');
  if (go) navigate(go.dataset.gotoTab, go.dataset.gotoAnchor);
});
$('#moreNavBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#moreNavMenu'); const open = menu.classList.toggle('hidden');
  $('#moreNavBtn').setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => { if (!e.target.closest('.nav-more-wrap')) closeMoreMenu(); });
// Phones show 5 tabs at the bottom; everything else goes into "เพิ่มเติม".
function buildMoreMenu() {
  $('#moreNavMenu').innerHTML = $$('#mainTabs .nav-list > button[data-tab]').filter(b => !b.classList.contains('nav-phone') && !b.classList.contains('hidden'))
    .map(b => `<button type="button" data-tab="${b.dataset.tab}">${b.querySelector('.tab-ic').outerHTML}<span class="tab-lb">${escapeHtml(b.querySelector('.tab-lb').textContent)}</span></button>`).join('');
  setNavActive(currentTab);
}

function switchTab(tab) {
  if (!$('#tab-' + tab)) tab = 'orders';
  currentTab = tab;
  setNavActive(tab);
  $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + tab));
  if (tab !== 'kitchen') unloadKitchenFrame();
  window.scrollTo(0, 0);
  refreshCurrentTab(tab);
}
function activeTab() { return currentTab; }
function refreshCurrentTab(tab) {
  if (!me) return;
  tab = tab || activeTab();
  if (tab === 'orders') { loadBoardData(); }
  else if (tab === 'dashboard') loadDashboard();
  else if (tab === 'kitchen') loadKitchenFrame();
  else if (tab === 'billing') loadBoardData();
  else if (tab === 'customers') loadCustomers();
  else if (tab === 'settings') renderSettingsHub();
  else if (tab === 'history') loadOrders();
  else if (tab === 'tables') renderTables();
  else if (tab === 'menu') loadBootstrap().then(renderMenu); // re-fetch so stock counts (which change from orders placed elsewhere — staff or customer QR) are current whenever this tab is opened
  else if (tab === 'pricing') loadPricing();
  else if (tab === 'inventory') loadInventory();
  else if (tab === 'operations') loadOperations();
  else if (tab === 'receiptsettings') { loadReceiptSettings(); loadNetPrinters(); loadLocalPanel(); }
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

// Business dates are restaurant-local (Lao) dates. toISOString() gives the UTC date, which is
// still "yesterday" between 00:00 and 07:00 in Vientiane and made the report look empty.
function isoDate(d) { return new Intl.DateTimeFormat('en-CA', {timeZone: ZAABOS_RESTAURANT_TZ, year: 'numeric', month: '2-digit', day: '2-digit'}).format(d); }
// Shops that sell past midnight start the sales day later (Settings → วันขาย): a 02:00 bill still belongs to last night.
function dayCutoffHour() { const m = (boot && boot.day_cutoff) || {}; return Math.max(0, Math.min(6, Number(m[String(currentBranchId)] || 0) || 0)); }
function businessNow() { return new Date(new Date().getTime() - dayCutoffHour() * 3600000); }
function businessToday() { return isoDate(businessNow()); }
function presetRange(preset) {
  const [y, m, dt] = businessToday().split('-').map(Number);
  const day = (Y, M, D) => new Date(Date.UTC(Y, M - 1, D)).toISOString().slice(0, 10);
  const today = day(y, m, dt);
  if (preset === 'yesterday') { const d = day(y, m, dt - 1); return [d, d]; }
  if (preset === '7d') return [day(y, m, dt - 6), today];
  if (preset === 'month') return [day(y, m, 1), today];
  if (preset === 'year') return [day(y, 1, 1), today];
  return [today, today];
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
  const pb=$('#paymentBreakdown'); if(pb) pb.innerHTML=(s.payment_breakdown||[]).length ? s.payment_breakdown.map(x=>`<div class="report-card"><div class="rc-label">${labels[x.payment_method]||escapeHtml(x.payment_method)}</div><div class="rc-value">${fmtMoney(x.total)}</div><div class="hint">${x.count} รายการ</div></div>`).join('') : emptyState('<i class="ic ic-credit-card" aria-hidden="true"></i>','ยังไม่มีรายการชำระเงิน');
  renderCancellationReport(s.cancellations||{});
  renderShiftReport(s.shifts||[]);
  if($('#reportHourly'))$('#reportHourly').innerHTML=hourChartHtml(s.hourly||[],null);
}
function renderShiftReport(rows){const el=$('#shiftReport');if(!el)return;
  if(!rows.length){el.innerHTML=emptyState('','ยังไม่มีกะในช่วงวันที่เลือก');return}
  el.innerHTML=rows.map(x=>{const sm=x.summary||{},open=x.status==='open';
    const diff=open?'':`<span class="${Number(x.difference||0)===0?'':'error-text'}">ส่วนต่าง ${fmtMoney(x.difference||0)}</span>`;
    return `<div class="list-row shift-history-row"><div><b>${escapeHtml(x.opened_by_name||'')} · ${escapeHtml(formatDateTime(x.opened_at))} <i class="ic ic-arrow-right" aria-hidden="true"></i> ${open?'<span class="pill">กำลังเปิด</span>':escapeHtml(formatDateTime(x.closed_at))}</b>
      <div class="muted">${Number(sm.bill_count||0)} บิล · รับเงินสุทธิ ${fmtMoney(sm.net_received||0)} · เงินสดควรมี ${fmtMoney(open?sm.expected_cash:x.expected_cash)}${open?'':' · นับจริง '+fmtMoney(x.counted_cash||0)} ${diff}</div></div>
      ${open?'':`<button class="ghost-btn" data-report-print-shift="${x.id}"><i class="ic ic-receipt" aria-hidden="true"></i> พิมพ์ซ้ำ</button>`}</div>`}).join('');
  el.onclick=async e=>{const b=e.target.closest('[data-report-print-shift]');if(!b)return;const x=rows.find(r=>String(r.id)===String(b.dataset.reportPrintShift));if(x)await printShiftCloseReport({...x})};
}
function renderCancellationReport(c){const el=$('#cancellationReport');if(!el)return;const reasons=c.reasons||[],recent=c.recent||[];if(!(c.total||0)){el.innerHTML=emptyState('<i class="ic ic-circle-check" aria-hidden="true"></i>','ช่วงนี้ไม่มีการยกเลิก');return;}el.innerHTML=`<div class="cancel-summary-cards"><div><b>${c.total}</b><span>เหตุการณ์ยกเลิก</span></div><div><b>${c.order_count}</b><span>ยกเลิกทั้งบิล</span></div><div><b>${c.item_count}</b><span>ยกเลิกรายการ</span></div></div><div class="cancel-reason-list">${reasons.map((x,i)=>`<div class="cancel-reason-row"><span>${i+1}</span><div><b>${escapeHtml(x.reason)}</b><small>${x.order_count} บิล · ${x.item_count} รายการ</small></div><strong>${x.count}</strong></div>`).join('')}</div><details class="cancel-audit"><summary>ดูรายการล่าสุด</summary>${recent.map(x=>`<div class="cancel-audit-row"><span>${x.operation_type==='cancel_order'?'ทั้งบิล':'รายการ'}</span><b>${escapeHtml(x.reason_text||'ไม่ระบุเหตุผล')}</b><small>${escapeHtml(x.performed_by_name||'-')} · ${formatDateTime(x.created_at)}</small></div>`).join('')}</details>`;}

function renderTopItems(items) {
  const el = $('#reportTopItems');
  if (!items || !items.length) { el.innerHTML = emptyState('', t('label_no_data')); return; }
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
  if (!expenses || !expenses.length) { el.innerHTML = emptyState('', t('label_no_data')); return; }
  el.innerHTML = expenses.map(ex => `
    <div class="row">
      <div>
        <div style="font-weight:700">${escapeHtml(ex.category)} · ${fmtMoney(ex.amount)}</div>
        <div class="hint">${escapeHtml(ex.expense_date)}${ex.created_by_name ? ' · ' + escapeHtml(ex.created_by_name) : ''}${ex.note ? ' · ' + escapeHtml(ex.note) : ''}</div>
      </div>
      <div class="row-right"><button class="icon-btn danger" data-del-expense="${ex.id}"><i class="ic ic-trash-2" aria-hidden="true"></i></button></div>
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
  $('#expenseDate').value = businessToday();
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
      category, amount, expense_date: $('#expenseDate').value || businessToday(),
      note: $('#expenseNote').value.trim(), branch_id: currentBranchId,
    });
    closeModals(); toast(t('toast_saved'), 'ok'); loadReports();
  } catch (e) { $('#expenseError').textContent = e.message; }
});

// ===================== Branches =====================

function renderBranches() {
  const list = $('#branchesList');
  if (!boot.branches.length) { list.innerHTML = emptyState('', t('empty_branches')); return; }
  list.innerHTML = boot.branches.map(b => `
    <div class="row">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="avatar-badge">${iconHtml(b.icon,'house')}</span>
        <div><div style="font-weight:700">${escapeHtml(b.name)}</div><small>${escapeHtml(t('label_branch_code_prefix'))} #${b.id}</small></div>
      </div>
      <div class="row-right">
        <button class="icon-btn" data-edit-branch="${b.id}"><i class="ic ic-pencil" aria-hidden="true"></i></button>
        <button class="icon-btn danger" data-del-branch="${b.id}"><i class="ic ic-trash-2" aria-hidden="true"></i></button>
      </div>
    </div>`).join('');
}
$('#addBranchBtn').addEventListener('click', () => {
  $('#branchModalTitle').textContent = t('modal_add_branch_title'); $('#branchId').value = ''; $('#branchIcon').value = 'store'; $('#branchName').value = ''; $('#branchError').textContent = '';
  openModal('#branchModal');
});
$('#branchesList').addEventListener('click', (e) => {
  const editId = e.target.dataset.editBranch, delId = e.target.dataset.delBranch;
  if (editId) {
    const b = boot.branches.find(x => x.id === parseInt(editId, 10));
    $('#branchModalTitle').textContent = t('modal_edit_branch_title'); $('#branchId').value = b.id; $('#branchIcon').value = ICON_NAME_RE.test(b.icon||'') ? b.icon : 'store'; $('#branchName').value = b.name; $('#branchError').textContent = '';
    openModal('#branchModal');
  } else if (delId) {
    if (!confirm(t('confirm_delete_branch'))) return;
    apiJson('/api/branches/' + delId, 'DELETE').then(async () => { await loadBootstrap(); renderBranchSelect(); renderBranches(); toast(t('toast_deleted'), 'ok'); }).catch(e => toast(e.message, 'err'));
  }
});
$('#branchSave').addEventListener('click', async () => {
  $('#branchError').textContent = '';
  const id = $('#branchId').value, name = $('#branchName').value.trim(), icon = $('#branchIcon').value.trim() || 'store';
  if (!name) { $('#branchError').textContent = t('err_branch_name_required'); return; }
  try {
    if (id) await apiJson('/api/branches/' + id, 'PUT', { name, icon });
    else await apiJson('/api/branches', 'POST', { name, icon });
    closeModals(); await loadBootstrap(); renderBranchSelect(); renderBranches(); toast(t('toast_saved'), 'ok');
  } catch (e) { $('#branchError').textContent = e.message; }
});

// ===================== Tables & QR =====================

function tableOrderUrl(token) { return ((boot && boot.public_url) || location.origin) + '/order/' + token; }

function renderTables() {
  const grid = $('#tableGrid');
  const tables = branchTables();
  if (!tables.length) { grid.innerHTML = emptyState('', t('empty_tables')); return; }
  fillZoneOptions();
  grid.innerHTML = tables.map(t => `
    <div class="table-chip">
      <div class="tc-name"><i class="ic ic-table-2" aria-hidden="true"></i>${escapeHtml(t.name)}${t.zone ? `<span class="tc-zone">${escapeHtml(t.zone)}</span>` : ''}</div>
      <div class="tc-actions">
        <button class="tc-qr" data-qr="${t.id}"><i class="ic ic-qr-code" aria-hidden="true"></i> QR</button>
        <button data-edit-table="${t.id}" title="แก้ไข" aria-label="แก้ไข"><i class="ic ic-pencil" aria-hidden="true"></i></button>
        <button class="tc-del" data-del-table="${t.id}" title="ลบ" aria-label="ลบ"><i class="ic ic-trash-2" aria-hidden="true"></i></button>
      </div>
    </div>`).join('');
}
$('#addTableBtn').addEventListener('click', () => {
  $('#tableModalTitle').textContent = t('modal_add_table_title'); $('#tableId').value = ''; $('#tableName').value = ''; $('#tableZone').value = floorZone || ''; $('#tableError').textContent = '';
  openModal('#tableModal');
});
$('#tableSave').addEventListener('click', async () => {
  $('#tableError').textContent = '';
  const id = $('#tableId').value, name = $('#tableName').value.trim(), zone = $('#tableZone').value.trim();
  if (!name) { $('#tableError').textContent = t('err_table_name_required'); return; }
  try {
    if (id) await apiJson('/api/tables/' + id, 'PUT', { name, zone });
    else await apiJson('/api/tables', 'POST', { name, zone, branch_id: currentBranchId });
    closeModals(); await loadBootstrap(); renderTables(); toast(t('toast_saved'), 'ok');
  } catch (e) { $('#tableError').textContent = e.message; }
});
$('#bulkAddTablesBtn').addEventListener('click', () => { $('#bulkTableError').textContent = ''; $('#bulkTableCount').value = 10; $('#bulkTablePrefix').value = ''; $('#bulkTableZone').value = ''; fillZoneOptions(); openModal('#bulkTableModal'); });
$('#bulkTableSave').addEventListener('click', async () => {
  $('#bulkTableError').textContent = '';
  const count = parseInt($('#bulkTableCount').value, 10);
  try {
    const r = await apiJson('/api/tables/bulk', 'POST', { branch_id: currentBranchId, count, prefix: $('#bulkTablePrefix').value.trim(), zone: $('#bulkTableZone').value.trim() });
    closeModals(); await loadBootstrap(); renderTables(); toast(t('toast_tables_created', { n: r.created }), 'ok');
  } catch (e) { $('#bulkTableError').textContent = e.message; }
});
function branchZones() { return [...new Set(branchTables().map(t => (t.zone || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); }
function fillZoneOptions() { const dl = $('#zoneOptions'); if (dl) dl.innerHTML = branchZones().map(z => `<option value="${escapeHtml(z)}">`).join(''); }
$('#tableGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-qr],[data-edit-table],[data-del-table]'); if (!b) return;
  const qrId = b.dataset.qr, editId = b.dataset.editTable, delId = b.dataset.delTable;
  if (qrId) showTableQr(parseInt(qrId, 10));
  else if (editId) {
    const tb = boot.tables.find(x => x.id === parseInt(editId, 10));
    $('#tableModalTitle').textContent = t('modal_edit_table_title'); $('#tableId').value = tb.id; $('#tableName').value = tb.name; $('#tableZone').value = tb.zone || ''; $('#tableError').textContent = ''; fillZoneOptions();
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
  if (!cats.length) { list.innerHTML = emptyState('', t('empty_categories')); return; }
  list.innerHTML = cats.map((c,i) => {
    const count=branchItems().filter(x=>Number(x.category_id)===Number(c.id)).length;
    const active=Number(selectedMenuCategoryId)===Number(c.id);
    return `<div class="menu-category-row ${active?'active':''}" data-select-cat="${c.id}">
      <button class="menu-category-main" type="button" data-select-cat="${c.id}">
        <span class="menu-category-icon">${iconHtml(c.icon,'soup')}</span>
        <span class="menu-category-copy"><b>${escapeHtml(c.name)}</b><small>${count} รายการ</small></span>
      </button>
      <div class="menu-category-tools">
        <button class="icon-btn" data-edit-cat="${c.id}" title="แก้ไข"><i class="ic ic-pencil" aria-hidden="true"></i></button>
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
    $('#categoryModalTitle').textContent = t('modal_edit_category_title'); $('#categoryId').value = c.id; $('#categoryIcon').value = ICON_NAME_RE.test(c.icon||'') ? c.icon : 'utensils'; $('#categoryName').value = c.name; $('#categoryError').textContent = '';
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
  $('#categoryModalTitle').textContent = t('modal_add_category_title'); $('#categoryId').value = ''; $('#categoryIcon').value = 'utensils'; $('#categoryName').value = ''; $('#categoryError').textContent = '';
  openModal('#categoryModal');
});
$('#categorySave').addEventListener('click', async () => {
  $('#categoryError').textContent = '';
  const id = $('#categoryId').value, name = $('#categoryName').value.trim(), icon = $('#categoryIcon').value.trim() || 'utensils';
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
  if(title) title.textContent=cat ? `${iconText(cat.icon)} ${cat.name}`.trim(): 'เมนูทั้งหมด';
  if(count) count.textContent=`${items.length} รายการ`;
  if (!items.length) { grid.innerHTML = emptyState('', cat ? 'ยังไม่มีรายการในหมวดหมู่นี้': t('empty_menu_items')); return; }
  grid.innerHTML = items.map(it => {
    const low = it.track_stock && it.stock_qty != null && it.stock_qty <= it.low_stock_threshold;
    return `<article class="menu-card menu-manager-card ${it.sold_out ? 'sold-out' : ''}">
      <div class="menu-card-media">${it.image_url ? `<img class="mc-photo" src="${it.image_url}" alt="${escapeHtml(it.name)}">`: `<div class="menu-photo-placeholder"></div>`}
      ${it.sold_out ? `<span class="mc-badge">${escapeHtml(t('badge_sold_out'))}</span>` : (low ? `<span class="mc-badge-stock">${escapeHtml(it.stock_qty <= 0 ? t('badge_out_of_stock') : t('badge_low_stock'))}</span>` : '')}</div>
      <div class="menu-card-body">
        <div class="mc-top"><span class="mc-name">${escapeHtml(it.name)}</span><strong class="mc-price">${fmtMoney(it.base_price)}</strong></div>
        ${it.description ? `<div class="mc-desc">${escapeHtml(it.description)}</div>` : ''}
        <div class="menu-card-meta">${it.option_groups.length ? `<span>ตัวเลือก ${it.option_groups.length}</span>` : ''}${it.track_stock ? `<span><i class="ic ic-package" aria-hidden="true"></i> ${it.stock_qty != null ? it.stock_qty : 0}</span>` : ''}</div>
        <div class="mc-actions">
          <button class="ghost-btn" data-edit-item="${it.id}">${escapeHtml(t('btn_edit'))}</button>
          ${it.track_stock ? `<button class="ghost-btn" data-adjust-stock="${it.id}">${escapeHtml(t('btn_adjust_stock'))}</button>` : ''}
          <button class="ghost-btn" data-toggle-soldout="${it.id}">${escapeHtml(it.sold_out ? t('btn_mark_available') : t('btn_mark_sold_out'))}</button>
          <button class="icon-btn danger" data-del-item="${it.id}"><i class="ic ic-trash-2" aria-hidden="true"></i></button>
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
    $('#menuItemName').value = it.name; setNameI18n(it.name_i18n);
    $('#menuItemDesc').value = it.description || '';
    $('#menuItemCategory').value = it.category_id || '';
    $('#menuItemPrice').value = it.base_price;
    $('#menuItemSoldOut').checked = !!it.sold_out; $('#menuItemOpenPrice').checked = !!it.open_price;
    $('#menuItemCostPrice').value = it.cost_price || 0;
    $('#menuItemTrackStock').checked = !!it.track_stock;
    $('#menuItemStockQty').value = it.stock_qty != null ? it.stock_qty : '';
    $('#menuItemLowStockThreshold').value = it.low_stock_threshold != null ? it.low_stock_threshold : 5;
    $('#menuItemKitchenStation').value = it.kitchen_station_id || '';
    optGroupsDraft = JSON.parse(JSON.stringify(it.option_groups || []));
    menuItemImageDraft = it.image_url || null;
  } else {
    $('#menuItemModalTitle').textContent = t('modal_add_menu_item_title');
    $('#menuItemId').value = ''; $('#menuItemName').value = ''; $('#menuItemDesc').value = ''; setNameI18n('{}');
    $('#menuItemCategory').value = ''; $('#menuItemPrice').value = ''; $('#menuItemSoldOut').checked = false; $('#menuItemOpenPrice').checked = false;
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
        <button type="button" data-og-del="${gi}" class="icon-btn danger"><i class="ic ic-trash-2" aria-hidden="true"></i></button>
      </div>
      ${(g.options || []).map((o, oi) => `
        <div class="opt-row" data-oi="${oi}">
          <input placeholder="${escapeHtml(t('placeholder_option_name'))}" value="${escapeHtml(o.name || '')}" data-opt-name="${gi}:${oi}">
          <input type="number" step="0.01" placeholder="${escapeHtml(t('placeholder_option_price'))}" value="${o.price_delta || 0}" data-opt-delta="${gi}:${oi}">
          <button type="button" data-opt-del="${gi}:${oi}" class="icon-btn danger"><i class="ic ic-x" aria-hidden="true"></i></button>
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
  const openPrice = $('#menuItemOpenPrice').checked;
  const price = openPrice && $('#menuItemPrice').value.trim() === '' ? 0 : parseFloat($('#menuItemPrice').value);
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
  const payload = { name_i18n: readNameI18n(),
    name, description: $('#menuItemDesc').value.trim(), category_id: $('#menuItemCategory').value || null,
    base_price: price, sold_out: $('#menuItemSoldOut').checked, open_price: openPrice, option_groups: optGroupsDraft,
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
  if (!users.length) { list.innerHTML = emptyState('', t('empty_users')); return; }
  list.innerHTML = users.map(u => `
    <div class="row">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="avatar-badge">${escapeHtml((u.display_name || u.username || '?').slice(0, 1).toUpperCase())}</span>
        <div><div style="font-weight:700">${escapeHtml(u.display_name)} ${u.active ? '' : `<small>${escapeHtml(t('label_inactive_suffix'))}</small>`}</div><small>@${escapeHtml(u.username)} · ${escapeHtml(t('role_' + u.role) || u.role)}</small></div>
      </div>
      <div class="row-right">
        <button class="icon-btn" data-edit-user="${u.id}"><i class="ic ic-pencil" aria-hidden="true"></i></button>
        <button class="icon-btn danger" data-del-user="${u.id}"><i class="ic ic-trash-2" aria-hidden="true"></i></button>
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
function renderTenants(){const list=$('#tenantsList'),q=($('#tenantSearch').value||'').toLowerCase(),f=$('#tenantStatusFilter').value;const rows=tenantRows.filter(tn=>{const attention=!tn.active||['past_due','suspended','expired','canceled'].includes(tn.subscription_status);return(!q||tn.name.toLowerCase().includes(q))&&(!f||(f==='attention'?attention:tn.subscription_status===f))});if(!rows.length){list.innerHTML=emptyState('<i class="ic ic-building-2" aria-hidden="true"></i>',t('empty_tenants'));return;}list.innerHTML=rows.map(tn=>`<div class="tenant-card"><div class="tenant-card-main"><span class="avatar-badge">${iconHtml(tn.icon,'utensils')}</span><div><b>${escapeHtml(tn.name)}</b><small>${escapeHtml(tn.plan_code||'starter')} · ${subLabel(tn.subscription_status)} · ${tn.branch_count}/${tn.max_branches} สาขา · ${tn.user_count}/${tn.max_users} ผู้ใช้</small></div></div><div class="tenant-card-actions"><button class="ghost-btn" data-sub-tenant="${tn.id}">แพ็กเกจ</button>${tn.active?`<button class="ghost-btn danger" data-del-tenant="${tn.id}">ระงับ</button>`:`<button class="ghost-btn" data-reactivate-tenant="${tn.id}">เปิดใช้งาน</button>`}</div></div>`).join('')}
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

function historyDateBounds(){
  const mode=$('#historyDateRange')?.value||'today';
  if(mode==='custom'){return{from:$('#historyDateFrom')?.value||'',to:$('#historyDateTo')?.value||''}}
  // Restaurant sales days (Lao time + the shop's day start), not the tablet's own calendar.
  const [from,to]=presetRange(['yesterday','7d','month'].includes(mode)?mode:'today');
  return{from,to};
}
function syncHistoryDateControls(){const custom=$('#historyDateRange')?.value==='custom';$('#historyCustomDates')?.classList.toggle('hidden',!custom)}
async function loadOrders() {
  const status = $('#orderStatusFilter').value;
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if(currentBranchId)qs.set('branch_id',currentBranchId);
  const d=historyDateBounds(); if(d.from)qs.set('date_from',d.from); if(d.to)qs.set('date_to',d.to);
  const text=($('#historySearch')?.value||'').trim(); if(text){qs.set('q',text);qs.delete('date_from');qs.delete('date_to');}
  const r = await api('/api/orders?' + qs.toString());
  renderOrdersList(r.orders);
}
$('#orderStatusFilter').addEventListener('change', loadOrders);
$('#historyDateRange')?.addEventListener('change',()=>{syncHistoryDateControls();loadOrders()});
$('#historyDateFrom')?.addEventListener('change',loadOrders); $('#historyDateTo')?.addEventListener('change',loadOrders);
syncHistoryDateControls();
$('#refreshOrdersBtn').addEventListener('click',loadOrders);
let historySearchTimer=null;$('#historySearch').addEventListener('input',()=>{clearTimeout(historySearchTimer);historySearchTimer=setTimeout(loadOrders,300)});
$('#refreshPosBtn').addEventListener('click', loadBoardData);
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
      ? `<span class="oc-kitchen-sent-badge" title="${escapeHtml(t('label_kitchen_sent_at'))} ${fmtClock(it.kitchen_sent_at)}"><i class="ic ic-bell" aria-hidden="true"></i> ${fmtClock(it.kitchen_sent_at)}</span>` : '';
    const activeQty = Math.max(0, Number(it.quantity || 0) - Number(it.cancelled_quantity || 0));
    const editable = kitchenEligible && o.payment_status === 'unpaid' && o.status !== 'completed';
    const cb = editable && activeQty > 0 && !it.kitchen_sent_at
      ? `<input type="checkbox" class="oc-item-cb" data-item-id="${it.id}">` : '';
    const editControls = editable && activeQty > 0 ? `<span class="oc-edit-controls"><button type="button" class="mini-step mini-tools" data-line-tools="${o.id}:${it.id}" title="ราคา / แถม / ห่อ / เร่ง" aria-label="เครื่องมือรายการ"><i class="ic ic-sliders-horizontal" aria-hidden="true"></i></button><button type="button" class="mini-step" data-item-qty="${o.id}:${it.id}:${Math.max(1,activeQty-1)}:${activeQty}" ${activeQty<=1?'disabled':''}>−</button><b>${activeQty}</b><button type="button" class="mini-step" data-item-qty="${o.id}:${it.id}:${activeQty+1}:${activeQty}">+</button><button type="button" class="mini-cancel" title="ยกเลิกรายการ" aria-label="ยกเลิกรายการ" data-cancel-item="${o.id}:${it.id}:${activeQty}"><i class="ic ic-x" aria-hidden="true"></i> ยกเลิก</button></span>` : '';
    return `<li class="oc-item-row">
      <label class="oc-item-label">${cb}<span><b>${activeQty}×</b> ${escapeHtml(it.item_name_snapshot)}${it.item_name2_snapshot ? `<span class="name2">${escapeHtml(it.item_name2_snapshot)}</span>` : ''}${optsHtml}${it.notes ? ` <span class="hint">· ${escapeHtml(it.notes)}</span>` : ''}${itemTagsHtml(it)}${it.cancelled_quantity ? ` <small class="cancelled-note">ยกเลิก ${it.cancelled_quantity}</small>` : ''}</span></label>${editControls}
      ${sentBadge}
    </li>`;
  }).join('');
  return `
    <div class="order-card" data-order-id="${o.id}">
      <div class="oc-head">
        <div>
          <div class="oc-no">#${escapeHtml(o.order_no)} — ${escapeHtml(orderTypeLabel(o.order_type))}${o.table_name_snapshot ? ' · ' + escapeHtml(o.table_name_snapshot) : ''}</div>
          <div class="oc-meta">${escapeHtml(o.customer_name)}${o.customer_phone ? ' · ' + escapeHtml(o.customer_phone) : ''} · ${zaabosDateTime(o.created_at)}${o.scheduled_for ? ' · <i class="ic ic-alarm-clock" aria-hidden="true"></i> '+escapeHtml(zaabosDateTime(o.scheduled_for)) : ''}${o.order_type==='delivery' && Number(o.delivery_fee||0)>0 ? ' · <i class="ic ic-bike" aria-hidden="true"></i> '+fmtMoney(o.delivery_fee) : ''}</div>
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
        <button class="ghost-btn btn-send-kitchen" data-send-kitchen="${o.id}" disabled><i class="ic ic-bell" aria-hidden="true"></i> ${escapeHtml(t('btn_send_to_kitchen'))}</button>
      </div>` : `<div class="hint oc-auto-kitchen"><i class="ic ic-circle-check" aria-hidden="true"></i> รายการที่ต้องส่งเข้าครัวถูกส่งแล้ว</div>`}
      <div class="oc-pay-actions">
        ${o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn primary" data-add-items="${o.id}"><i class="ic ic-plus" aria-hidden="true"></i> เพิ่มอาหาร</button>` : ''}
        ${o.order_type === 'dine_in' && o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn" data-move-order="${o.id}"><i class="ic ic-arrow-left-right" aria-hidden="true"></i> ย้ายโต๊ะ</button>` : ''}
        ${o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn btn-confirm-pay" data-confirm-payment="${o.id}">${escapeHtml(t('btn_confirm_payment_done'))}</button>` : ''}
        <button class="ghost-btn" data-print-receipt="${o.id}">${escapeHtml(t('btn_print_receipt'))}</button>
        ${o.payment_status === 'paid' && (me.role === 'owner' || me.role === 'manager' || me.role === 'super_admin') ? `<button class="ghost-btn danger" data-refund-order="${o.id}"><i class="ic ic-undo-2" aria-hidden="true"></i> คืนเงิน</button>` : ''}
        ${o.payment_status === 'paid' ? `<button class="ghost-btn" data-reopen-order="${o.id}"><i class="ic ic-undo-2" aria-hidden="true"></i> เปิดบิลกลับมาแก้ไข</button>` : ''}
        ${o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn" data-bill-manager="${o.id}"><i class="ic ic-receipt" aria-hidden="true"></i> จัดการบิล</button>` : ''}\n
      </div>
    </div>`;
}

function historyDayLabel(iso){try{const d=new Date(iso),today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);const key=x=>`${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;if(key(d)===key(today))return 'วันนี้';if(key(d)===key(yesterday))return 'เมื่อวาน';return new Intl.DateTimeFormat(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric'}).format(d)}catch(e){return ''}}
function renderOrdersList(orders) {
  const list = $('#ordersList');
  if (!orders.length) { list.innerHTML = emptyState('', t('empty_orders')); return; }
  let lastDay=''; list.innerHTML=orders.map(o=>{const d=new Date(o.created_at),day=`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,head=day!==lastDay?`<div class="history-date-divider"><span>${escapeHtml(historyDayLabel(o.created_at))}</span><b>${escapeHtml(zaabosDateTime(o.created_at).split(' ')[0]||'')}</b></div>`:'';lastDay=day;return `${head}<div class="history-order-wrap">${orderCardHtml(o)}</div>`}).join('');
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
    const sent = await apiJson('/api/orders/' + orderId + '/send-to-kitchen', 'PUT', { item_ids });
    toast(t('toast_sent_to_kitchen'), 'ok');
    // Wi-Fi kitchen printer: the shop PC prints it; don't also open the browser print dialog.
    if (!sent.printed_by_server) printKitchenTicket(orderId, item_ids);
    onOrderActionDone();
  } catch (e) { toast(e.message, 'err'); }
}


// ---- Manager approval once, usable ~15 minutes by this staff member on this device ----
// The manager's password goes to the server once; the page only keeps the short-lived approval.
let approvalSession = null; // {token, until, by}
function approvalToken() { return approvalSession && approvalSession.until > Date.now() ? approvalSession.token : null; }
function staffNeedsApproval() { return !!(me && me.role === 'staff'); }
async function grantApproval(username, password) {
  const r = await apiJson('/api/approvals', 'POST', { approval_username: username, approval_password: password });
  approvalSession = { token: r.approval_token, until: Date.now() + (Number(r.expires_in || 900) - 30) * 1000, by: r.approver || username };
  return r.approval_token;
}
let approveResolve = null;
function requestApproval(text) {
  const tok = approvalToken(); if (tok) return Promise.resolve(tok);
  return new Promise(resolve => {
    approveResolve = resolve;
    $('#approveText').textContent = text || 'รายการนี้ต้องให้ผู้จัดการหรือเจ้าของร้านอนุมัติ';
    $('#approveUser').value = ''; $('#approvePass').value = ''; $('#approveError').textContent = '';
    openModal('#approveModal'); setTimeout(() => $('#approveUser').focus(), 60);
  });
}
$('#approveBtn').addEventListener('click', async () => {
  const u = $('#approveUser').value.trim(), pw = $('#approvePass').value, btn = $('#approveBtn');
  $('#approveError').textContent = '';
  if (!u || !pw) { $('#approveError').textContent = 'ใส่ชื่อผู้ใช้และรหัสผ่านของผู้จัดการ'; return; }
  btn.disabled = true;
  try { const tok = await grantApproval(u, pw); const r = approveResolve; approveResolve = null; $('#approvePass').value = ''; $('#approveModal').classList.remove('show'); if (r) r(tok); }
  catch (e) { $('#approveError').textContent = e.message; }
  finally { btn.disabled = false; }
});
$('#approvePass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#approveBtn').click(); });
new MutationObserver(() => { if (!$('#approveModal').classList.contains('show') && approveResolve) { const r = approveResolve; approveResolve = null; $('#approvePass').value = ''; r(null); } })
  .observe($('#approveModal'), { attributes: true, attributeFilter: ['class'] });

// Why food is voided — the shop's own top reasons (from its old POS: ~3 in 4 voids were "ของหมด").
const ITEM_VOID_REASONS = ['ของหมด','คุณภาพไม่ดี','ไม่สะอาด','ลูกค้ารอนาน','ใส่ผิด / กดผิด','ลูกค้าเปลี่ยนใจ'];
const DEFAULT_OPERATION_REASONS = ['กดรายการผิด','ลูกค้าเปลี่ยนใจ / ไม่รับรายการ','ลูกค้ารอนานเกินไป','ราคา / จำนวนไม่ถูกต้อง','สินค้าหมด / หมดสต็อก'];
let reasonResolve = null, reasonRun = null, selectedReason = '', reasonList = DEFAULT_OPERATION_REASONS, reasonNeedApproval = false, reasonCanMarkSoldOut = false;
// One sheet: tap a reason, a manager signs in right there when staff need approval, optional "mark sold out".
// opts.run(payload) does the request inside the sheet so a wrong password keeps the sheet (and the chosen reason) open.
function chooseOperationReason(actionLabel, opts = {}){
  return new Promise(resolve=>{
    reasonResolve=resolve; reasonRun=opts.run||null; selectedReason=''; reasonList=opts.reasons||DEFAULT_OPERATION_REASONS;
    reasonNeedApproval = (opts.needApproval != null ? !!opts.needApproval : staffNeedsApproval()) && !approvalToken();
    reasonCanMarkSoldOut = !!opts.soldOutItem;
    $('#reasonModalTitle').textContent=`เลือกเหตุผล${actionLabel}`; $('#reasonCustom').value=''; $('#reasonError').textContent='';
    $('#reasonTarget').classList.toggle('hidden',!opts.target); $('#reasonTarget').textContent=opts.target||'';
    $('#reasonChoices').innerHTML=reasonList.map((x,i)=>`<button type="button" class="reason-choice" data-reason-index="${i}">${escapeHtml(x)}</button>`).join('');
    $('#reasonSoldOut').checked=false; $('#reasonSoldOutRow').classList.add('hidden');
    $('#reasonApprove').classList.toggle('hidden',!reasonNeedApproval); $('#reasonApproveUser').value=''; $('#reasonApprovePass').value='';
    const btn=$('#reasonConfirmBtn'); btn.disabled=false; btn.textContent=opts.confirmLabel||'ยืนยัน';
    openModal('#reasonModal');
  });
}
$('#reasonChoices').addEventListener('click',e=>{const b=e.target.closest('[data-reason-index]');if(!b)return; selectedReason=reasonList[Number(b.dataset.reasonIndex)]; $$('.reason-choice',$('#reasonChoices')).forEach(x=>x.classList.toggle('active',x===b));
  if(reasonCanMarkSoldOut){const out=/หมด/.test(selectedReason);$('#reasonSoldOutRow').classList.toggle('hidden',!out);$('#reasonSoldOut').checked=out;}
  if(reasonNeedApproval&&!$('#reasonApproveUser').value)$('#reasonApproveUser').focus();});
$('#reasonConfirmBtn').addEventListener('click',async()=>{
  $('#reasonError').textContent='';
  const reason=($('#reasonCustom').value.trim()||selectedReason).trim();
  if(!reason){$('#reasonError').textContent='กรุณาเลือกเหตุผล';return;}
  const payload={reason};
  if(reasonNeedApproval){const u=$('#reasonApproveUser').value.trim(),pw=$('#reasonApprovePass').value;if(!u||!pw){$('#reasonError').textContent='ให้ผู้จัดการหรือเจ้าของร้านใส่ชื่อผู้ใช้และรหัสผ่าน';return;}
    try{payload.approval_token=await grantApproval(u,pw);}catch(e){$('#reasonError').textContent=e.message;return;}
    $('#reasonApprovePass').value='';reasonNeedApproval=false;$('#reasonApprove').classList.add('hidden');}
  else if(staffNeedsApproval()&&approvalToken())payload.approval_token=approvalToken();
  if(reasonCanMarkSoldOut&&!$('#reasonSoldOutRow').classList.contains('hidden')&&$('#reasonSoldOut').checked)payload.mark_sold_out=true;
  const btn=$('#reasonConfirmBtn');
  if(reasonRun){btn.disabled=true;try{await reasonRun({...payload});}catch(e){$('#reasonError').textContent=e.message;btn.disabled=false;return;}btn.disabled=false;}
  const r=reasonResolve;reasonResolve=null;reasonRun=null;$('#reasonApprovePass').value='';$('#reasonModal').classList.remove('show');if(r)r(payload);
});
// × / Esc / backdrop: the action is simply not done.
new MutationObserver(()=>{if(!$('#reasonModal').classList.contains('show')&&reasonResolve){const r=reasonResolve;reasonResolve=null;reasonRun=null;$('#reasonApprovePass').value='';r(null);}})
  .observe($('#reasonModal'),{attributes:true,attributeFilter:['class']});

async function criticalActionPayload(actionLabel, opts) {
  return await chooseOperationReason(actionLabel, opts);
}
function orderItemById(oid, iid) {
  const o = findOrderById(Number(oid)); return o ? (o.items || []).find(x => String(x.id) === String(iid)) : null;
}
// After a void: the kitchen gets a slip. Shops without a direct kitchen printer print it from this browser.
function afterVoid(oid, r) {
  if (r && r.kitchen_slip && !r.printed_by_server) printKitchenSlip(Number(oid), r.kitchen_slip);
  onOrderActionDone();
}
async function cancelOrderItemCritical(oid,iid,qty){
  const it = orderItemById(oid, iid), name = it ? it.item_name_snapshot : 'รายการนี้';
  const url = `/api/orders/${oid}/items/${iid}/cancel`;
  // Not sent to the kitchen yet: it's just fixing the bill — no reason sheet, no manager.
  if (it && !it.kitchen_sent_at) {
    if (!confirm(`ลบ “${name}” ออกจากบิล? (ยังไม่ส่งครัว)`)) return;
    try { afterVoid(oid, await apiJson(url, 'PUT', { quantity: Number(qty) })); toast('ลบรายการแล้ว', 'ok'); } catch (e) { toast(e.message, 'err'); }
    return;
  }
  const done = await chooseOperationReason('การยกเลิกรายการ', { reasons: ITEM_VOID_REASONS, soldOutItem: true, target: `${qty}× ${name}`, confirmLabel: 'ยืนยันยกเลิกรายการ',
    run: async p => { afterVoid(oid, await apiJson(url, 'PUT', { ...p, quantity: Number(qty) })); } });
  if (done) toast(done.mark_sold_out ? 'ยกเลิกแล้ว · แจ้งครัว · ตั้งเมนูเป็น “หมด” แล้ว' : 'ยกเลิกรายการแล้ว · แจ้งครัวแล้ว', 'ok');
}
async function reduceOrderItemQty(oid, iid, target) {
  const it = orderItemById(oid, iid), url = `/api/orders/${oid}/items/${iid}/quantity`;
  if (it && !it.kitchen_sent_at) { try { afterVoid(oid, await apiJson(url, 'PUT', { quantity: target })); } catch (e) { toast(e.message, 'err'); } return; }
  const cur = it ? Number(it.quantity || 0) - Number(it.cancelled_quantity || 0) : target + 1;
  const done = await chooseOperationReason('การลดจำนวน', { reasons: ITEM_VOID_REASONS, soldOutItem: true, target: `${it ? it.item_name_snapshot : ''} ${cur} → ${target}`, confirmLabel: 'ยืนยันลดจำนวน',
    run: async p => { afterVoid(oid, await apiJson(url, 'PUT', { ...p, quantity: target })); } });
  if (done) toast('ลดจำนวนแล้ว · แจ้งครัวแล้ว', 'ok');
}
async function setOrderStatusCritical(id,status){
  const url='/api/orders/'+id+'/status';
  if(status==='cancelled'){
    const done=await chooseOperationReason('การยกเลิกออเดอร์',{confirmLabel:'ยืนยันยกเลิกทั้งออเดอร์',run:async p=>{await apiJson(url,'PUT',{...p,status});}});
    if(!done) return;
    closeModals(); toast('ยกเลิกออเดอร์แล้ว โต๊ะกลับเป็นว่าง','ok'); onOrderActionDone(); return;
  }
  try{ await apiJson(url,'PUT',{status}); onOrderActionDone(); }catch(e){ toast(e.message,'err'); }
}

function wireOrderActionClicks(container) {
  container.addEventListener('click', (e) => {
    const s = e.target.dataset.setStatus, p = e.target.dataset.setPayment;
    const cp = e.target.dataset.confirmPayment, pr = e.target.dataset.printReceipt;
    const sk = e.target.dataset.sendKitchen, ai = e.target.dataset.addItems, mv = e.target.dataset.moveOrder;
    const rf = e.target.dataset.refundOrder, mg = e.target.dataset.mergeOrder, sp = e.target.dataset.splitOrder, bm=e.target.dataset.billManager, ff=e.target.dataset.fulfillment, ro=e.target.dataset.reopenOrder;
    const iq = e.target.dataset.itemQty, ci = e.target.dataset.cancelItem;
    const ltb = e.target.closest('[data-line-tools]');
    if (ltb) { const [loid, liid] = ltb.dataset.lineTools.split(':').map(Number); openLineTools(loid, liid); return; }
    if (ff) { const [oid,status]=ff.split(':'); apiJson(`/api/orders/${oid}/fulfillment`,'PUT',{fulfillment_status:status}).then(onOrderActionDone).catch(err=>toast(err.message,'err')); }
    else if (iq) {
      const [oid,iid,qty,oldQty]=iq.split(':');
      const target=Number(qty), previous=Number(oldQty);
      if(target < previous){ reduceOrderItemQty(oid, iid, target); }
      else { apiJson(`/api/orders/${oid}/items/${iid}/quantity`,'PUT',{quantity:target}).then(onOrderActionDone).catch(err=>toast(err.message,'err')); }
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
  const methods=[...new Set(((order&&order.payments)||[]).filter(p=>!p.reversed_at).map(p=>p.payment_method))];
  $('#refundMethod').innerHTML=methods.map(m=>`<option value="${escapeHtml(m)}">${escapeHtml(paymentMethodName(m))}</option>`).join('');
  $('#refundMethodRow').hidden=methods.length<2;
  refundOrderId=orderId; $('#refundMax').textContent=fmtMoney(maxAmount); $('#refundAmount').value=''; $('#refundAmount').max=maxAmount||''; $('#refundReason').value=''; $('#refundError').textContent=''; openModal('#refundModal');
}
$('#refundSubmit').addEventListener('click',async()=>{
  if(refundOrderId==null)return; const raw=$('#refundAmount').value.trim(),amount=raw===''?null:Number(raw),reason=$('#refundReason').value.trim(); $('#refundError').textContent='';
  if(amount!==null&&(!Number.isFinite(amount)||amount<=0)){ $('#refundError').textContent='ยอดคืนเงินไม่ถูกต้อง'; return; }
  const max=Number($('#refundAmount').max||0); if(amount!==null&&max>0&&amount>max){$('#refundError').textContent='ยอดคืนเงินเกินยอดที่คืนได้';return;}
  if(!reason){$('#refundError').textContent='กรุณาระบุเหตุผลการคืนเงิน';return;}
  const payload={reason};if(amount!==null)payload.amount=amount;if(!$('#refundMethodRow').hidden&&$('#refundMethod').value)payload.method=$('#refundMethod').value;const id=refundOrderId;
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
    body.innerHTML=`<div class="bm-move-head"><div><span class="bm-kicker">ย้ายทั้งบิล</span><h3>${escapeHtml(o.table_name_snapshot||'โต๊ะปัจจุบัน')} <span><i class="ic ic-arrow-right" aria-hidden="true"></i></span> เลือกโต๊ะปลายทาง</h3><p>โต๊ะที่มีออเดอร์อยู่จะย้ายทั้งบิลเข้าไปไม่ได้ เพื่อป้องกันบิลชนกัน</p></div><span class="bm-bill-no">#${escapeHtml(o.order_no)}</span></div>
      <div class="bm-grid bm-table-grid">${tables.map(t=>{const active=tableActiveOrders(t.id).filter(x=>x.id!==o.id&&!['cancelled','completed'].includes(x.status));const occupied=active.length>0;return `<button class="bm-choice bm-table-choice ${occupied?'is-occupied':''}" ${occupied?'disabled':''} data-bm-table="${t.id}"><span class="bm-table-icon">${occupied?'●':'▦'}</span><span><b>${escapeHtml(t.name||('โต๊ะ '+t.id))}</b><small>${occupied?'มีออเดอร์อยู่ · ย้ายทั้งบิลไม่ได้':'ว่าง · แตะเพื่อย้ายทั้งบิล'}</small></span><span class="bm-arrow">${occupied?'ล็อก':'<i class="ic ic-arrow-right" aria-hidden="true"></i>'}</span></button>`}).join('')||'<div class="bm-empty">ไม่มีโต๊ะปลายทาง</div>'}</div>`;
  }else if(billManagerMode==='merge'){
    const targets=(activeOrders||[]).filter(x=>x.id!==o.id&&x.branch_id===o.branch_id&&x.payment_status==='unpaid'&&!['cancelled','completed'].includes(x.status));
    body.innerHTML=`<div class="bm-section-head"><div><span class="bm-kicker">รวมทั้งบิล</span><h3>เลือกบิลปลายทาง</h3><p>รายการทั้งหมดจากบิลนี้จะถูกรวมเข้าบิลที่เลือก</p></div></div><div class="bm-grid">${targets.map(x=>`<button class="bm-choice" data-bm-target="${x.id}"><b>${escapeHtml(x.table_name_snapshot||'ไม่มีโต๊ะ')}</b><small>#${escapeHtml(x.order_no)} · ${fmtMoney(x.total_amount)}</small></button>`).join('')||'<div class="bm-empty">ไม่มีบิลที่รวมได้</div>'}</div>`;
  }else{
    const rows=o.items.filter(it=>Number(it.quantity||0)-Number(it.cancelled_quantity||0)>0);
    const occupiedTargets=(activeOrders||[]).filter(x=>x.id!==o.id&&x.branch_id===o.branch_id&&x.order_type==='dine_in'&&x.payment_status==='unpaid'&&!['cancelled','completed'].includes(x.status));
    body.innerHTML=`<div class="bm-section-head"><div><span class="bm-kicker">ย้ายบางรายการ</span><h3>เลือกรายการและจำนวน</h3><p>ใช้เมื่อลูกค้าย้ายบางเมนูไปอีกโต๊ะ หรืออยากแยกเป็นบิลใหม่ โดยสต็อกและครัวจะไม่ถูกนับซ้ำ</p></div></div>
      <div class="bm-items">${rows.map(it=>{const q=Number(it.quantity||0)-Number(it.cancelled_quantity||0);return `<div class="bm-item"><div><b>${escapeHtml(it.item_name_snapshot)}</b><small>ในบิล ${q}</small></div><div class="qty-stepper"><button data-bm-minus="${it.id}">−</button><span data-bm-qty="${it.id}" data-max="${q}">0</span><button data-bm-plus="${it.id}">+</button></div></div>`}).join('')}</div>
      <div class="bm-destination"><span class="bm-kicker">ปลายทาง</span><div class="bm-destination-actions"><button class="bm-new-bill" id="bmSplitConfirm">＋ แยกเป็นบิลใหม่</button></div>
      ${occupiedTargets.length?`<div class="bm-target-label">หรือย้ายรายการที่เลือกไปยังบิล/โต๊ะที่มีออเดอร์อยู่</div><div class="bm-grid bm-target-grid">${occupiedTargets.map(x=>`<button class="bm-choice bm-target-choice" data-bm-split-target="${x.id}"><span><b>${escapeHtml(x.table_name_snapshot||'ไม่มีโต๊ะ')}</b><small>#${escapeHtml(x.order_no)} · ${fmtMoney(x.total_amount)}</small></span><span class="bm-arrow"><i class="ic ic-arrow-right" aria-hidden="true"></i></span></button>`).join('')}</div>`:'<div class="bm-target-label">ตอนนี้ไม่มีโต๊ะอื่นที่มีบิลเปิดอยู่</div>'}</div>`;
    $('#bmSplitConfirm').onclick=async()=>{const items=bmSelectedItems(body);if(!items.length){toast('เลือกรายการก่อน','err');return;}try{const r=await apiJson(`/api/orders/${o.id}/split`,'POST',{items});closeModals();toast(`แยกเป็นบิล #${r.new_order_no}`,'ok');onOrderActionDone()}catch(e){toast(e.message,'err')}};
  }
}
$('#billManagerBody').addEventListener('click',async e=>{
  const t=e.target.closest('[data-bm-table]');if(t&&!t.disabled){const destination=t.querySelector('b')?.textContent||'โต๊ะปลายทาง';if(!confirm(`ยืนยันย้ายทั้งบิลไป ${destination}?`))return;try{const src=billManagerSource.id,r=await apiJson(`/api/orders/${src}/move-table`,'PUT',{table_id:Number(t.dataset.bmTable)});closeModals();toast(`ย้ายไป ${destination} แล้ว`+(r.kitchen_slip?' · แจ้งครัวแล้ว':''),'ok');if(r.kitchen_slip&&!r.printed_by_server)printKitchenSlip(src,r.kitchen_slip);onOrderActionDone()}catch(err){toast(err.message,'err')}return;}
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
  try{const r=await apiJson(`/api/orders/${sourceId}/split`,'POST',{items:selected});closeModals();toast(`แยกบิลสำเร็จ  #${r.new_order_no}`,'ok');onOrderActionDone();}catch(e){toast(e.message,'err');}
}

function onOrderActionDone() { loadOrders(); loadBoardData(); }

function findOrderById(orderId) {
  return activeOrders.find(x => x.id === orderId) || lastOrdersFlat.find(x => x.id === orderId) || customerOrdersCache.find(x => x.id === orderId);
}

let cpOrderId=null,extraPaymentParts=[];
// The server's bill formula (items - discount + service + tax + delivery); the old local guess
// ignored service/tax/delivery/promo, so those bills could never be paid.
let cpQuote=null,cpQuoteSeq=0;
function cpBaseDue(){if(cpQuote)return Number(cpQuote.due||0);const o=findOrderById(cpOrderId);if(!o)return 0;return Math.max(0,Number(o.total_amount||0)-Math.max(0,Number($('#cpDiscount').value||0)))+Number(o.delivery_fee||0);}
async function refreshCpQuote(resetAmounts){
  if(cpOrderId==null)return;const seq=++cpQuoteSeq;
  try{
    const q=await apiJson('/api/orders/'+cpOrderId+'/quote','POST',{promotion_code:$('#cpPromo').value.trim(),discount_amount:$('#cpDiscount').value.trim()||0});
    if(seq!==cpQuoteSeq)return;cpQuote=q;$('#cpError').textContent='';
  }catch(e){if(seq!==cpQuoteSeq)return;cpQuote=null;$('#cpError').textContent=e.message;}
  const q=cpQuote,lines=[];
  if(q){if(q.discount>0)lines.push(['ส่วนลด'+(q.label?' · '+q.label:''),'−'+fmtMoney(q.discount)]);if(q.service>0)lines.push([`ค่าบริการ ${q.service_rate}%`,fmtMoney(q.service)]);if(q.tax>0)lines.push([`ภาษี ${q.tax_rate}%`,fmtMoney(q.tax)]);if(q.delivery>0)lines.push(['ค่าส่ง',fmtMoney(q.delivery)]);}
  $('#cpBreakdown').innerHTML=lines.map(([a,b])=>`<div class="row"><span>${escapeHtml(a)}</span><span>${b}</span></div>`).join('');
  $('#cpTotal').textContent=fmtMoney(cpBaseDue());
  if(resetAmounts!==false){const extras=extraPaymentParts.reduce((a,x)=>a+Number(x.amount||0),0);$('#cpPrimaryAmount').value=String(Math.max(0,cpBaseDue()-extras));$('#cpCash').value=$('#cpPrimaryAmount').value;}
  renderCashQuick();updateCpPaymentSummary();
}
// One tap for the notes the customer hands over (kip/baht), instead of typing the amount.
function renderCashQuick(){
  const box=$('#cpCashQuick');if(!box)return;const due=Math.max(0,Number($('#cpPrimaryAmount').value||0));
  const notes=[1000,5000,10000,20000,50000,100000],opts=[due];
  for(const step of [5000,10000,50000,100000]){const v=Math.ceil(due/step)*step;if(v>due&&!opts.includes(v))opts.push(v);}
  for(const n of notes){if(n>due&&!opts.includes(n))opts.push(n);}
  box.innerHTML=opts.sort((a,b)=>a-b).slice(0,5).map((v,i)=>`<button type="button" class="ghost-btn" data-cash-quick="${v}">${i===0?'พอดี ':''}${fmtMoney(v)}</button>`).join('');
}
function paymentMethodName(m){return({cash:'เงินสด',qr:'QR',card:'บัตร',bank_transfer:'โอนธนาคาร',other:'อื่น ๆ'})[m]||m}
function updateCpPaymentSummary(){const due=cpBaseDue(),method=$('#cpMethod').value;$('#cpCashLabel').classList.toggle('hidden',method!=='cash');const primary=Math.max(0,Number($('#cpPrimaryAmount').value||0)),extras=extraPaymentParts.reduce((a,x)=>a+Math.max(0,Number(x.amount||0)),0),paid=primary+extras,remaining=Math.max(0,due-paid),cash=method==='cash'?Math.max(0,Number($('#cpCash').value||0)):0;$('#cpPaidTotal').textContent=fmtMoney(paid);$('#cpRemaining').textContent=fmtMoney(remaining);$('#cpRemaining').classList.toggle('payment-ok',Math.abs(paid-due)<.005);$('#cpChange').textContent=fmtMoney(method==='cash'?Math.max(0,cash-primary):0);}
function renderPaymentParts(){const el=$('#cpPaymentParts');if(!el)return;el.innerHTML=extraPaymentParts.map((p,i)=>`<div class="payment-part-row"><select data-part-method="${i}"><option value="cash"> เงินสด</option><option value="qr"> QR</option><option value="card"> บัตร</option><option value="bank_transfer"> โอน</option><option value="other">อื่น ๆ</option></select><input data-part-amount="${i}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="ยอดช่องทางนี้" value="${p.amount||''}"><button class="icon-btn danger" data-remove-part="${i}">×</button></div>`).join('');extraPaymentParts.forEach((p,i)=>{const m=el.querySelector(`[data-part-method="${i}"]`);if(m)m.value=p.method});updateCpPaymentSummary();}
let cpRequestKey=null;
function newCheckoutKey(){return (window.crypto&&crypto.randomUUID)?crypto.randomUUID():('pay-'+Date.now()+'-'+Math.random().toString(36).slice(2))}
function openConfirmPaymentModal(orderId){const o=findOrderById(orderId);if(!o)return;cpOrderId=orderId;cpRequestKey=newCheckoutKey();checkCheckoutShift();extraPaymentParts=[];$('#cpTotal').textContent=fmtMoney(o.total_amount);$('#cpPromo').value='';$('#cpDiscount').value='';$('#cpDiscountReason').value='';$('#cpApprovalUser').value='';$('#cpApprovalPass').value='';$('#cpAdvanced').open=false;$('#cpMethod').value=o.payment_method&&o.payment_method!=='split'?o.payment_method:'cash';$('#cpPrimaryAmount').value=String(Number(o.total_amount||0));$('#cpCash').value=String(Number(o.total_amount||0));$('#cpError').textContent='';cpQuote=null;$('#cpBreakdown').innerHTML='';renderPaymentParts();renderCpUnsent(o);openModal('#confirmPaymentModal');refreshCpQuote(true);}
// Food still waiting to go to the kitchen when the bill is paid is the classic "we paid but it never came".
function unsentItems(o){ return ((o&&o.items)||[]).filter(it=>!it.kitchen_sent_at&&Number(it.quantity||0)-Number(it.cancelled_quantity||0)>0); }
function renderCpUnsent(o){
  const box=$('#cpUnsent'),list=unsentItems(o);
  box.classList.toggle('hidden',!list.length); if(!list.length){box.innerHTML='';return;}
  const names=list.map(it=>`${Number(it.quantity||0)-Number(it.cancelled_quantity||0)}× ${it.item_name_snapshot}`).join(' · ');
  box.innerHTML=`<div class="cpu-text"><i class="ic ic-triangle-alert" aria-hidden="true"></i><div><b>ยังไม่ส่งครัว ${list.length} รายการ</b><small>${escapeHtml(names)}</small></div></div>
    <div class="cpu-actions"><button type="button" class="ghost-btn primary" data-cpu="send"><i class="ic ic-chef-hat" aria-hidden="true"></i> ส่งครัวแล้วจ่ายต่อ</button><button type="button" class="ghost-btn" data-cpu="skip">จ่ายโดยไม่ส่งครัว</button></div>`;
}
$('#cpUnsent').addEventListener('click',async e=>{
  const b=e.target.closest('[data-cpu]'); if(!b||cpOrderId==null)return;
  if(b.dataset.cpu==='skip'){$('#cpUnsent').classList.add('hidden');return;}
  const id=cpOrderId,ids=unsentItems(findOrderById(id)).map(it=>it.id); b.disabled=true;
  try{const r=await apiJson('/api/orders/'+id+'/send-to-kitchen','PUT',{item_ids:ids});toast(t('toast_sent_to_kitchen'),'ok');$('#cpUnsent').classList.add('hidden');
    await loadBoardData(); if(!r.printed_by_server)printKitchenTicket(id,ids);}
  catch(err){b.disabled=false;toast(err.message,'err');}
});
$('#cpMethod').addEventListener('change',()=>{if($('#cpMethod').value==='cash'&&!$('#cpCash').value)$('#cpCash').value=$('#cpPrimaryAmount').value;updateCpPaymentSummary()});$('#cpPrimaryAmount').addEventListener('input',updateCpPaymentSummary);$('#cpCash').addEventListener('input',updateCpPaymentSummary);
let cpQuoteTimer=null;const cpQuoteSoon=()=>{clearTimeout(cpQuoteTimer);cpQuoteTimer=setTimeout(()=>refreshCpQuote(true),350)};
$('#cpDiscount').addEventListener('input',cpQuoteSoon);$('#cpPromo').addEventListener('input',cpQuoteSoon);
$('#cpCashQuick').addEventListener('click',e=>{const b=e.target.closest('[data-cash-quick]');if(!b)return;$('#cpMethod').value='cash';$('#cpCash').value=b.dataset.cashQuick;updateCpPaymentSummary();});
$('#cpPrimaryAmount').addEventListener('input',renderCashQuick);
$('#cpAddPayment').addEventListener('click',()=>{const due=cpBaseDue(),paid=Number($('#cpPrimaryAmount').value||0)+extraPaymentParts.reduce((a,x)=>a+Number(x.amount||0),0);extraPaymentParts.push({method:'qr',amount:Math.max(0,due-paid)});renderPaymentParts()});
$('#cpPaymentParts').addEventListener('input',e=>{let i=e.target.dataset.partAmount;if(i!==undefined)extraPaymentParts[+i].amount=Number(e.target.value||0);i=e.target.dataset.partMethod;if(i!==undefined)extraPaymentParts[+i].method=e.target.value;updateCpPaymentSummary()});$('#cpPaymentParts').addEventListener('click',e=>{const i=e.target.dataset.removePart;if(i!==undefined){extraPaymentParts.splice(+i,1);renderPaymentParts()}});
$('#cpSubmit').addEventListener('click',async()=>{if(cpOrderId==null)return;$('#cpError').textContent='';const id=cpOrderId,method=$('#cpMethod').value,primary=Number($('#cpPrimaryAmount').value||0);if(primary<=0){$('#cpError').textContent='กรุณาระบุยอดชำระ';return}const parts=[{method,amount:primary,cash_received:method==='cash'?(Number($('#cpCash').value||0)||primary):null},...extraPaymentParts.map(x=>({method:x.method,amount:Number(x.amount||0)}))],due=cpBaseDue(),paid=parts.reduce((a,x)=>a+Number(x.amount||0),0);if(Math.abs(paid-due)>.005){$('#cpError').textContent=`ยอดชำระยังไม่ครบ: ชำระ ${fmtMoney(paid)} / ${fmtMoney(due)}`;return}if(parts.some(x=>x.amount<=0)){ $('#cpError').textContent='ยอดแต่ละช่องทางต้องมากกว่า 0';return}const payload={payment_status:'paid',payment_method:method,payments:parts},promo=$('#cpPromo').value.trim(),disc=$('#cpDiscount').value.trim(),dr=$('#cpDiscountReason').value.trim(),au=$('#cpApprovalUser').value.trim(),ap=$('#cpApprovalPass').value;if(promo)payload.promotion_code=promo;if(disc)payload.discount_amount=parseFloat(disc);if(dr)payload.discount_reason=dr;if(au)payload.approval_username=au;if(ap)payload.approval_password=ap;try{const result=await apiJson('/api/orders/'+id+'/payment','PUT',{...payload,client_request_id:cpRequestKey});toast('ชำระเงินสำเร็จ · '+result.payments.map(x=>paymentMethodName(x.method)+' '+fmtMoney(x.amount)).join(' + '),'ok');closeModals();cpOrderId=null;const fresh=await api('/api/orders?branch_id='+encodeURIComponent(currentBranchId||''));lastOrdersFlat=fresh.orders||[];activeOrders=lastOrdersFlat.filter(o=>o.status!=='completed'&&o.status!=='cancelled');renderTableBoard();renderOtherOrders();renderSidePanel();afterBoardData();refreshPosShiftBadge();printReceipt(id)}catch(e){$('#cpError').textContent=e.message;if(e.code==='shift_required')showCheckoutShiftBox(true)}});
// Step 1: every payment belongs to an open shift. Offer to open one right inside the checkout dialog.
function showCheckoutShiftBox(show){const b=$('#cpShiftBox');if(b)b.hidden=!show}
async function checkCheckoutShift(){showCheckoutShiftBox(false);if(!currentBranchId)return;try{const d=await api('/api/operations/shift?branch_id='+currentBranchId);showCheckoutShiftBox(!d.shift)}catch(e){}}
$('#cpOpenShiftBtn').addEventListener('click',async()=>{
  if(!currentBranchId)return;const opening=Number($('#cpOpeningCash').value||0);
  if(!Number.isFinite(opening)||opening<0){$('#cpError').textContent='เงินทอนตั้งต้นไม่ถูกต้อง';return}
  try{await apiJson('/api/operations/shift/open','POST',{branch_id:currentBranchId,opening_cash:opening,notes:'เปิดกะจากหน้าชำระเงิน'});toast('เปิดกะแล้ว','ok');refreshPosShiftBadge();showCheckoutShiftBox(false);$('#cpError').textContent=''}catch(e){$('#cpError').textContent=e.message}
});

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
  // Wi-Fi receipt printer on the shop PC: queue it there instead of the browser print dialog.
  try { const q = await apiJson('/api/orders/' + orderId + '/print-receipt', 'POST', {lang: currentLang, order_type_label: orderTypeLabel(o.order_type)}); if (q.queued) { toast('ส่งใบเสร็จไปเครื่องพิมพ์แล้ว', 'ok'); setTimeout(refreshPrintStatus, 2500); return; } } catch (e) {}
  const branch = (boot && boot.branches && boot.branches.find(b => Number(b.id) === Number(o.branch_id))) || null;
  let rs={}; try{rs=await api('/api/settings/receipt?branch_id='+encodeURIComponent(o.branch_id))}catch(e){}
  const shopName = rs.shop_name || ((me && me.tenant && me.tenant.name) || 'ZaabOS');
  const displayBranch = rs.branch_name || (branch&&branch.name) || '';
  const receiptClass=`paper-${rs.paper_width||'80'} font-${rs.font_scale||'normal'} head-${rs.header_align||'center'}`;
  const tax = Number(o.tax_amount || 0);
  const subtotal = Number(o.total_amount || 0);
  const discount = Number(o.discount_amount || 0);
  const service = Number(o.service_charge_amount || 0);
  const delivery = Number(o.delivery_fee || 0);
  const grandTotal = Math.max(0, subtotal - discount) + service + tax + delivery;
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
    const amount = qty * Number(it.unit_price || 0), free = !Number(it.unit_price || 0) && it.price_reason;
    const opts = (it.options || []).length ? `<div class="rp-item-sub">${escapeHtml(it.options.map(op => op.option_name_snapshot).join(' / '))}</div>` : '';
    const note = it.notes ? `<div class="rp-item-sub">${escapeHtml(it.notes)}</div>` : '';
    return `<tr><td class="rp-qty">${qty}</td><td class="rp-item">${escapeHtml(it.item_name_snapshot)}${it.item_name2_snapshot ? `<div class="rp-item-sub">${escapeHtml(it.item_name2_snapshot)}</div>` : ''}${opts}${note}</td><td class="rp-price">${free ? 'แถม' : fmtMoney(amount)}</td></tr>`;
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
    ${delivery > 0 ? `<div class="rp-row"><span>ค่าส่ง / Delivery</span><span>${fmtMoney(delivery)}</span></div>` : ''}
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

// Void / table-move note for the kitchen (browser print when the shop PC has no kitchen printer).
function printKitchenSlip(orderId, slip) {
  if (!slip) return;
  const o = findOrderById(orderId);
  const move = slip.kind === 'move', notice = ['rush', 'takeaway'].includes(slip.kind);
  const body = notice
    ? (slip.items || []).map(it => `<div class="kt-print-item">${Number(it.qty)}× ${escapeHtml(it.name)}${it.name2 ? `<div class="kt-print-opts">${escapeHtml(it.name2)}</div>` : ''}</div>`).join('')
    : move
    ? `<div class="kt-print-item">${escapeHtml(slip.from)} → ${escapeHtml(slip.to)}</div><div class="kt-print-opts">อาหารที่ยังไม่เสิร์ฟ ส่งโต๊ะใหม่</div>`
    : (slip.items || []).map(it => `<div class="kt-print-item">− ${Number(it.qty)}× ${escapeHtml(it.name)}${it.name2 ? `<div class="kt-print-opts">${escapeHtml(it.name2)}</div>` : ''}</div>`).join('')
      + (slip.reason ? `<div class="kt-print-notes">เหตุผล: ${escapeHtml(slip.reason)}</div>` : '');
  const where = slip.where && slip.where !== 'dine_in' ? (['takeaway', 'delivery'].includes(slip.where) ? orderTypeLabel(slip.where) : slip.where) : '';
  $('#kitchenTicketPrintArea').innerHTML = `
    <div class="kt-print-head">*** ${notice ? escapeHtml(slip.title || 'เร่ง / ເລັ່ງ') : move ? 'ย้ายโต๊ะ / ຍ້າຍໂຕະ' : 'ยกเลิก / ຍົກເລີກ'} ***</div>
    ${where ? `<div class="kt-print-item">${escapeHtml(where)}</div>` : ''}
    <div class="rp-sub">#${escapeHtml(slip.order_no || (o && o.order_no) || '')} · ${zaabosDateTime(new Date())}</div>
    <div class="rp-line"></div>${body}`;
  printElement($('#kitchenTicketPrintArea'));
}

function printKitchenTicket(orderId, itemIds) {
  const o = findOrderById(orderId);
  if (!o) return;
  const items = o.items.filter(it => itemIds.includes(it.id));
  if (!items.length) return;
  const itemsHtml = items.map(it => {
    const optLine = it.options.length ? `<div class="kt-print-opts">${escapeHtml(it.options.map(op => op.option_name_snapshot).join(', '))}</div>` : '';
    const noteLine = (it.notes ? `<div class="kt-print-notes"><i class="ic ic-notebook-pen" aria-hidden="true"></i> ${escapeHtml(it.notes)}</div>` : '')
      + (it.takeaway ? `<div class="kt-print-notes">&gt;&gt; ห่อกลับ / ຫໍ່ກັບ</div>` : '');
    return `<div class="kt-print-item">${it.quantity}× ${escapeHtml(it.item_name_snapshot)}${it.item_name2_snapshot ? `<div class="kt-print-opts">${escapeHtml(it.item_name2_snapshot)}</div>` : ''}${optLine}${noteLine}</div>`;
  }).join('');
  $('#kitchenTicketPrintArea').innerHTML = `
    <div class="kt-print-head">${escapeHtml(t('kitchen_ticket_header'))}</div>
    <div class="rp-sub">#${escapeHtml(o.order_no)} · ${escapeHtml(orderTypeLabel(o.order_type))}${o.table_name_snapshot ? ' · ' + escapeHtml(o.table_name_snapshot) : ''}</div>
    <div class="rp-sub">${zaabosDateTime(new Date())}</div>
    <div class="rp-line"></div>
    ${itemsHtml}
    ${o.notes ? `<div class="rp-line"></div><div class="kt-print-notes"><i class="ic ic-notebook-pen" aria-hidden="true"></i> ${escapeHtml(o.notes)}</div>` : ''}`;
  printElement($('#kitchenTicketPrintArea'));
}

// ===================== Live table board + side panel =====================

let lastOrdersFlat = []; // most recent unfiltered branch order fetch (feeds board/panel + card lookups)
const STATUS_PRIORITY = { received: 0, preparing: 1, ready: 2, served: 3 };

async function refreshPosShiftBadge(){
  const el=$('#posShiftBadge'); if(!el||!currentBranchId)return;
  try{const d=await api('/api/operations/shift?branch_id='+currentBranchId,{silent:true});if(d.shift){el.className='pos-shift-badge open';el.textContent='กะเปิดอยู่';el.title='เปิดกะเมื่อ '+formatDateTime(d.shift.opened_at);}else{el.className='pos-shift-badge closed';el.textContent='ยังไม่เปิดกะ';el.title='แตะเพื่อเปิดกะ';}el.onclick=()=>navigate('operations');}catch(e){el.className='pos-shift-badge';el.textContent='กะ';}
}

async function loadBoardData() {
  if (!currentBranchId) { activeOrders = []; renderTableBoard(); renderOtherOrders(); renderSidePanel(); return; }
  try {
    const qs = new URLSearchParams({ branch_id: currentBranchId });
    const r = await api('/api/orders?' + qs.toString(), { silent: true });
    lastOrdersFlat = r.orders;
    activeOrders = r.orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled');
    applySoldOutIds(r.sold_out_ids);
  } catch (e) { return; }
  renderTableBoard();
  renderOtherOrders();
  renderSidePanel();
  afterBoardData();
}

function tableActiveOrders(tableId) {
  return activeOrders.filter(o => o.order_type === 'dine_in' && o.table_id === tableId)
    .sort((a, b) => a.id - b.id);
}

let floorZone = '';
try { floorZone = localStorage.getItem('zaabos_floor_zone') || ''; } catch (e) {}
function renderZoneChips() {
  const zones = branchZones(), box = $('#zoneChips');
  if (floorZone && !zones.includes(floorZone)) floorZone = '';
  if (!zones.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const count = z => branchTables().filter(t => !z || (t.zone || '') === z).length;
  box.innerHTML = [['', 'ทั้งหมด'], ...zones.map(z => [z, z])].map(([z, label]) =>
    `<button type="button" class="chip ${z === floorZone ? 'active' : ''}" data-zone="${escapeHtml(z)}">${escapeHtml(label)} <small>${count(z)}</small></button>`).join('');
}
$('#zoneChips').addEventListener('click', e => {
  const b = e.target.closest('[data-zone]'); if (!b) return;
  floorZone = b.dataset.zone; try { localStorage.setItem('zaabos_floor_zone', floorZone); } catch (err) {}
  renderTableBoard();
});
function tableState(orders) {
  if (!orders.length) return 'free';
  if (orders.some(o => o.status === 'served')) return 'bill';
  if (orders.some(o => o.status === 'ready')) return 'ready';
  return 'busy';
}
function renderTableBoard() {
  const board = $('#tableBoard');
  renderZoneChips();
  const all = branchTables();
  const tables = all.filter(t => !floorZone || (t.zone || '') === floorZone);
  const busy = all.filter(t => tableActiveOrders(t.id).length).length;
  $('#floorSummary').textContent = all.length ? `ว่าง ${all.length - busy} · มีลูกค้า ${busy} · ทั้งหมด ${all.length} โต๊ะ` : '';
  if (!tables.length) { board.innerHTML = emptyState('', t('empty_tables')); return; }
  board.innerHTML = tables.map(tb => {
    const orders = tableActiveOrders(tb.id);
    if (!orders.length) {
      const local=offlineOutboxRows.filter(x=>x.status!=='conflict'&&x.payload.order_type==='dine_in'&&Number(x.payload.table_id)===Number(tb.id));
      if(local.length)return `<button type="button" class="board-tile offline-pending" data-board-table="${tb.id}" disabled><span class="bt-badge">OFFLINE</span><div class="bt-name">${escapeHtml(tb.name)}</div><div class="bt-empty-lbl">${local.length} ออเดอร์ · รอ Sync</div></button>`;
      const draft = draftCount('table', tb.id);
      return `<button type="button" class="board-tile bt-free${draft ? ' bt-has-draft' : ''}" data-board-table="${tb.id}">
        <div class="bt-head"><span class="bt-name">${escapeHtml(tb.name)}</span>${tb.zone && !floorZone ? `<span class="bt-zone">${escapeHtml(tb.zone)}</span>` : ''}</div>
        ${draft ? `<div class="bt-open bt-draft"><i class="ic ic-clock" aria-hidden="true"></i> ร่าง ${draft} รายการ · ยังไม่บันทึก</div>` : `<div class="bt-open"><i class="ic ic-plus" aria-hidden="true"></i> ${escapeHtml(t('board_table_empty'))}</div>`}
      </button>`;
    }
    const state = tableState(orders);
    const hasNewQr = orders.some(o => o.status === 'received' && o.placed_by === 'customer');
    const total = orders.reduce((s, o) => s + Number(o.total_amount || 0), 0);
    const guests = orders.reduce((s, o) => s + Number(o.guest_count || 0), 0);
    const since = Math.min(...orders.map(o => new Date(o.created_at).getTime()).filter(Boolean));
    const mins = Math.max(0, Math.floor((Date.now() - since) / 60000));
    const dur = mins >= 60 ? `${Math.floor(mins / 60)} ชม. ${String(mins % 60).padStart(2, '0')}` : `${mins} นาที`;
    const tag = state === 'bill' ? 'รอเก็บเงิน' : state === 'ready' ? 'อาหารพร้อม' : 'มีลูกค้า';
    const draft = orders.reduce((a, o) => a + draftCount('order', o.id), draftCount('table', tb.id));
    return `<button type="button" class="board-tile bt-busy bt-${state}" data-board-table="${tb.id}">
      <div class="bt-head"><span class="bt-name">${escapeHtml(tb.name)}</span><span class="bt-tag">${escapeHtml(tag)}</span></div>
      <div class="bt-amount">${fmtMoney(total)}</div>
      <div class="bt-sub"><span><i class="ic ic-users" aria-hidden="true"></i> ${guests || '-'}</span><span><i class="ic ic-clock" aria-hidden="true"></i> ${dur}</span>${orders.length > 1 ? `<span>${orders.length} บิล</span>` : ''}</div>
      ${hasNewQr ? `<span class="bt-flag bt-flag-new"><i class="ic ic-smartphone" aria-hidden="true"></i> QR ใหม่</span>` : ''}
      ${!hasNewQr && draft ? `<span class="bt-flag bt-flag-draft"><i class="ic ic-clock" aria-hidden="true"></i> ร่าง ${draft}</span>` : ''}
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
  if (orders.length === 1 && orders[0].payment_status === 'unpaid') { openAddItemsToOrder(orders[0].id); return; }
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

// ===================== Staff take-order (Version E workspace: menu left, bill right) =====================

let takeOrderType = 'dine_in';
let addItemsOrderId = null;
let takeOrderQuery = '';

function setTakeOrderType(type) {
  takeOrderType = type;
  $$('#takeOrderType button').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  $('#takeOrderTableRow').classList.toggle('hidden', type !== 'dine_in');
  $('#takeOrderDeliveryFields').classList.toggle('hidden', type !== 'delivery');
  $('#takeOrderScheduleRow').classList.toggle('hidden', type === 'dine_in');
  renderBillHead();
}
function resetTakeOrderForm() {
  cart = []; takeOrderQuery = ''; draftKeyCurrent = null;
  $('#takeOrderSearch').value = '';
  $('#takeOrderCustomerName').value = ''; $('#takeOrderPhone').value = ''; $('#takeOrderAddress').value = '';
  $('#takeOrderGuestCount').value = ''; $('#takeOrderScheduledFor').value=''; $('#takeOrderDeliveryFee').value='0';
  $('#takeOrderNotes').value = ''; $('#takeOrderNotes').classList.add('hidden');
  $('#takeOrderError').textContent = '';
  $('#takeOrderBill').classList.remove('bill-open');
  const tsel = $('#takeOrderTable');
  tsel.innerHTML = branchTables().map(t => `<option value="${t.id}">${escapeHtml(t.name)}${t.zone ? ' · ' + escapeHtml(t.zone) : ''}</option>`).join('');
}
function showTakeOrder() {
  $('#takeOrderModal').classList.toggle('add-mode', !!addItemsOrderId);
  renderTakeOrderCategories(); renderTakeOrderMenu(); renderCart();
  openModal('#takeOrderModal');
  setNavActive('takeorder');
}
function openTakeOrderForTable(tableId=null, type='dine_in') {
  closeModals();
  addItemsOrderId = null;
  resetTakeOrderForm();
  if (tableId) $('#takeOrderTable').value = String(tableId);
  setTakeOrderType(type);
  restoreDraft();
  showTakeOrder();
}
$('#takeOrderBtn').addEventListener('click', () => openTakeOrderForTable(null, 'takeaway'));
$('#takeOrderType').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn || addItemsOrderId) return;
  setTakeOrderType(btn.dataset.type);
});
$('#takeOrderTable').addEventListener('change', () => { renderBillHead(); saveDraft(); });
$('#takeOrderGuestCount').addEventListener('input', () => { renderBillHead(); saveDraft(); });
['#takeOrderCustomerName', '#takeOrderNotes'].forEach(sel => $(sel).addEventListener('input', saveDraft));
$('#takeOrderSearch').addEventListener('input', e => { takeOrderQuery = e.target.value.trim().toLowerCase(); renderTakeOrderMenu(); });
$('#billNoteBtn').addEventListener('click', () => { const n = $('#takeOrderNotes'); n.classList.toggle('hidden'); if (!n.classList.contains('hidden')) n.focus(); });
$('#billToggle').addEventListener('click', () => $('#takeOrderBill').classList.toggle('bill-open'));
$('#billManageBtn').addEventListener('click', () => {
  const o = addItemsOrderId && findOrderById(addItemsOrderId); if (!o) return;
  const go = () => { closeModals(); openOrderDetail([o], o.table_name_snapshot || orderTypeLabel(o.order_type)); };
  if (!guardTakeOrderLeave(go)) go();
});

// ---- Unsaved cart = draft on this device (per table / bill / order type) ----
// Closing the workspace, a reload, a crash or a dead battery never loses what was tapped.
const DRAFT_TTL_MS = 12 * 3600 * 1000;
let draftKeyCurrent = null;
function draftKeyFor(kind, id) { return currentBranchId ? `zaabos_draft:${currentBranchId}:${kind}:${id}` : null; }
function draftKey() {
  if (addItemsOrderId) return draftKeyFor('order', addItemsOrderId);
  if (takeOrderType === 'dine_in') return draftKeyFor('table', $('#takeOrderTable').value || '0');
  return draftKeyFor('new', takeOrderType);
}
function saveDraft() {
  if (!$('#takeOrderModal').classList.contains('show') && !draftKeyCurrent) return;
  const key = draftKey();
  try {
    if (draftKeyCurrent && draftKeyCurrent !== key) localStorage.removeItem(draftKeyCurrent);
    draftKeyCurrent = key; if (!key) return;
    if (cart.length) localStorage.setItem(key, JSON.stringify({ ts: Date.now(), cart, guest: $('#takeOrderGuestCount').value, customer: $('#takeOrderCustomerName').value, notes: $('#takeOrderNotes').value }));
    else localStorage.removeItem(key);
  } catch (e) {}
}
function clearDraft() { try { if (draftKeyCurrent) localStorage.removeItem(draftKeyCurrent); } catch (e) {} draftKeyCurrent = null; }
function readDraft(key) {
  try {
    const d = key && JSON.parse(localStorage.getItem(key) || 'null');
    if (!d || !Array.isArray(d.cart) || !d.cart.length) return null;
    if (Date.now() - Number(d.ts || 0) > DRAFT_TTL_MS) { localStorage.removeItem(key); return null; }
    return d;
  } catch (e) { return null; }
}
function draftCount(kind, id) { const d = readDraft(draftKeyFor(kind, id)); return d ? d.cart.reduce((a, c) => a + Number(c.qty || 0), 0) : 0; }
function restoreDraft() {
  const key = draftKey(); let d = readDraft(key);
  // Started as a new order on this table, but the table got a bill meanwhile (tablet / QR): carry it over.
  if (!d && addItemsOrderId) {
    const o = findOrderById(addItemsOrderId), tk = o && o.table_id ? draftKeyFor('table', o.table_id) : null;
    d = readDraft(tk); if (d) try { localStorage.removeItem(tk); } catch (e) {}
  }
  draftKeyCurrent = key;
  if (!d) return;
  const known = new Set(branchItems().map(i => i.id));
  cart = d.cart.filter(c => known.has(c.menu_item_id));
  if (!addItemsOrderId) {
    if (d.guest) $('#takeOrderGuestCount').value = d.guest;
    if (d.customer) $('#takeOrderCustomerName').value = d.customer;
    if (d.notes) { $('#takeOrderNotes').value = d.notes; $('#takeOrderNotes').classList.remove('hidden'); }
  }
  if (cart.length) toast(`กู้รายการที่ยังไม่ได้บันทึก ${cart.reduce((a, c) => a + c.qty, 0)} รายการ`, 'ok');
}

// Leaving the workspace with unsaved items: save now, keep for later, or throw away.
let leaveThen = null;
function guardTakeOrderLeave(then) {
  if (!$('#takeOrderModal').classList.contains('show') || !cart.length || takeOrderSaving || $('#leaveOrderModal').classList.contains('show')) return false;
  leaveThen = then || null;
  const n = cart.reduce((a, c) => a + c.qty, 0);
  $('#leaveOrderText').textContent = `${$('#billTitle').textContent} · ${n} รายการยังไม่ได้บันทึก`;
  $('#leaveOrderSave').innerHTML = `<i class="ic ic-save" aria-hidden="true"></i> ${addItemsOrderId ? 'เพิ่มเข้าบิล' : 'บันทึกบิล'}${$('#takeOrderSendKitchen').checked ? ' + ส่งครัว' : ''}`;
  openModal('#leaveOrderModal');
  return true;
}
function finishLeave() {
  const then = leaveThen; leaveThen = null;
  $('#leaveOrderModal').classList.remove('show'); $('#takeOrderModal').classList.remove('show');
  if (then) then();
}
$('#leaveOrderKeep').addEventListener('click', () => { saveDraft(); draftKeyCurrent = null; finishLeave(); toast('เก็บรายการไว้แล้ว · เปิดโต๊ะนี้อีกครั้งเพื่อทำต่อ', 'ok'); renderTableBoard(); });
$('#leaveOrderDiscard').addEventListener('click', () => { clearDraft(); cart = []; finishLeave(); renderTableBoard(); });
$('#leaveOrderSave').addEventListener('click', async () => {
  const then = leaveThen; leaveThen = null; $('#leaveOrderModal').classList.remove('show');
  const id = await submitTakeOrder(); if (id && then) then();
});
// Keep the sidebar highlight in step with the workspace being open or closed.
new MutationObserver(() => { if (!$('#takeOrderModal').classList.contains('show')) setNavActive(currentTab); })
  .observe($('#takeOrderModal'), { attributes: true, attributeFilter: ['class'] });

let takeOrderActiveCat = null;
function renderTakeOrderCategories() {
  const cats = branchCategories();
  takeOrderActiveCat = null;
  const el = $('#takeOrderCatScroll');
  el.innerHTML = `<button type="button" class="cat-chip active" data-cat="">${escapeHtml(t('cat_all'))}</button>` + cats.map(c => `<button type="button" class="cat-chip" data-cat="${c.id}">${iconHtml(c.icon)} ${escapeHtml(c.name)}</button>`).join('');
}
$('#takeOrderCatScroll').addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-chip');
  if (!btn) return;
  takeOrderActiveCat = btn.dataset.cat || null;
  $$('#takeOrderCatScroll .cat-chip').forEach(b => b.classList.toggle('active', b === btn));
  renderTakeOrderMenu();
});
function dishPlaceholder(it) {
  const cat = branchCategories().find(c => String(c.id) === String(it.category_id));
  return `<div class="mc-photo mc-ph">${iconHtml((cat && cat.icon) || 'utensils')}</div>`;
}
function renderTakeOrderMenu() {
  let items = branchItems();
  if (takeOrderActiveCat) items = items.filter(i => String(i.category_id) === String(takeOrderActiveCat));
  if (takeOrderQuery) items = items.filter(i => { const n = menuNames(i); return (i.name + ' ' + n.main + ' ' + n.sub + ' ' + JSON.stringify(parseNameI18n(i.name_i18n))).toLowerCase().includes(takeOrderQuery); });
  const grid = $('#takeOrderMenuGrid');
  if (!items.length) { grid.innerHTML = emptyState('', takeOrderQuery ? 'ไม่พบเมนูที่ค้นหา' : t('empty_menu')); return; }
  grid.innerHTML = items.map(it => { const n = menuNames(it); return `
    <div class="menu-card ${it.sold_out ? 'sold-out' : ''}" data-pick-item="${it.id}" role="button" tabindex="0">
      ${it.image_url ? `<img class="mc-photo" src="${it.image_url}" alt="" loading="lazy">` : dishPlaceholder(it)}
      ${it.sold_out ? `<span class="mc-badge">${escapeHtml(t('badge_sold_out'))}</span>` : ''}
      <button type="button" class="mc-so" data-so-toggle="${it.id}" aria-label="${it.sold_out ? 'กลับมาขาย' : 'ตั้งเป็นหมด'}">${it.sold_out ? '<i class="ic ic-undo-2" aria-hidden="true"></i> มีของ' : '<i class="ic ic-ban" aria-hidden="true"></i> หมด'}</button>
      <div class="mc-body">
        <span class="mc-name">${escapeHtml(n.main)}</span>${n.sub ? `<span class="mc-sub">${escapeHtml(n.sub)}</span>` : ''}
        <div class="mc-foot">${it.open_price ? `<span class="mc-price open">ใส่ราคาตอนสั่ง</span>` : `<span class="mc-price">${fmtMoney(it.base_price)}</span>`}${it.sold_out ? '' : `<span class="mc-add" aria-hidden="true"><i class="ic ic-plus"></i></span>`}</div>
      </div>
    </div>`; }).join('');
  updateTakeOrderFeedback();
}
// Staff must see what they already tapped without scrolling to the bill: a count on each dish.
function updateTakeOrderFeedback() {
  const counts = {};
  cart.forEach(c => { counts[c.menu_item_id] = (counts[c.menu_item_id] || 0) + c.qty; });
  $$('#takeOrderMenuGrid [data-pick-item]').forEach(card => {
    const n = counts[card.dataset.pickItem] || 0;
    let b = card.querySelector('.mc-qty');
    if (!n) { if (b) b.remove(); card.classList.remove('in-cart'); return; }
    if (!b) { b = document.createElement('span'); b.className = 'mc-qty'; card.appendChild(b); }
    b.textContent = n; card.classList.add('in-cart');
  });
}
$('#takeOrderMenuGrid').addEventListener('click', (e) => {
  const so = e.target.closest('[data-so-toggle]');
  if (so) { e.stopPropagation(); const it = boot.items.find(x => x.id === Number(so.dataset.soToggle)); if (it) setSoldOut(it.id, !it.sold_out); return; }
  const id = e.target.closest('[data-pick-item]');
  if (!id) return;
  const item = boot.items.find(x => x.id === parseInt(id.dataset.pickItem, 10));
  if (!item || item.sold_out) return;
  if (!item.option_groups || !item.option_groups.length) {
    const fresh = {menu_item_id:item.id,name:menuNames(item).main,unit_price:item.base_price,qty:1,selected_options:{},optionLabels:[],notes:''};
    if (item.open_price) { openLineEditor(-1, fresh); return; }   // seafood by weight…: price first
    const found=cart.find(c=>c.menu_item_id===item.id && !c.optionLabels.length && !c.notes && !c.takeaway && c.price == null);
    if(found) found.qty += 1; else cart.push(fresh);
    renderCart(); return;
  }
  openItemOptionPicker(item);
});
// Sold out in one tap (undo in the toast); every POS, tablet, kitchen and QR page follows within seconds.
async function setSoldOut(id, flag, undo = true) {
  const it = boot.items.find(x => x.id === id); if (!it) return;
  const prev = !!it.sold_out; it.sold_out = flag; refreshSoldOutViews();
  try { await apiJson('/api/menu-items/' + id + '/sold-out', 'PUT', { sold_out: flag }); }
  catch (e) { it.sold_out = prev; refreshSoldOutViews(); toast(e.message, 'err'); return; }
  if (undo) toastAction(`${menuNames(it).main} · ${flag ? 'หมดแล้ว (ทุกเครื่องเห็น)' : 'กลับมาขายแล้ว'}`, 'เลิกทำ', () => setSoldOut(id, prev, false));
}
function refreshSoldOutViews() {
  if ($('#takeOrderModal').classList.contains('show')) { renderTakeOrderMenu(); renderCart(); }
  if (activeTab() === 'menu') renderMenu();
}
function applySoldOutIds(ids) {
  if (!Array.isArray(ids) || !boot) return;
  const set = new Set(ids); let changed = false;
  branchItems().forEach(it => { const f = set.has(it.id); if (!!it.sold_out !== f) { it.sold_out = f; changed = true; } });
  if (changed) refreshSoldOutViews();
}
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
  const line = { menu_item_id: item.id, name: menuNames(item).main, unit_price: unitPrice, qty, selected_options: selected, optionLabels: labels, notes: $('#itemOptionNotes').value.trim() };
  $('#itemOptionModal').classList.remove('show');
  if (item.open_price) { openLineEditor(-1, line); return; }
  cart.push(line); renderCart();
});

function billOrder() { return addItemsOrderId ? findOrderById(addItemsOrderId) : null; }
function renderBillHead() {
  const o = billOrder();
  let title, sub = [];
  if (o) {
    title = o.table_name_snapshot || orderTypeLabel(o.order_type);
    sub.push('#' + o.order_no);
    if (o.guest_count) sub.push(`ลูกค้า ${o.guest_count} คน`);
  } else if (takeOrderType === 'dine_in') {
    const tb = boot.tables.find(x => String(x.id) === $('#takeOrderTable').value);
    title = tb ? tb.name : t('label_table');
    const g = parseInt($('#takeOrderGuestCount').value, 10); if (g) sub.push(`ลูกค้า ${g} คน`);
    sub.push('ออเดอร์ใหม่');
  } else {
    title = orderTypeLabel(takeOrderType); sub.push('ออเดอร์ใหม่');
  }
  $('#billTitle').textContent = title; $('#billSub').textContent = sub.join(' · ');
  $('#billManageBtn').classList.toggle('hidden', !o);
  $('#billRushBtn').classList.toggle('hidden', !o || !rushableItems(o).length);
}
function renderCart() {
  const o = billOrder();
  renderBillHead();
  // Items already on this bill (read-only here; edits/cancel go through "จัดการบิล").
  const existing = o ? o.items.filter(it => Number(it.quantity || 0) - Number(it.cancelled_quantity || 0) > 0) : [];
  let existingTotal = 0, existingQty = 0;
  $('#billExisting').innerHTML = existing.length ? `<div class="bill-group-label">สั่งแล้ว</div>` + existing.map(it => {
    const q = Number(it.quantity || 0) - Number(it.cancelled_quantity || 0), line = q * Number(it.unit_price || 0);
    existingTotal += line; existingQty += q;
    const state = it.kitchen_sent_at ? `<i class="ic ic-chef-hat" aria-hidden="true" title="ส่งครัวแล้ว"></i>` : `<i class="ic ic-clock" aria-hidden="true" title="ยังไม่ส่งครัว"></i>`;
    return `<div class="bill-line is-sent" data-bill-item="${it.id}" role="button" tabindex="0" title="แตะเพื่อ เร่ง / ห่อ / แก้ราคา"><span class="bl-qty">${q}×</span><div class="bl-name">${escapeHtml(it.item_name_snapshot)}${it.options && it.options.length ? `<small>${it.options.map(x => escapeHtml(x.option_name_snapshot)).join(', ')}</small>` : ''}${it.notes ? `<small>${escapeHtml(it.notes)}</small>` : ''}${itemTagsHtml(it)}</div><span class="bl-state">${state}</span><span class="bl-price">${!Number(it.unit_price || 0) && it.price_reason ? 'แถม' : fmtMoney(line)}</span></div>`;
  }).join('') : '';
  let total = 0, qty = 0;
  $('#takeOrderCart').innerHTML = (cart.length ? (existing.length ? `<div class="bill-group-label">เพิ่มใหม่</div>` : '') + cart.map((c, idx) => {
    const unit = cartUnit(c), lineTotal = unit * c.qty, special = cartSpecial(c); total += lineTotal; qty += c.qty;
    const tags = [c.takeaway ? `<span class="bl-tag bl-tag-take"><i class="ic ic-shopping-bag" aria-hidden="true"></i> ห่อ</span>` : '',
      special ? `<span class="bl-tag ${unit === 0 ? 'bl-tag-free' : 'bl-tag-price'}">${unit === 0 ? 'แถม' : escapeHtml(c.price_reason || 'ราคาพิเศษ')}</span>` : ''].join('');
    return `<div class="bill-line">
      <div class="bl-steps"><button type="button" data-cart-minus="${idx}" aria-label="ลด"><i class="ic ic-minus" aria-hidden="true"></i></button><b>${c.qty}</b><button type="button" data-cart-plus="${idx}" aria-label="เพิ่ม"><i class="ic ic-plus" aria-hidden="true"></i></button></div>
      <button type="button" class="bl-name bl-edit" data-cart-edit="${idx}" title="แตะเพื่อ หมายเหตุ / ห่อ / ราคา"><b>${escapeHtml(c.name)}</b>${c.optionLabels.length ? `<small>${c.optionLabels.map(escapeHtml).join(', ')}</small>` : ''}${c.notes ? `<small>${escapeHtml(t('label_notes'))}: ${escapeHtml(c.notes)}</small>` : `<small class="bl-hint">+ หมายเหตุ / ห่อ / ราคา</small>`}${tags ? `<span class="bl-tags">${tags}</span>` : ''}${(boot.items.find(x => x.id === c.menu_item_id) || {}).sold_out ? `<small class="bl-warn"><i class="ic ic-ban" aria-hidden="true"></i> เมนูนี้หมดแล้ว — ลบออกก่อนบันทึก</small>` : ''}</button>
      <span class="bl-price">${special ? `<s>${fmtMoney(c.unit_price * c.qty)}</s>` : ''}${unit === 0 && special ? 'แถม' : fmtMoney(lineTotal)}</span>
    </div>`;
  }).join('') : (existing.length ? '' : `<div class="bill-empty"><i class="ic ic-utensils" aria-hidden="true"></i><span>${escapeHtml(t('empty_cart_staff'))}</span></div>`));
  const rows = [[`รวมรายการ ${existingQty + qty}`, fmtMoney(existingTotal + total)]];
  if (o) {
    if (Number(o.discount_amount || 0) > 0) rows.push(['ส่วนลด', '−' + fmtMoney(o.discount_amount)]);
    if (Number(o.delivery_fee || 0) > 0) rows.push(['ค่าส่ง', fmtMoney(o.delivery_fee)]);
  } else if (takeOrderType === 'delivery' && Number($('#takeOrderDeliveryFee').value || 0) > 0) rows.push(['ค่าส่ง', fmtMoney(Number($('#takeOrderDeliveryFee').value || 0))]);
  const extra = o ? Number(o.delivery_fee || 0) - Number(o.discount_amount || 0) : (takeOrderType === 'delivery' ? Number($('#takeOrderDeliveryFee').value || 0) : 0);
  $('#billSum').innerHTML = rows.map(([a, b]) => `<div class="row"><span>${escapeHtml(a)}</span><span>${b}</span></div>`).join('') + `<div class="row muted-row"><span>ภาษี / ค่าบริการ</span><span>คิดตอนชำระเงิน</span></div>`;
  $('#takeOrderTotal').textContent = fmtMoney(existingTotal + total + extra);
  const submit = $('#takeOrderSubmit');
  if (!submit.disabled) submit.innerHTML = cart.length ? (o ? `<i class="ic ic-chef-hat" aria-hidden="true"></i> เพิ่ม ${qty} รายการ` : `<i class="ic ic-save" aria-hidden="true"></i> บันทึกบิล`) : 'บันทึกบิล';
  submit.disabled = false;
  $('#billPayBtn').disabled = !o && !cart.length;
  $('#billNoteBtn').classList.toggle('hidden', !!o);
  updateTakeOrderFeedback();
  saveDraft();
}
$('#takeOrderDeliveryFee').addEventListener('input', renderCart);
$('#takeOrderCart').addEventListener('click', (e) => {
  const ed = e.target.closest('[data-cart-edit]'); if (ed) { openLineEditor(Number(ed.dataset.cartEdit)); return; }
  const b = e.target.closest('[data-cart-minus],[data-cart-plus]'); if (!b) return;
  const mi = b.dataset.cartMinus, pl = b.dataset.cartPlus;
  if (mi !== undefined) { const c = cart[Number(mi)]; if (c.qty <= 1) cart.splice(Number(mi), 1); else c.qty -= 1; }
  if (pl !== undefined) cart[Number(pl)].qty = Math.min(99, cart[Number(pl)].qty + 1);
  renderCart();
});

// ---- One dish in the cart: note (typed or quick buttons), takeaway, special price / free ----
function cartUnit(c) { return c.price != null ? Number(c.price) : Number(c.unit_price || 0); }
function isOpenPrice(id) { return !!(boot.items.find(x => x.id === id) || {}).open_price; }
function cartSpecial(c) { return c.price != null && !isOpenPrice(c.menu_item_id) && Number(c.price) !== Number(c.unit_price); }
function cartLinePayload(c) {
  const out = { menu_item_id: c.menu_item_id, quantity: c.qty, selected_options: c.selected_options, notes: c.notes };
  if (c.price != null) { out.price = Number(c.price); if (c.price_reason) out.price_reason = c.price_reason; }
  if (c.takeaway) out.takeaway = true;
  return out;
}
function quickNotes() { const q = (boot.quick_notes || {})[String(currentBranchId)]; return Array.isArray(q) ? q : []; }
function noteParts(v) { return String(v || '').split(/\s*,\s*/).map(x => x.trim()).filter(Boolean); }
let leState = null;
function openLineEditor(idx, fresh) {
  const c = idx >= 0 ? cart[idx] : fresh; if (!c) return;
  const item = boot.items.find(x => x.id === c.menu_item_id) || {};
  leState = { idx, c: JSON.parse(JSON.stringify(c)), open: !!item.open_price };
  $('#leTitle').textContent = c.name;
  $('#leSub').textContent = [menuNames(item).sub, ...(c.optionLabels || [])].filter(Boolean).join(' · ');
  $('#leQty').textContent = c.qty; $('#leNote').value = c.notes || ''; renderLeChips();
  $('#leTakeaway').classList.toggle('active', !!c.takeaway);
  $('#leMenuPrice').textContent = leState.open ? 'ใส่ราคาตอนสั่ง' : 'ราคาเมนู ' + fmtMoney(c.unit_price);
  $('#lePrice').value = c.price != null ? c.price : (leState.open ? '' : c.unit_price);
  $('#lePriceReason').value = c.price_reason || ''; $('#leResetPrice').classList.toggle('hidden', leState.open); $('#leFree').classList.toggle('hidden', leState.open);
  $('#leRemove').classList.toggle('hidden', idx < 0); $('#leError').textContent = '';
  $('#leSave').textContent = idx < 0 ? 'ใส่ในบิล' : 'ตกลง';
  syncLePrice(); openModal('#lineEditModal');
  if (leState.open) setTimeout(() => $('#lePrice').focus(), 80);
}
function renderLeChips() {
  const parts = noteParts($('#leNote').value);
  $('#leChips').innerHTML = quickNotes().map(q => `<button type="button" class="le-chip ${parts.includes(q) ? 'active' : ''}" data-qn="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('');
}
$('#leChips').addEventListener('click', e => {
  const b = e.target.closest('[data-qn]'); if (!b) return;
  const q = b.dataset.qn; let parts = noteParts($('#leNote').value);
  parts = parts.includes(q) ? parts.filter(x => x !== q) : [...parts, q];
  $('#leNote').value = parts.join(', '); renderLeChips();
});
$('#leNote').addEventListener('input', renderLeChips);
function lePriceValue() { const v = $('#lePrice').value.trim(); return v === '' ? null : Number(v); }
function syncLePrice() {
  if (!leState) return;
  const p = lePriceValue(), menu = Number(leState.c.unit_price);
  const changed = !leState.open && p != null && !isNaN(p) && p !== menu, lower = changed && p < menu;
  $('#lePriceReason').classList.toggle('hidden', !changed);
  $('#lePriceReason').placeholder = p === 0 ? 'ของแถม' : 'เหตุผล เช่น ลูกค้าประจำ';
  $('#lePriceHint').textContent = lower && staffNeedsApproval() && !approvalToken() ? `ต่ำกว่าราคาเมนู (${fmtMoney(menu)}) · ผู้จัดการต้องอนุมัติ` : changed ? `ราคาเมนู ${fmtMoney(menu)}` : '';
  $('#leFree').classList.toggle('active', p === 0);
}
$('#lePrice').addEventListener('input', syncLePrice);
$('#leFree').addEventListener('click', () => { $('#lePrice').value = '0'; if (!$('#lePriceReason').value) $('#lePriceReason').value = 'ของแถม'; syncLePrice(); });
$('#leResetPrice').addEventListener('click', () => { $('#lePrice').value = leState.c.unit_price; $('#lePriceReason').value = ''; syncLePrice(); });
$('#leMinus').addEventListener('click', () => { $('#leQty').textContent = Math.max(1, Number($('#leQty').textContent) - 1); });
$('#lePlus').addEventListener('click', () => { $('#leQty').textContent = Math.min(50, Number($('#leQty').textContent) + 1); });
$('#leTakeaway').addEventListener('click', () => $('#leTakeaway').classList.toggle('active'));
$('#leRemove').addEventListener('click', () => { if (leState && leState.idx >= 0) cart.splice(leState.idx, 1); $('#lineEditModal').classList.remove('show'); leState = null; renderCart(); });
$('#leSave').addEventListener('click', async () => {
  if (!leState) return;
  const c = leState.c, p = lePriceValue(); $('#leError').textContent = '';
  if (p != null && (isNaN(p) || p < 0)) { $('#leError').textContent = 'ราคาไม่ถูกต้อง'; return; }
  if (leState.open && !(p > 0)) { $('#leError').textContent = 'ใส่ราคาของจานนี้ก่อน'; $('#lePrice').focus(); return; }
  c.qty = Number($('#leQty').textContent) || 1; c.notes = $('#leNote').value.trim().slice(0, 300); c.takeaway = $('#leTakeaway').classList.contains('active');
  if (leState.open) { c.price = p; c.price_reason = ''; }
  else if (p != null && p !== Number(c.unit_price)) {
    if (p < Number(c.unit_price) && staffNeedsApproval()) {
      const tok = await requestApproval(`${c.name}: ${fmtMoney(c.unit_price)} → ${p === 0 ? 'แถม' : fmtMoney(p)}`);
      if (!tok) return;
    }
    c.price = p; c.price_reason = $('#lePriceReason').value.trim() || (p === 0 ? 'ของแถม' : 'ราคาพิเศษ');
  } else { delete c.price; c.price_reason = ''; }
  if (leState.idx >= 0) cart[leState.idx] = c; else cart.push(c);
  $('#lineEditModal').classList.remove('show'); leState = null; renderCart();
});
$('#leNote').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#leSave').click(); } });

// ---- A dish already on the bill: rush, takeaway, special price / free, less, cancel ----
function itemTagsHtml(it) {
  const tags = [];
  if (it.rush_at) tags.push(`<span class="bl-tag bl-tag-rush"><i class="ic ic-flame" aria-hidden="true"></i> เร่ง</span>`);
  if (Number(it.takeaway)) tags.push(`<span class="bl-tag bl-tag-take"><i class="ic ic-shopping-bag" aria-hidden="true"></i> ห่อ</span>`);
  if (it.list_price != null && it.price_reason) tags.push(`<span class="bl-tag ${Number(it.unit_price) === 0 ? 'bl-tag-free' : 'bl-tag-price'}">${Number(it.unit_price) === 0 ? 'แถม' : escapeHtml(it.price_reason)}</span>`);
  return tags.length ? `<span class="bl-tags">${tags.join('')}</span>` : '';
}
function activeQtyOf(it) { return Math.max(0, Number(it.quantity || 0) - Number(it.cancelled_quantity || 0)); }
function rushableItems(o) { return ['served', 'completed', 'cancelled'].includes(o.status) ? [] : (o.items || []).filter(it => it.kitchen_sent_at && activeQtyOf(it) > 0); }
function afterKitchenNote(oid, r, msg) {
  if (r && r.kitchen_slip && !r.printed_by_server) printKitchenSlip(oid, r.kitchen_slip);
  toast(msg, 'ok'); onOrderActionDone();
}
async function rushOrder(oid, itemIds) {
  try { const r = await apiJson(`/api/orders/${oid}/rush`, 'POST', itemIds ? { item_ids: itemIds } : {}); afterKitchenNote(oid, r, `แจ้งครัวให้เร่ง ${r.item_ids.length} รายการแล้ว`); return true; }
  catch (e) { toast(e.message, 'err'); return false; }
}
$('#billRushBtn').addEventListener('click', () => { if (addItemsOrderId) rushOrder(addItemsOrderId); });
$('#billExisting').addEventListener('click', e => {
  const row = e.target.closest('[data-bill-item]'); if (row && addItemsOrderId) openLineTools(addItemsOrderId, Number(row.dataset.billItem));
});
let ltRef = null;
function openLineTools(oid, iid) {
  const o = findOrderById(oid), it = o && (o.items || []).find(x => x.id === iid); if (!it) return;
  ltRef = { oid, iid };
  const q = activeQtyOf(it), sent = !!it.kitchen_sent_at;
  const editable = o.payment_status === 'unpaid' && !['completed', 'cancelled'].includes(o.status);
  $('#ltTitle').textContent = `${q}× ${it.item_name_snapshot}`;
  $('#ltSub').innerHTML = [sent ? `ส่งครัว ${fmtClock(it.kitchen_sent_at)}` : 'ยังไม่ส่งครัว', it.rush_at ? `เร่งแล้ว ${fmtClock(it.rush_at)}` : '',
    `${Number(it.unit_price) === 0 && it.price_reason ? 'แถม' : fmtMoney(it.unit_price) + ' / จาน'}${it.list_price != null ? ` (ราคาเมนู ${fmtMoney(it.list_price)})` : ''}`,
    it.notes ? escapeHtml(it.notes) : ''].filter(Boolean).join(' · ');
  const btn = (act, icon, label, cls = '') => `<button type="button" class="lt-btn ${cls}" data-lt="${act}"><i class="ic ic-${icon}" aria-hidden="true"></i> ${label}</button>`;
  $('#ltGrid').innerHTML = [
    sent && rushableItems(o).some(x => x.id === iid) ? btn('rush', 'flame', 'เร่ง', 'rush') : '',
    editable ? btn('takeaway', 'shopping-bag', Number(it.takeaway) ? 'ไม่ห่อแล้ว' : 'ห่อกลับ', Number(it.takeaway) ? 'on' : '') : '',
    editable ? btn('price', 'tag', 'แก้ราคา / แถม') : '',
    editable && q > 1 ? btn('less', 'minus', 'ลดลง 1') : '',
    editable && q > 0 ? btn('cancel', 'circle-x', 'ยกเลิกจานนี้', 'danger') : '',
  ].join('') || `<p class="muted">บิลนี้ปิดแล้ว</p>`;
  $('#ltPriceBox').classList.add('hidden'); $('#ltError').textContent = '';
  openModal('#lineToolsModal');
}
function ltItem() { const o = ltRef && findOrderById(ltRef.oid); return o ? (o.items || []).find(x => x.id === ltRef.iid) : null; }
$('#ltGrid').addEventListener('click', async e => {
  const b = e.target.closest('[data-lt]'); if (!b || !ltRef) return;
  const { oid, iid } = ltRef, it = ltItem(); if (!it) return;
  const act = b.dataset.lt;
  if (act === 'rush') { b.disabled = true; if (await rushOrder(oid, [iid])) $('#lineToolsModal').classList.remove('show'); b.disabled = false; }
  else if (act === 'takeaway') {
    b.disabled = true;
    try { const r = await apiJson(`/api/orders/${oid}/items/${iid}/takeaway`, 'PUT', { takeaway: !Number(it.takeaway) });
      $('#lineToolsModal').classList.remove('show'); afterKitchenNote(oid, r, r.takeaway ? 'จานนี้ห่อกลับ' + (r.kitchen_slip ? ' · แจ้งครัวแล้ว' : '') : 'ยกเลิกห่อแล้ว'); }
    catch (err) { $('#ltError').textContent = err.message; b.disabled = false; }
  }
  else if (act === 'price') {
    $('#ltPriceBox').classList.remove('hidden');
    const menu = it.list_price != null ? it.list_price : it.unit_price;
    $('#ltMenuPrice').textContent = 'ราคาเมนู ' + fmtMoney(menu); $('#ltPrice').value = it.unit_price; $('#ltPriceReason').value = it.price_reason || '';
    $('#ltResetPrice').classList.toggle('hidden', it.list_price == null); setTimeout(() => $('#ltPrice').select(), 50);
  }
  else if (act === 'less') { $('#lineToolsModal').classList.remove('show'); reduceOrderItemQty(oid, iid, activeQtyOf(it) - 1); }
  else if (act === 'cancel') { $('#lineToolsModal').classList.remove('show'); cancelOrderItemCritical(oid, iid, activeQtyOf(it)); }
});
$('#ltFree').addEventListener('click', () => { $('#ltPrice').value = '0'; if (!$('#ltPriceReason').value) $('#ltPriceReason').value = 'ของแถม'; });
$('#ltResetPrice').addEventListener('click', () => { const it = ltItem(); if (it && it.list_price != null) { $('#ltPrice').value = it.list_price; $('#ltPriceReason').value = ''; } });
$('#ltPriceSave').addEventListener('click', async () => {
  const it = ltItem(); if (!it) return;
  const { oid, iid } = ltRef, raw = $('#ltPrice').value.trim(), p = Number(raw); $('#ltError').textContent = '';
  if (raw === '' || isNaN(p) || p < 0) { $('#ltError').textContent = 'ราคาไม่ถูกต้อง'; return; }
  const body = { price: p, reason: $('#ltPriceReason').value.trim() };
  if (p < Number(it.unit_price) && staffNeedsApproval()) {
    const tok = await requestApproval(`${it.item_name_snapshot}: ${fmtMoney(it.unit_price)} → ${p === 0 ? 'แถม' : fmtMoney(p)}`); if (!tok) return;
    body.approval_token = tok;
  }
  try { const r = await apiJson(`/api/orders/${oid}/items/${iid}/price`, 'PUT', body); $('#lineToolsModal').classList.remove('show');
    toast(r.unchanged ? 'ราคาเท่าเดิม' : p === 0 ? 'จานนี้แถมแล้ว' : `ราคาใหม่ ${fmtMoney(p)} / จาน`, 'ok'); onOrderActionDone(); }
  catch (err) { $('#ltError').textContent = err.message; }
});

// Saves the cart (new order or items added to the open bill). Returns the order id, or null when nothing was saved.
let takeOrderSaving = false;
async function submitTakeOrder(retried) {
  if (retried && typeof retried !== 'boolean') retried = false;   // called as a click handler
  $('#takeOrderError').textContent = '';
  if (!cart.length) { $('#takeOrderError').textContent = t('err_cart_empty_min1'); return null; }
  if (takeOrderSaving) return null; // already submitting — ignore extra clicks/taps
  const payload = {
    branch_id: currentBranchId, order_type: takeOrderType,
    customer_name: $('#takeOrderCustomerName').value.trim() || t('placeholder_customer_name'),
    cart: cart.map(cartLinePayload),
  };
  const notes = $('#takeOrderNotes').value.trim(); if (notes) payload.notes = notes;
  const guestCountRaw = $('#takeOrderGuestCount').value.trim();
  if (guestCountRaw) payload.guest_count = parseInt(guestCountRaw, 10);
  if (takeOrderType === 'dine_in') payload.table_id = parseInt($('#takeOrderTable').value, 10);
  if (takeOrderType !== 'dine_in') payload.scheduled_for = $('#takeOrderScheduledFor').value || null;
  if (takeOrderType === 'delivery') { payload.customer_phone = $('#takeOrderPhone').value.trim(); payload.customer_address = $('#takeOrderAddress').value.trim(); payload.delivery_fee = Number($('#takeOrderDeliveryFee').value || 0); }
  const btn = $('#takeOrderSubmit');
  takeOrderSaving = true; btn.disabled = true; $('#billPayBtn').disabled = true; btn.textContent = t('btn_submitting');
  try {
    const endpoint = addItemsOrderId ? `/api/orders/${addItemsOrderId}/items` : '/api/orders';
    const sendKitchen = $('#takeOrderSendKitchen').checked;
    try { localStorage.setItem('zaabos_send_kitchen', sendKitchen ? '1' : '0'); } catch (e) {}
    const sendPayload = addItemsOrderId ? {items: payload.cart, send_to_kitchen: sendKitchen} : {...payload,send_to_kitchen:sendKitchen,client_request_id:requestId(),client_device_id:deviceId()};
    if (cart.some(c => cartSpecial(c) && cartUnit(c) < Number(c.unit_price)) && approvalToken()) sendPayload.approval_token = approvalToken();
    let r;
    if (!addItemsOrderId && (!navigator.onLine || zaabosOfflineMode)) {
      await queueOfflineOrder(sendPayload); clearDraft(); closeModals(); toast('บันทึกออเดอร์ไว้ในเครื่องแล้ว · รอ Sync','ok'); addItemsOrderId=null; cart=[]; renderOfflineQueue(); return null;
    }
    try { r = await apiJson(endpoint, 'POST', sendPayload); }
    catch (netErr) {
      if (!addItemsOrderId && (!navigator.onLine || /เชื่อมต่อเซิร์ฟเวอร์|ระบบบันทึกข้อมูลขัดข้อง/.test(netErr.message))) {
        await queueOfflineOrder(sendPayload); clearDraft(); closeModals(); toast('Server ไม่พร้อม · เก็บออเดอร์ไว้ในเครื่องเพื่อ Sync แล้ว','ok'); addItemsOrderId=null; cart=[]; return null;
      }
      throw netErr;
    }
    const kitchenNote = r.sent_to_kitchen ? ' — ส่งเข้าครัวแล้ว' : ' — กรุณากดส่งเข้าครัว';
    clearDraft(); closeModals(); toast((addItemsOrderId ? 'เพิ่มรายการแล้ว' : t('toast_order_saved', { no: r.order_no })) + kitchenNote, 'ok');
    const sentOrderId = addItemsOrderId || r.order_id;
    addItemsOrderId = null; cart = [];
    await loadBoardData(); if (currentTab === 'history') loadOrders();
    // No Wi-Fi/USB kitchen printer on the shop PC: print the ticket from this browser as before.
    if (r.sent_to_kitchen && !r.printed_by_server && r.item_ids && r.item_ids.length) printKitchenTicket(sentOrderId, r.item_ids);
    // items with stock tracking just got decremented server-side — refresh the cached menu (boot.items)
    loadBootstrap().then(() => { if (activeTab() === 'menu') renderMenu(); });
    return sentOrderId;
  } catch (e) {
    if ((e.code === 'approval_required' || e.code === 'approval_expired') && !retried) {
      takeOrderSaving = false;
      const tok = await requestApproval('บิลนี้มีราคาพิเศษ / ของแถม — ให้ผู้จัดการอนุมัติ');
      if (tok) return await submitTakeOrder(true);
    }
    $('#takeOrderError').textContent = e.message; return null;
  }
  finally { takeOrderSaving = false; btn.disabled = false; $('#billPayBtn').disabled = false; if ($('#takeOrderModal').classList.contains('show')) renderCart(); }
}
$('#takeOrderSubmit').addEventListener('click', submitTakeOrder);
$('#billPayBtn').addEventListener('click', async () => {
  let id = addItemsOrderId;
  if (cart.length) id = await submitTakeOrder();
  else if (id) closeModals();
  if (!id) return;
  if (!findOrderById(id)) await loadBoardData();
  openConfirmPaymentModal(id);
});

function openAddItemsToOrder(orderId) {
  const ord=findOrderById(orderId); if(!ord) return;
  closeModals();
  addItemsOrderId=orderId;
  resetTakeOrderForm();
  takeOrderType=ord.order_type;
  $$('#takeOrderType button').forEach(b => b.classList.toggle('active', b.dataset.type === ord.order_type));
  $('#takeOrderTableRow').classList.add('hidden'); $('#takeOrderDeliveryFields').classList.add('hidden'); $('#takeOrderScheduleRow').classList.add('hidden');
  $('#takeOrderCustomerName').value=ord.customer_name||''; $('#takeOrderGuestCount').value=ord.guest_count||'';
  if(ord.table_id) $('#takeOrderTable').value=String(ord.table_id);
  restoreDraft();
  showTakeOrder();
}
async function openMoveTable(orderId) {
  const ord=findOrderById(orderId); if(!ord) return;
  openBillManager(orderId);
}

// ===================== Misc =====================

function emptyState(icon, text) { return `<div class="empty-state">${icon ? `<span class="es-ic">${icon}</span>` : ''}${escapeHtml(text)}</div>`; }

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
        $('#navUserAvatar').textContent=$('#whoAvatar').textContent;$('#navUserName').textContent=$('#whoName').textContent;$('#navUserRole').textContent=$('#whoRole').textContent;
        applyRoleVisibility(); buildMoreMenu(); renderBranchSelect(); switchTab('orders'); renderTableBoard(); renderOtherOrders(); renderSidePanel(); await renderOfflineQueue();
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
    const status=$('#shiftStatus'), actions=$('#shiftActionArea'), blind=me && me.role==='staff';
    if(sh){
      const opened=formatDateTime(sh.opened_at), pb=sum.payment_breakdown||{};
      status.innerHTML=`
        <div class="shift-state-card is-open"><span class="shift-dot"></span><div><small>สถานะ</small><b>กะเปิดอยู่</b><span class="shift-sub">${escapeHtml(opened)}</span></div></div>
        <div class="shift-state-card shift-kpi"><small>${blind?'จำนวนบิลในกะ':'ยอดรับชำระในกะ'}</small><b>${blind?Number(sum.bill_count||0):fmtMoney(sum.gross_received||0)}</b><span class="shift-sub">${blind?'ยังไม่แสดงยอดเงินก่อนนับเงินสด':Number(sum.bill_count||0)+' บิล'}</span></div>
        ${blind?'<div class="shift-state-card shift-kpi"><small>ยอดการเงิน</small><b>ซ่อนจนกว่าจะปิดกะ</b><span class="shift-sub">Blind Cash Count</span></div>':`<div class="shift-state-card shift-kpi"><small>เงินสด</small><b>${fmtMoney(pb.cash||0)}</b><span class="shift-sub">รับเงินจริงในกะนี้</span></div><div class="shift-state-card shift-kpi"><small>QR / โอน</small><b>${fmtMoney((pb.qr||0)+(pb.transfer||0)+(pb.bank_transfer||0))}</b><span class="shift-sub">ไม่รวมในลิ้นชักเงินสด</span></div><div class="shift-state-card shift-kpi"><small>คืนเงิน</small><b>${fmtMoney(sum.refund_total||0)}</b><span class="shift-sub">${Number(sum.refund_count||0)} รายการ</span></div><div class="shift-state-card shift-kpi accent"><small>ยอดสุทธิในกะ</small><b>${fmtMoney(sum.net_received||0)}</b><span class="shift-sub">รับชำระ − คืนเงิน</span></div>`}
        ${blind?'<div class="shift-state-card shift-kpi cash-expected"><small>เงินสดที่ควรมีในลิ้นชัก</small><b>••••••</b><span class="shift-sub">จะแสดงหลังยืนยันยอดนับจริง</span></div>':`<div class="shift-state-card shift-kpi cash-expected"><small>เงินสดที่ควรมีในลิ้นชัก</small><b>${fmtMoney(sum.expected_cash||0)}</b><span class="shift-sub">เริ่ม ${fmtMoney(sh.opening_cash)} · เข้า ${fmtMoney(sum.cash_in||0)} · ออก ${fmtMoney(sum.cash_out||0)}</span></div>`}
        <div class="shift-state-card"><small>พนักงาน</small><b>${escapeHtml(sh.opened_by_name||'')}</b><span class="shift-sub">กะนี้ไม่ตัดยอดตอน 00:00</span></div>`;
      actions.innerHTML=`<div class="shift-close-box"><div><b>ปิดกะ</b><div class="muted">ให้นับเงินจริงในลิ้นชักเพียงครั้งเดียว ระบบจะเทียบกับยอดที่ควรมีอัตโนมัติ</div></div><div class="shift-close-controls"><input id="shiftCountedCash" type="number" min="0" step="0.01" inputmode="decimal" placeholder="เงินสดนับจริง"><input id="shiftCloseNote" maxlength="300" placeholder="หมายเหตุ (ถ้ามี)"><button class="danger-btn" id="closeShiftBtn" type="button">ปิดกะ &amp; ตรวจยอด</button></div></div>`;
      $('#closeShiftBtn').onclick=()=>openCloseShiftConfirmation(sum);
    }else{
      status.innerHTML=`<div class="shift-state-card"><small>สถานะ</small><b>ยังไม่ได้เปิดกะ</b></div>`;
      actions.innerHTML=`<div class="shift-open-box"><div><b>เริ่มกะใหม่</b><div class="muted">กรอกเฉพาะเงินทอนที่มีอยู่จริงก่อนเริ่มขาย</div></div><div class="shift-open-controls"><input id="shiftOpeningCash" type="number" min="0" step="0.01" inputmode="decimal" placeholder="เงินทอนตั้งต้น"><input id="shiftOpenNote" maxlength="300" placeholder="หมายเหตุ (ถ้ามี)"><button class="save" id="openShiftBtn" type="button">เปิดกะ</button></div></div>`;
      $('#openShiftBtn').onclick=()=>opsPost('/api/operations/shift/open',{branch_id:currentBranchId,opening_cash:Number($('#shiftOpeningCash').value||0),notes:$('#shiftOpenNote').value});
    }
    $('#cashMovementList').innerHTML=data.movements.length?data.movements.map(m=>`<div class="list-row"><div><b>${m.movement_type==='cash_in'?'เงินเข้า':'เงินออก'}</b><div class="muted">${escapeHtml(m.reason)} · ${escapeHtml(formatDateTime(m.created_at))}</div></div><strong>${m.movement_type==='cash_in'?'+':'−'}${fmtMoney(m.amount)}</strong></div>`).join(''):emptyState('<i class="ic ic-banknote" aria-hidden="true"></i>','ยังไม่มีรายการเงินสดในกะนี้');
    loadShiftHistory();
    if(me && ['owner','manager'].includes(me.role)){const cr=await api('/api/operations/critical');$('#criticalOpsList').innerHTML=cr.length?cr.slice(0,50).map(x=>`<div class="list-row"><div><b>${escapeHtml(x.operation_type)}</b><div class="muted">${escapeHtml(x.reason)} · ทำโดย ${escapeHtml(x.performed_by_name||'')} · อนุมัติโดย ${escapeHtml(x.approved_by_name||'')}</div></div><small>${escapeHtml(formatDateTime(x.created_at))}</small></div>`).join(''):emptyState('<i class="ic ic-shield" aria-hidden="true"></i>','ยังไม่มีรายการอนุมัติ');}
  }catch(e){toast(e.message,'err')}
}
let pendingCloseShift=null;
function openCloseShiftConfirmation(sum={}){
  const countedEl=$('#shiftCountedCash'), noteEl=$('#shiftCloseNote');
  if(!countedEl)return;
  const raw=String(countedEl.value||'').trim();
  if(raw===''){toast('กรุณานับและกรอกเงินสดจริงก่อนปิดกะ','err');countedEl.focus();return;}
  const counted=Number(raw), blind=me && me.role==='staff', expected=Number(sum.expected_cash||0);
  if(!Number.isFinite(counted)||counted<0){toast('ยอดเงินสดนับจริงไม่ถูกต้อง','err');countedEl.focus();return;}
  const notes=(noteEl?.value||'').trim();
  pendingCloseShift={branch_id:currentBranchId,counted_cash:counted,notes};
  $('#shiftConfirmExpected').textContent=blind?'จะแสดงหลังปิดกะ':fmtMoney(expected);
  $('#shiftConfirmCounted').textContent=fmtMoney(counted);
  $('#shiftConfirmDiff').textContent=blind?'จะแสดงหลังปิดกะ':fmtMoney(counted-expected);
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
async function loadShiftHistory(){const el=$('#shiftHistoryList');if(!el)return;try{const rows=await api('/api/operations/shifts?branch_id='+currentBranchId);el.innerHTML=rows.length?rows.map(x=>`<div class="list-row shift-history-row"><div><b>${escapeHtml(formatDateTime(x.closed_at))}</b><div class="muted">${escapeHtml(x.opened_by_name||'')} · ${Number(x.summary?.bill_count||0)} บิล · สุทธิ ${fmtMoney(x.summary?.net_received||0)}</div></div><button class="ghost-btn" data-print-shift="${x.id}"><i class="ic ic-receipt" aria-hidden="true"></i> พิมพ์</button></div>`).join(''):emptyState('<i class="ic ic-receipt" aria-hidden="true"></i>','ยังไม่มีประวัติกะที่ปิด');el.onclick=async e=>{const b=e.target.closest('[data-print-shift]');if(!b)return;const x=rows.find(r=>String(r.id)===String(b.dataset.printShift));if(x)await printShiftCloseReport({...x,expected_cash:x.expected_cash,counted_cash:x.counted_cash,difference:x.difference})}}catch(e){el.innerHTML=`<div class="error-text">${escapeHtml(e.message)}</div>`}}

$('#refreshOpsBtn').onclick=loadOperations;
$('#cashInBtn').onclick=()=>opsPost('/api/operations/cash-movement',{branch_id:currentBranchId,movement_type:'cash_in',amount:Number($('#opsAmount').value||0),reason:$('#opsReason').value});
$('#cashOutBtn').onclick=()=>opsPost('/api/operations/cash-movement',{branch_id:currentBranchId,movement_type:'cash_out',amount:Number($('#opsAmount').value||0),reason:$('#opsReason').value});

// Round 14D pricing / promotions
let receiptSettingsCache={};
function rsEl(id){return document.getElementById(id)}
function rsValue(id,fallback=''){const el=rsEl(id);return el&&typeof el.value==='string'?el.value:fallback}
function rsChecked(id,fallback=true){const el=rsEl(id);return el?!!el.checked:fallback}
function readReceiptSettingsForm(){return{branch_id:currentBranchId,menu_lang_primary:rsValue('rsMenuLang1',''),menu_lang_secondary:rsValue('rsMenuLang2',''),shop_name:rsValue('rsShopName').trim(),branch_name:rsValue('rsBranchName').trim(),subtitle:rsValue('rsSubtitle').trim(),address:rsValue('rsAddress').trim(),phone:rsValue('rsPhone').trim(),tax_id:rsValue('rsTaxId').trim(),footer:rsValue('rsFooter').trim(),paper_width:rsValue('rsPaper','80'),font_scale:rsValue('rsFont','normal'),header_align:rsValue('rsAlign','center'),show_branch:rsChecked('rsShowBranch'),show_guest:rsChecked('rsShowGuest'),show_cashier:rsChecked('rsShowCashier'),show_payment_breakdown:rsChecked('rsShowPayments'),show_order_time:rsChecked('rsShowOrderTime'),show_paid_time:rsChecked('rsShowPaidTime'),receipt_printer_route:rsValue('rsReceiptPrinterRoute','front'),kitchen_printer_route:rsValue('rsKitchenPrinterRoute','kitchen'),kitchen_auto_queue:rsChecked('rsKitchenAutoQueue'),day_cutoff_hour:rsValue('rsDayCutoff','0'),quick_notes:rsValue('rsQuickNotes','')}}
let receiptPreviewMode='receipt';
function renderReceiptSettingsPreview(){const r=readReceiptSettingsForm(),el=$('#receiptSettingsPreview');if(!el)return;el.className=`receipt-settings-preview paper-${r.paper_width} font-${r.font_scale} head-${r.header_align} preview-${receiptPreviewMode}`;const title=$('#receiptPreviewTitle');if(receiptPreviewMode==='kitchen'){if(title)title.textContent='ตัวอย่างใบสั่งห้องครัว';el.innerHTML=`<div class="rp-brand">KITCHEN ORDER</div>${r.show_branch&&r.branch_name?`<div class="rp-center">${escapeHtml(r.branch_name)}</div>`:''}<div class="rp-sep"></div><div class="kp-order"><b>#Z-20260921-0058</b><strong>โต๊ะ 4</strong></div><div class="kp-time">20:45 · รับออเดอร์แล้ว</div><div class="rp-sep"></div><div class="kp-item"><b>2×</b><span>ข้าวผัดตัวอย่าง<small>ไม่ใส่เผ็ด · เพิ่มไข่</small></span></div><div class="kp-item"><b>1×</b><span>น้ำตัวอย่าง</span></div><div class="rp-sep"></div><div class="kp-note"><b>หมายเหตุ</b><br>ตัวอย่างหมายเหตุจากลูกค้า</div><div class="rp-powered">ZaabOS · Kitchen</div>`;return}if(title)title.textContent='ตัวอย่างใบเสร็จหน้าร้าน';el.innerHTML=`<div class="rp-brand">${escapeHtml(r.shop_name||'ชื่อร้าน')}</div>${r.subtitle?`<div class="rp-brand-sub">${escapeHtml(r.subtitle)}</div>`:''}${r.show_branch&&r.branch_name?`<div class="rp-center">${escapeHtml(r.branch_name)}</div>`:''}${r.address?`<div class="rp-center rp-shop-detail">${escapeHtml(r.address)}</div>`:''}${r.phone?`<div class="rp-center rp-shop-detail">${escapeHtml(r.phone)}</div>`:''}<div class="rp-sep"></div><div class="rp-meta"><span>โต๊ะ</span><b>โต๊ะ 4</b>${r.show_guest?'<span>ลูกค้า</span><b>3</b>':''}</div><table class="rp-items"><tbody><tr><td>1</td><td>เมนูตัวอย่าง</td><td class="rp-price">₭50,000</td></tr></tbody></table><div class="rp-sep"></div><div class="rp-total"><span>รวม</span><span>₭50,000</span></div>${r.show_payment_breakdown?'<div class="rp-row"><span>Cash</span><span>₭50,000</span></div>':''}<div class="rp-thanks">${escapeHtml(r.footer||'ขอบใจที่ใช้บริการ')}</div><div class="rp-powered">ZaabOS</div>`}
$('#receiptPreviewSwitch')?.addEventListener('click',e=>{const b=e.target.closest('[data-preview-mode]');if(!b)return;receiptPreviewMode=b.dataset.previewMode;$('#receiptPreviewSwitch').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));renderReceiptSettingsPreview()});
async function loadReceiptSettings(){if(!currentBranchId)return;try{const r=await api('/api/settings/receipt?branch_id='+currentBranchId);receiptSettingsCache=r;const vals={rsShopName:r.shop_name||'',rsBranchName:r.branch_name||'',rsSubtitle:r.subtitle||'',rsAddress:r.address||'',rsPhone:r.phone||'',rsTaxId:r.tax_id||'',rsFooter:r.footer||'',rsPaper:r.paper_width||'80',rsFont:r.font_scale||'normal',rsAlign:r.header_align||'center',rsReceiptPrinterRoute:r.receipt_printer_route||'front',rsMenuLang1:r.menu_lang_primary||'',rsMenuLang2:r.menu_lang_secondary||'',rsKitchenPrinterRoute:r.kitchen_printer_route||'kitchen',rsDayCutoff:String(r.day_cutoff_hour||'0'),rsQuickNotes:r.quick_notes||''};Object.entries(vals).forEach(([id,v])=>{const el=rsEl(id);if(el)el.value=v});const checks={rsShowBranch:r.show_branch!==false,rsShowGuest:r.show_guest!==false,rsShowCashier:r.show_cashier!==false,rsShowPayments:r.show_payment_breakdown!==false,rsShowOrderTime:r.show_order_time!==false,rsShowPaidTime:r.show_paid_time!==false,rsKitchenAutoQueue:r.kitchen_auto_queue!==false};Object.entries(checks).forEach(([id,v])=>{const el=rsEl(id);if(el)el.checked=v});renderReceiptSettingsPreview()}catch(e){toast(e.message,'err')}}
$('#tab-receiptsettings').addEventListener('input',renderReceiptSettingsPreview);$('#tab-receiptsettings').addEventListener('change',renderReceiptSettingsPreview);$('#saveReceiptSettingsBtn').onclick=async()=>{try{const r=await apiJson('/api/settings/receipt','PUT',readReceiptSettingsForm());receiptSettingsCache=r.settings||{};if(boot){boot.day_cutoff=boot.day_cutoff||{};boot.day_cutoff[String(currentBranchId)]=Number(receiptSettingsCache.day_cutoff_hour||0);loadBootstrap().catch(()=>{});}toast('บันทึกการตั้งค่าร้านและใบเสร็จแล้ว','ok');renderReceiptSettingsPreview()}catch(e){toast(e.message,'err')}};

async function loadPricing(){
  if(!currentBranchId) return;
  try{
    const st=await api('/api/pricing/settings?branch_id='+currentBranchId);
    $('#pricingTax').value=st.tax_rate||0; $('#pricingService').value=st.service_charge_rate||0;
    const promos=await api('/api/promotions');
    $('#promotionsList').innerHTML=promos.length?promos.map(x=>`<div class="list-card"><div><b>${escapeHtml(x.code)}</b> · ${escapeHtml(x.name)}<br><small>${x.discount_type==='percent'?x.discount_value+'%':fmtMoney(x.discount_value)} · ขั้นต่ำ ${fmtMoney(x.min_spend||0)} ${x.active?'':'· ปิดแล้ว'}</small></div>${x.active?`<button class="icon-btn danger" data-disable-promo="${x.id}">×</button>`:''}</div>`).join(''):emptyState('<i class="ic ic-tag" aria-hidden="true"></i>','ยังไม่มีโปรโมชั่น');
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
    $('#ingredientsList').innerHTML=rows.length?rows.map(x=>`<div class="ingredient-row ${Number(x.stock_qty)<=Number(x.low_stock_threshold)?'low':''}"><div><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.unit)} · เตือนที่ ${x.low_stock_threshold}</small></div><strong>${Number(x.stock_qty).toLocaleString()}</strong><button class="ghost-btn" data-ing-adjust="${x.id}">ปรับ</button></div>`).join(''):emptyState('<i class="ic ic-package" aria-hidden="true"></i>','ยังไม่มีวัตถุดิบ');
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
loadInventory=async function(){await _r17LoadInventory();const rows=await api('/api/inventory/ingredients?branch_id='+currentBranchId);$('#ingredientsList').innerHTML=rows.length?rows.map(x=>`<div class="ingredient-row ${Number(x.stock_qty)<=Number(x.low_stock_threshold)?'low':''}"><div><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.unit)} · เตือนที่ ${x.low_stock_threshold}</small></div><strong>${Number(x.stock_qty).toLocaleString()}</strong><div class="ingredient-actions"><button class="ghost-btn" data-ing-adjust="${x.id}">ปรับ</button><button class="ghost-btn" data-ing-waste="${x.id}">ของเสีย</button><button class="ghost-btn" data-ing-count="${x.id}">ตรวจนับ</button></div></div>`).join(''):emptyState('<i class="ic ic-package" aria-hidden="true"></i>','ยังไม่มีวัตถุดิบ');};
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


// ---------- Step 3: shop printers (USB or Wi-Fi) printed by the shop PC ----------
let npPrinters=[], npUsb=[], npNet=[];
const npWhere=p=>p.connection==='system'?'USB':(p.host+':'+p.port);
function npRenderAssign(){
  const opts=sel=>`<option value="">— หน้าต่าง Print ของเบราว์เซอร์ —</option>`+npPrinters.filter(p=>!p.station_id).map(p=>`<option value="${p.id}">${escapeHtml(p.name)} · ${escapeHtml(npWhere(p))}</option>`).join('');
  for(const [id,job] of [['#npAssignReceipt','receipt'],['#npAssignKitchen','kitchen']]){
    const cur=npPrinters.find(p=>!p.station_id&&(p.role===job||p.role==='both'));
    $(id).innerHTML=opts();$(id).value=cur?String(cur.id):'';
  }
}
function npRenderFound(){
  const have=new Set(npPrinters.map(p=>p.connection==='system'?'usb:'+p.host:'net:'+p.host));
  const row=(u,other)=>({key:'usb:'+u.queue,icon:iconHtml('plug'),title:u.label,sub:other?'เครื่องพิมพ์ทั่วไป — ไม่ใช่เครื่องพิมพ์ใบเสร็จ':'USB ต่อกับเครื่องนี้',other,add:{connection:'system',host:u.queue,name:u.label}});
  // Receipt printers first; office/photo/label printers only on request (easy to pick by mistake).
  const rows=[...npUsb.filter(u=>u.receipt_like!==false).map(u=>row(u,false)),
              ...npNet.map(n=>({key:'net:'+n.host,icon:iconHtml('wifi'),title:'เครื่องพิมพ์ Wi‑Fi',sub:n.host,add:{connection:'network',host:n.host,port:9100,name:'Wi‑Fi '+n.host}})),
              ...npUsb.filter(u=>u.receipt_like===false).map(u=>row(u,true))].filter(r=>!have.has(r.key));
  const main=rows.filter(r=>!r.other),others=rows.filter(r=>r.other);
  const html=r=>`<div class="np-found${r.other?' np-other':''}"><div><b>${r.icon} ${escapeHtml(r.title)}</b><small>${escapeHtml(r.sub)}</small></div><button class="${r.other?'ghost-btn':'save settings-save-compact'}" data-np-found="${rows.indexOf(r)}" type="button">ใช้เครื่องนี้</button></div>`;
  $('#npFound').innerHTML=(main.length?main.map(html).join(''):`<div class="muted printer-help">ยังไม่พบเครื่องพิมพ์ใบเสร็จ — เสียบสาย USB แล้วเปิดหน้านี้ใหม่ หรือกดค้นหา Wi‑Fi</div>`)+
    (others.length?`<details class="np-others"><summary>แสดงเครื่องพิมพ์อื่น (${others.length})</summary>${others.map(html).join('')}</details>`:'');
  $('#npFound')._rows=rows;
}
async function loadNetPrinters(){
  if(!currentBranchId)return;
  try{
    const [r,d]=await Promise.all([api('/api/printers?branch_id='+currentBranchId),api('/api/printers/discover').catch(()=>({usb:[],network:[],local:false}))]);
    npPrinters=r.printers||[];npUsb=d.usb||[];
    $('#npMode').textContent=r.local?'พิมพ์ตรงถึงเครื่องพิมพ์ในร้าน (USB หรือ Wi‑Fi) โดยไม่ขึ้นหน้าต่าง Print':'ตอนนี้เปิดจากคลาวด์ — พิมพ์ตรงได้เมื่อเปิดโปรแกรม ZaabOS บนเครื่องในร้าน';
    $('#npScanBtn').classList.toggle('hidden',!r.local);
    npRenderAssign();npRenderFound();
    $('#npList').innerHTML=npPrinters.length?npPrinters.map(p=>{const jobs=[(p.role==='receipt'||p.role==='both')&&'ใบเสร็จ',(p.role==='kitchen'||p.role==='both')&&'ครัว'].filter(Boolean).join(' + ')||'ยังไม่ได้ใช้';return `<div class="np-row"><div><b>${p.connection==='system'?'<i class="ic ic-plug" aria-hidden="true"></i>':'<i class="ic ic-wifi" aria-hidden="true"></i>'} ${escapeHtml(p.name)}</b><small>${escapeHtml(npWhere(p))} · ${p.paper_width} mm · ${jobs}${p.station_name?' · '+escapeHtml(p.station_name):''}</small></div><div class="np-actions"><button class="ghost-btn" data-np-test="${p.id}">พิมพ์ทดสอบ</button><button class="icon-btn danger" data-np-del="${p.id}" title="ลบ">×</button></div></div>`}).join(''):emptyState('<i class="ic ic-printer" aria-hidden="true"></i>','ยังไม่มีเครื่องพิมพ์ — เลือกจากรายการด้านล่างได้เลย');
  }catch(e){toast(e.message,'err')}
}
async function npAdd(payload){
  const r=await apiJson('/api/printers','POST',{branch_id:currentBranchId,role:'none',paper_width:'80',...payload});
  // First printer in the shop: use it for both receipts and kitchen right away.
  for(const job of ['receipt','kitchen']){if(!npPrinters.some(p=>!p.station_id&&(p.role===job||p.role==='both')))await apiJson('/api/printers/assign','PUT',{branch_id:currentBranchId,job,printer_id:r.id});}
  toast('บันทึกเครื่องพิมพ์แล้ว — กด "พิมพ์ทดสอบ" เพื่อเช็ก','ok');await loadNetPrinters();
}
document.querySelectorAll('[data-np-assign]').forEach(sel=>sel.addEventListener('change',async()=>{try{await apiJson('/api/printers/assign','PUT',{branch_id:currentBranchId,job:sel.dataset.npAssign,printer_id:sel.value?Number(sel.value):null});toast('บันทึกแล้ว','ok');loadNetPrinters()}catch(e){toast(e.message,'err')}}));
$('#npFound').addEventListener('click',async e=>{const b=e.target.closest('[data-np-found]');if(!b)return;b.disabled=true;try{await npAdd($('#npFound')._rows[Number(b.dataset.npFound)].add)}catch(err){toast(err.message,'err');b.disabled=false}});
$('#npScanBtn').addEventListener('click',async()=>{const b=$('#npScanBtn');b.disabled=true;b.textContent='กำลังค้นหา… (ประมาณ 3 วินาที)';try{const d=await api('/api/printers/discover?network=1');npUsb=d.usb||[];npNet=d.network||[];npRenderFound();if(!npNet.length)toast('ไม่พบเครื่องพิมพ์ Wi‑Fi — เครื่องพิมพ์ต้องต่อ Wi‑Fi เดียวกับ Mac ก่อน','err')}catch(e){toast(e.message,'err')}finally{b.disabled=false;b.textContent='ค้นหาเครื่องพิมพ์ Wi‑Fi ในร้าน'}});
$('#npAddIpBtn').addEventListener('click',async()=>{const host=$('#npHost').value.trim();try{await npAdd({connection:'network',host,port:Number($('#npPort').value||9100),name:'Wi‑Fi '+host});$('#npHost').value=''}catch(e){toast(e.message,'err')}});
$('#npList').addEventListener('click',async e=>{
  const tb=e.target.closest('[data-np-test]');
  if(tb){tb.disabled=true;const old=tb.textContent;tb.textContent='กำลังพิมพ์…';try{const r=await apiJson('/api/printers/'+tb.dataset.npTest+'/test','POST',{});toast(r.switched_to?`เครื่องเดิมไม่ได้เสียบอยู่ — เปลี่ยนไปใช้ "${r.switched_to}" และพิมพ์ทดสอบแล้ว`:'พิมพ์ทดสอบแล้ว','ok');loadNetPrinters()}catch(err){toast(err.message,'err')}finally{tb.disabled=false;tb.textContent=old}return;}
  const db=e.target.closest('[data-np-del]');
  if(db&&confirm('ลบเครื่องพิมพ์นี้?')){try{await apiJson('/api/printers/'+db.dataset.npDel,'DELETE');loadNetPrinters()}catch(err){toast(err.message,'err')}}
});
async function refreshPrintStatus(){
  const b=$('#printFailBanner');if(!b||!currentBranchId||!me||me.role==='super_admin'&&!me.tenant)return;
  try{const r=await api('/api/printers?branch_id='+currentBranchId,{silent:true});b.classList.toggle('hidden',!r.failed);b.textContent=`พิมพ์ไม่สำเร็จ ${r.failed} งาน — แตะเพื่อพิมพ์ซ้ำ`;printFailures=Number(r.failed||0);const c=$('#printFailCount');c.textContent=printFailures;c.classList.toggle('hidden',!printFailures);renderNotifications();}catch(e){}
}
$('#printFailBanner').addEventListener('click',async()=>{
  try{
    const jobs=await api('/api/print/jobs?status=failed&branch_id='+currentBranchId);if(!jobs.length){refreshPrintStatus();return;}
    const list=jobs.map(j=>`• ${j.job_type==='receipt'?'ใบเสร็จ':'ครัว'} #${j.order_no}${j.table_name_snapshot?' ('+j.table_name_snapshot+')':''} — ${j.last_error||''}`).join('\n');
    if(!confirm(`งานที่พิมพ์ไม่ออก:\n${list}\n\nตรวจว่าเครื่องพิมพ์เปิดอยู่และมีกระดาษ แล้วกด OK เพื่อพิมพ์ซ้ำ (ครั้งเดียว)`))return;
    for(const j of jobs)await apiJson('/api/print/jobs/'+j.id+'/retry','POST',{});
    toast('ส่งพิมพ์ซ้ำแล้ว','ok');setTimeout(refreshPrintStatus,4000);
  }catch(e){toast(e.message,'err')}
});
async function openPrintCenter(){
  if(!currentBranchId)return;
  const box=$('#printCenterList'); box.innerHTML='<div class="muted">กำลังโหลด…</div>'; openModal('#printCenterModal');
  try{
    // Without a printer set up here, tickets print through the browser's Print window — the queue is only for direct printing.
    const pr=await api('/api/printers?branch_id='+currentBranchId,{silent:true}).catch(()=>({printers:[]}));
    const direct=(pr.printers||[]).length>0;
    const all=await api('/api/print/jobs?status=active&branch_id='+currentBranchId);
    const jobs=direct?all:all.filter(j=>j.status==='failed');
    const label={pending:'รอพิมพ์',failed:'พิมพ์ไม่สำเร็จ',cancelled:'ยกเลิกแล้ว',printed:'พิมพ์แล้ว'};
    const note=direct?'':'<div class="muted printer-help">ยังไม่ได้ตั้งเครื่องพิมพ์พิมพ์ตรงในเครื่องนี้ — ใบเสร็จ/ใบครัวจะพิมพ์ผ่านหน้าต่าง Print ของเบราว์เซอร์ · ตั้งค่าได้ที่ ตั้งค่า → เครื่องพิมพ์</div>';
    box.innerHTML=note+(jobs.length?jobs.map(j=>`<div class="list-row"><div><b>${escapeHtml(j.job_type==='receipt'?'ใบเสร็จ':'ใบครัว')} #${escapeHtml(j.order_no||'')}${j.table_name_snapshot?' · '+escapeHtml(j.table_name_snapshot):''}</b><div class="muted">${escapeHtml(label[j.status]||j.status)}${j.station_name?' · '+escapeHtml(j.station_name):''} ${j.last_error?'· '+escapeHtml(j.last_error):''}</div></div><div class="row-actions">${j.status==='failed'||j.status==='cancelled'?'<button class="ghost-btn" data-pj-retry="'+j.id+'">พิมพ์ซ้ำ</button>':''}${j.status==='pending'||j.status==='failed'?'<button class="danger-btn" data-pj-cancel="'+j.id+'">ยกเลิก</button>':''}</div></div>`).join(''):'<div class="empty-state">ไม่มีงานพิมพ์ที่ค้างอยู่</div>');
  }catch(e){box.innerHTML='<div class="error-text">'+escapeHtml(e.message)+'</div>'}
}
$('#printCenterList')?.addEventListener('click',async e=>{
  const retry=e.target.closest('[data-pj-retry]'), cancel=e.target.closest('[data-pj-cancel]');
  try{
    if(retry)await apiJson('/api/print/jobs/'+retry.dataset.pjRetry+'/retry','POST',{});
    if(cancel&&confirm('ยกเลิกงานพิมพ์นี้?'))await apiJson('/api/print/jobs/'+cancel.dataset.pjCancel+'/cancel','POST',{});
    if(retry||cancel){await openPrintCenter();refreshPrintStatus()}
  }catch(err){toast(err.message,'err')}
});
$('#printCenterBtn')?.addEventListener('click',openPrintCenter);
setInterval(refreshPrintStatus,15000);

// ---------- Shop-PC program: update, auto-start, QR address, backups, import (local app only) ----------
async function loadLocalPanel(){
  let st;try{st=await api('/api/local/status')}catch(e){$('#localPanel').classList.add('hidden');return}
  $('#localPanel').classList.remove('hidden');
  $('#lpVersion').textContent=`ZaabOS เวอร์ชัน ${st.version} · ข้อมูลอยู่ที่ ${st.data_dir}`;
  $('#lpUpdateText').textContent=st.update?`มีเวอร์ชันใหม่ ${st.update.version}`:`เวอร์ชัน ${st.version}`;
  $('#lpUpdateBtn').textContent=st.update?`อัปเดตเป็น ${st.update.version}`:'ตรวจหาอัปเดต';
  $('#lpUpdateBtn').dataset.ready=st.update?'1':'';
  $('#lpAutostart').checked=!!st.autostart;
  $('#lpAddress').value=st.address_mode||'ip';
  $('#lpAddressHelp').innerHTML=`ตอนนี้: <b>${escapeHtml(st.public_url||'')}</b>${st.address_warning?'<br><i class="ic ic-triangle-alert" aria-hidden="true"></i> '+escapeHtml(st.address_warning):''}<br>ชื่อเครื่อง = ${escapeHtml(st.hostname)} (ไม่เปลี่ยนแม้ IP เปลี่ยน แต่มือถือ Android บางรุ่นอาจเปิดไม่ได้) · แนะนำ: ใช้ IP แล้วล็อก IP ที่เราเตอร์ (DHCP reservation)`;
  $('#lpMirror').textContent=st.mirror_dir?`สำรองอัตโนมัติทุก 2 ชั่วโมง และคัดลอกไปที่ ${st.mirror_dir} (อยู่รอดแม้เครื่องเสีย)`:'สำรองอัตโนมัติทุก 2 ชั่วโมง (ยังไม่มีที่เก็บนอกเครื่อง — เปิด iCloud Drive / OneDrive เพื่อให้คัดลอกอัตโนมัติ)';
  $('#lpBackups').innerHTML=(st.backups||[]).slice(0,10).map(b=>`<div class="np-row"><div><b>${escapeHtml(new Date(b.mtime*1000).toLocaleString(localeFor(currentLang)))}</b><small>${escapeHtml(b.where)} · ${(b.bytes/1024).toFixed(0)} KB · ${escapeHtml(b.file)}</small></div><div class="np-actions"><button class="ghost-btn" data-lp-restore="${escapeHtml(b.file)}">กู้คืน</button></div></div>`).join('');
}
$('#lpUpdateBtn').addEventListener('click',async()=>{const b=$('#lpUpdateBtn');b.disabled=true;try{
  if(!b.dataset.ready){const r=await apiJson('/api/local/check-update','POST',{});if(!r.update){toast('ใช้เวอร์ชันล่าสุดแล้ว','ok');return}loadLocalPanel();return}
  if(!confirm('อัปเดตตอนนี้? ข้อมูลร้านไม่หาย (สำรองให้ก่อนอัตโนมัติ) ZaabOS จะปิดและเปิดใหม่ใน ~10 วินาที'))return;
  b.textContent='กำลังดาวน์โหลด…';await apiJson('/api/local/update','POST',{});toast('กำลังติดตั้ง — หน้านี้จะรีโหลดเอง','ok');setTimeout(()=>location.reload(),15000)
}catch(e){toast(e.message,'err')}finally{b.disabled=false}});
$('#lpAutostart').addEventListener('change',async e=>{try{await apiJson('/api/local/autostart','PUT',{enabled:e.target.checked});toast('บันทึกแล้ว','ok')}catch(err){toast(err.message,'err');e.target.checked=!e.target.checked}});
$('#lpAddress').addEventListener('change',async e=>{try{await apiJson('/api/local/address-mode','PUT',{mode:e.target.value});alert('บันทึกแล้ว — ปิดแล้วเปิด ZaabOS ใหม่ จากนั้นพิมพ์ QR โต๊ะใหม่')}catch(err){toast(err.message,'err')}});
$('#lpBackupBtn').addEventListener('click',async()=>{try{const r=await apiJson('/api/local/backup','POST',{});toast('สำรองแล้ว'+(r.mirrored?' + คัดลอกนอกเครื่องแล้ว':''),'ok');loadLocalPanel()}catch(e){toast(e.message,'err')}});
$('#lpBackups').addEventListener('click',async e=>{const b=e.target.closest('[data-lp-restore]');if(!b)return;
  if(!confirm(`กู้ข้อมูลจาก ${b.dataset.lpRestore}?\nข้อมูลปัจจุบันจะถูกสำรองไว้ก่อน แล้ว ZaabOS จะเปิดใหม่`))return;
  try{const r=await apiJson('/api/local/restore','POST',{file:b.dataset.lpRestore});toast(`กำลังกู้ข้อมูล (${r.orders} ออเดอร์) — หน้านี้จะรีโหลดเอง`,'ok');setTimeout(()=>location.reload(),12000)}catch(err){toast(err.message,'err')}});
$('#lpImportBtn').addEventListener('click',async()=>{const b=$('#lpImportBtn');
  if(!confirm('ดึงเมนู/โต๊ะ/ตั้งค่า จาก zaabos.com มาแทนของเดิมในเครื่องนี้?\n(ของเดิมถูกเก็บเข้าคลัง ไม่ลบ · สำรองข้อมูลให้ก่อน)'))return;
  b.disabled=true;b.textContent='กำลังดึงข้อมูล…';
  try{const r=await apiJson('/api/local/import-cloud','POST',{branch_id:currentBranchId,username:$('#lpCloudUser').value.trim(),password:$('#lpCloudPass').value});
    $('#lpCloudPass').value='';alert(`ดึงข้อมูลจากสาขา "${r.branch}" แล้ว: ${r.categories} หมวด · ${r.items} เมนู · ${r.tables} โต๊ะ · ${r.stations} สถานีครัว\nพิมพ์ QR โต๊ะใหม่ก่อนใช้งาน`);location.reload();
  }catch(e){toast(e.message,'err')}finally{b.disabled=false;b.textContent='ดึงข้อมูลมาใส่เครื่องนี้'}});

try { const v = localStorage.getItem('zaabos_send_kitchen'); if (v !== null && $('#takeOrderSendKitchen')) $('#takeOrderSendKitchen').checked = v === '1'; } catch (e) {}

$('#lpHealthBtn').addEventListener('click',async()=>{const b=$('#lpHealthBtn');b.disabled=true;try{const r=await api('/api/local/health');const icon={ok:'',warn:'',bad:''};
  const bad=r.checks.filter(c=>c.level!=='ok').length;
  $('#lpHealth').innerHTML=`<div class="np-row"><b>${bad?`ต้องดู ${bad} เรื่อง`:'ทุกอย่างปกติ <i class="ic ic-check" aria-hidden="true"></i> ปิดร้านได้'}</b></div>`+r.checks.map(c=>`<div class="np-row"><div><b>${icon[c.level]} ${escapeHtml(c.title)}</b>${c.detail?`<small>${escapeHtml(c.detail)}</small>`:''}</div></div>`).join('');
}catch(e){toast(e.message,'err')}finally{b.disabled=false}});

// ---------- Round A UI: payment method buttons + light/dark toggle ----------
function syncPaySeg(){const v=$('#cpMethod').value;$$('#cpMethodSeg [data-m]').forEach(b=>b.classList.toggle('on',b.dataset.m===v));}
$('#cpMethodSeg').addEventListener('click',e=>{const b=e.target.closest('[data-m]');if(!b)return;$('#cpMethod').value=b.dataset.m;$('#cpMethod').dispatchEvent(new Event('change'));syncPaySeg();});
$('#cpMethod').addEventListener('change',syncPaySeg);
new MutationObserver(()=>{if($('#confirmPaymentModal').classList.contains('show'))syncPaySeg();}).observe($('#confirmPaymentModal'),{attributes:true,attributeFilter:['class']});
// Screen mode: clean blue-white by default; the dark + gold look stays available in Settings.
// (New key: everyone starts on the blue-white look once, then keeps whatever they pick.)
(function(){
  const KEY='zaabos_theme_f',root=document.documentElement,media=window.matchMedia('(prefers-color-scheme: dark)');
  let mode='light';
  try{const saved=localStorage.getItem(KEY);if(saved==='dark'||saved==='light'||saved==='system')mode=saved;}catch(e){}
  function apply(){root.dataset.theme=mode==='system'?(media.matches?'dark':'light'):mode;root.dataset.themeMode=mode;const m=document.querySelector('meta[name="theme-color"]');if(m)m.content=root.dataset.theme==='dark'?'#0B0B0D':'#EEF3F9';}
  function sync(){$$('#themeModeSeg [data-theme-mode]').forEach(b=>b.classList.toggle('active',b.dataset.themeMode===mode));}
  apply();sync();
  if(media.addEventListener)media.addEventListener('change',()=>{if(mode==='system')apply();});
  $('#themeModeSeg').addEventListener('click',ev=>{const b=ev.target.closest('[data-theme-mode]');if(!b)return;mode=b.dataset.themeMode;try{localStorage.setItem(KEY,mode)}catch(e){}apply();sync();});
})();

// ---------- Menu names in several languages (primary + secondary line) ----------
const NAME_I18N_FIELDS={th:'#menuNameTh',lo:'#menuNameLo',zh:'#menuNameZh',en:'#menuNameEn'};
function parseNameI18n(v){if(!v)return{};if(typeof v==='object')return v;try{return JSON.parse(v)||{}}catch(e){return{}}}
function setNameI18n(v){const n=parseNameI18n(v);for(const[k,sel]of Object.entries(NAME_I18N_FIELDS)){const el=$(sel);if(el)el.value=n[k]||'';}}
function readNameI18n(){const o={};for(const[k,sel]of Object.entries(NAME_I18N_FIELDS)){const el=$(sel);if(el&&el.value.trim())o[k]=el.value.trim();}return o;}
// {main, sub} for a menu row on this branch's POS, following Settings → menu name languages.
function menuNames(it){const L=(boot.menu_langs||{})[String(currentBranchId)]||(boot.menu_langs||{})[currentBranchId]||{};const n=parseNameI18n(it.name_i18n);
  const main=(L.primary&&n[L.primary])||it.name;const sub=(L.secondary&&n[L.secondary]&&n[L.secondary]!==main)?n[L.secondary]:'';return{main,sub};}


// ===================== Version E — shell: kitchen, payment queue, dashboard, customers, search, alerts =====================

// ---- Kitchen: the same /kitchen screen the kitchen tablet uses, inside the POS ----
function loadKitchenFrame() {
  const f = $('#kitchenFrame'), url = '/kitchen?embed=1' + (currentBranchId ? '&branch=' + currentBranchId : '');
  if (f.dataset.src !== url) { f.dataset.src = url; f.src = url; }
}
function unloadKitchenFrame() { const f = $('#kitchenFrame'); if (f && f.dataset.src) { f.dataset.src = ''; f.src = 'about:blank'; } }

// ---- Bills waiting for payment ----
function unpaidOrders() { return activeOrders.filter(o => o.payment_status === 'unpaid' && o.status !== 'cancelled').sort((a, b) => a.id - b.id); }
function billItemsSummary(o, max) {
  const rows = o.items.filter(it => Number(it.quantity || 0) - Number(it.cancelled_quantity || 0) > 0);
  const head = rows.slice(0, max).map(it => `<li><b>${Number(it.quantity) - Number(it.cancelled_quantity || 0)}×</b> ${escapeHtml(it.item_name_snapshot)}</li>`).join('');
  return `<ul class="bc-items">${head}${rows.length > max ? `<li class="muted">+ อีก ${rows.length - max} รายการ</li>` : ''}</ul>`;
}
function renderBilling() {
  const rows = unpaidOrders(), box = $('#billingList');
  const sum = rows.reduce((a, o) => a + Number(o.total_amount || 0) + Number(o.delivery_fee || 0) - Number(o.discount_amount || 0), 0);
  $('#billingSummary').textContent = rows.length ? `${rows.length} บิลรอชำระ · รวม ${fmtMoney(sum)}` : '';
  if (!rows.length) { box.innerHTML = emptyState('<i class="ic ic-circle-check" aria-hidden="true"></i>', 'ไม่มีบิลค้างชำระ'); return; }
  box.innerHTML = rows.map(o => {
    const where = o.table_name_snapshot || orderTypeLabel(o.order_type);
    const due = Number(o.total_amount || 0) + Number(o.delivery_fee || 0) - Number(o.discount_amount || 0);
    return `<article class="bill-card ${o.status === 'served' ? 'is-bill' : ''}">
      <div class="bc-head"><div><b>${escapeHtml(where)}</b><small>#${escapeHtml(o.order_no)} · ${fmtClock(o.created_at)}${o.guest_count ? ' · ' + o.guest_count + ' คน' : ''}</small></div><span class="pill ${o.status}">${escapeHtml(o.status === 'served' ? 'รอเก็บเงิน' : statusLabel(o.status))}</span></div>
      ${billItemsSummary(o, 4)}
      <div class="bc-total"><span>ยอดรวม</span><b>${fmtMoney(due)}</b></div>
      <div class="bc-actions"><button type="button" class="ghost-btn" data-bill-open="${o.id}"><i class="ic ic-receipt" aria-hidden="true"></i> ดูบิล</button><button type="button" class="save" data-bill-pay="${o.id}">ชำระเงิน <i class="ic ic-arrow-right" aria-hidden="true"></i></button></div>
    </article>`;
  }).join('');
}
function onBillQueueClick(e) {
  const pay = e.target.closest('[data-bill-pay]'), open = e.target.closest('[data-bill-open]');
  if (pay) openConfirmPaymentModal(parseInt(pay.dataset.billPay, 10));
  else if (open) openAddItemsToOrder(parseInt(open.dataset.billOpen, 10));
}
$('#billingList').addEventListener('click', onBillQueueClick);
$('#dashOpenBills').addEventListener('click', onBillQueueClick);

// ---- after every board refresh: sidebar counters, alerts, live pages ----
function setNavCount(id, n) { const el = $(id); if (!el) return; el.textContent = n; el.classList.toggle('hidden', !n); }
function afterBoardData() {
  setNavCount('#navCountBilling', unpaidOrders().length);
  setNavCount('#navCountKitchen', activeOrders.filter(o => o.status === 'received' || o.status === 'preparing').length);
  renderNotifications();
  if (currentTab === 'billing') renderBilling();
  if (currentTab === 'dashboard') renderDashOpenBills();
  if ($('#takeOrderModal').classList.contains('show') && addItemsOrderId) renderCart();
}

// ---- Dashboard ----
function trendHtml(now, before, fmt) {
  now = Number(now || 0); before = Number(before || 0);
  if (!before) return now ? '<span class="trend up"><i class="ic ic-trending-up" aria-hidden="true"></i> ใหม่วันนี้</span>' : '<span class="trend">—</span>';
  const pct = Math.round((now - before) / before * 100);
  return `<span class="trend ${pct >= 0 ? 'up' : 'down'}"><i class="ic ic-trending-${pct >= 0 ? 'up' : 'down'}" aria-hidden="true"></i> ${pct >= 0 ? '+' : ''}${pct}%</span><small>เมื่อวาน ${fmt ? fmt(before) : before}</small>`;
}
function kpiCard(icon, label, value, extra, cls) {
  return `<div class="kpi ${cls || ''}"><div class="kpi-top"><span class="kpi-ic"><i class="ic ic-${icon}" aria-hidden="true"></i></span><span class="kpi-label">${escapeHtml(label)}</span></div><div class="kpi-value">${value}</div><div class="kpi-extra">${extra || ''}</div></div>`;
}
function hourChartHtml(hours, compare) {
  // A sales day that starts at 04:00 reads 04 … 03 (late-night bills at the end, not the start).
  const cut = dayCutoffHour(), clock = k => (k + cut) % 24;
  hours = hours.map((_, k) => hours[clock(k)]); if (compare) compare = compare.map((_, k) => compare[clock(k)]);
  const tot = h => Number(h.total || 0);
  const used = hours.map((h, i) => (tot(h) || (compare && tot(compare[i]))) ? i : -1).filter(i => i >= 0);
  let from = used.length ? Math.max(0, Math.min(...used) - 1) : 9, to = used.length ? Math.min(23, Math.max(...used) + 1) : 22;
  if (to - from < 9) { to = Math.min(23, from + 9); from = Math.max(0, to - 9); }
  const max = Math.max(1, ...hours.slice(from, to + 1).map(tot), ...(compare ? compare.slice(from, to + 1).map(tot) : [0]));
  const bars = [];
  for (let i = from; i <= to; i++) {
    const v = tot(hours[i]), c = compare ? tot(compare[i]) : 0;
    bars.push(`<div class="hc-col" title="${String(clock(i)).padStart(2, '0')}:00 · ${fmtMoney(v)} · ${hours[i].orders || 0} บิล">
      <div class="hc-bars">${compare ? `<span class="hc-bar prev" style="height:${Math.round(c / max * 100)}%"></span>` : ''}<span class="hc-bar" style="height:${Math.max(v ? 3 : 0, Math.round(v / max * 100))}%"></span></div>
      <span class="hc-lbl">${String(clock(i)).padStart(2, '0')}</span></div>`);
  }
  return `<div class="hc-wrap">${bars.join('')}</div>${compare ? '<div class="hc-legend"><span><i class="lg lg-gold"></i>วันนี้</span><span><i class="lg lg-prev"></i>เมื่อวาน</span></div>' : ''}`;
}
function payIcon(m) { return ({ cash: 'banknote', qr: 'qr-code', card: 'credit-card', bank_transfer: 'landmark' })[m] || 'wallet'; }
function renderDashOpenBills() {
  const rows = unpaidOrders().slice(0, 6), box = $('#dashOpenBills');
  box.innerHTML = rows.length ? rows.map(o => `<button type="button" class="dash-row" data-bill-open="${o.id}"><span><b>${escapeHtml(o.table_name_snapshot || orderTypeLabel(o.order_type))}</b><small>#${escapeHtml(o.order_no)} · ${fmtClock(o.created_at)}</small></span><b>${fmtMoney(Number(o.total_amount || 0) + Number(o.delivery_fee || 0) - Number(o.discount_amount || 0))}</b></button>`).join('')
    : emptyState('<i class="ic ic-circle-check" aria-hidden="true"></i>', 'ไม่มีบิลค้างชำระ');
}
async function loadDashboard() {
  if (!currentBranchId) return;
  try { $('#dashDate').textContent = new Intl.DateTimeFormat(localeFor(currentLang) + '-u-ca-gregory', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: ZAABOS_RESTAURANT_TZ }).format(businessNow()); } catch (e) {}
  const q = ([f, tt]) => api('/api/reports/summary?' + new URLSearchParams({ from: f, to: tt, branch_id: currentBranchId }), { silent: true });
  let a, b;
  try { [a, b] = await Promise.all([q(presetRange('today')), q(presetRange('yesterday')), loadBoardData()]); }
  catch (e) { $('#dashKpis').innerHTML = emptyState('', e.message); return; }
  const tables = branchTables(), busy = tables.filter(tb => tableActiveOrders(tb.id).length).length;
  $('#dashKpis').innerHTML =
    kpiCard('wallet', 'ยอดขายวันนี้', fmtMoney(a.total_sales), trendHtml(a.total_sales, b.total_sales, fmtMoney), 'kpi-hero') +
    kpiCard('receipt', 'ออเดอร์ที่ชำระแล้ว', a.order_count, trendHtml(a.order_count, b.order_count)) +
    kpiCard('armchair', 'โต๊ะที่ใช้งาน', `${busy}<small>/${tables.length}</small>`, `<small>${unpaidOrders().length} บิลยังไม่ชำระ · ${fmtMoney(a.open_order_total || 0)}</small>`) +
    kpiCard('users', 'ลูกค้า', a.guests, trendHtml(a.guests, b.guests)) +
    kpiCard('hand-coins', 'บิลเฉลี่ย', fmtMoney(a.average_bill || 0), trendHtml(a.average_bill, b.average_bill, fmtMoney));
  $('#dashHourly').innerHTML = hourChartHtml(a.hourly || [], b.hourly || null);
  const top = (a.top_items || []).slice(0, 6), maxQ = Math.max(1, ...top.map(x => Number(x.qty || 0)));
  $('#dashTopItems').innerHTML = top.length ? top.map((it, i) => `<div class="rank-row"><span class="rank-no">${i + 1}</span><div class="rank-main"><div class="rank-name"><b>${escapeHtml(it.name)}</b><span>${Number(it.qty || 0)} จาน</span></div><div class="rank-track"><span style="width:${Math.max(4, Math.round(Number(it.qty || 0) / maxQ * 100))}%"></span></div></div></div>`).join('')
    : emptyState('<i class="ic ic-utensils" aria-hidden="true"></i>', 'ยังไม่มีการขายวันนี้');
  const pays = a.payment_breakdown || [], payTotal = pays.reduce((s, x) => s + Number(x.total || 0), 0);
  $('#dashPayments').innerHTML = pays.length ? pays.map(x => `<div class="pay-row"><span class="pay-ic"><i class="ic ic-${payIcon(x.payment_method)}" aria-hidden="true"></i></span><div><b>${escapeHtml(paymentMethodName(x.payment_method))}</b><small>${x.count} รายการ · ${payTotal ? Math.round(Number(x.total) / payTotal * 100) : 0}%</small></div><b>${fmtMoney(x.total)}</b></div>`).join('')
    : emptyState('<i class="ic ic-credit-card" aria-hidden="true"></i>', 'ยังไม่มีรายการชำระเงิน');
  renderDashOpenBills();
}
$('#dashRefreshBtn').addEventListener('click', loadDashboard);

// ---- Customers ----
let customersRows = [], customerSelected = null, customerSearchTimer = null;
async function loadCustomers() {
  if (!currentBranchId) return;
  const qs = new URLSearchParams({ branch_id: currentBranchId }); const text = $('#customerSearch').value.trim(); if (text) qs.set('q', text);
  try { const r = await api('/api/customers?' + qs); customersRows = r.customers || []; $('#customersSummary').textContent = `${r.total || 0} รายชื่อ · จากชื่อหรือเบอร์โทรที่ให้ไว้ในออเดอร์`; }
  catch (e) { $('#customersList').innerHTML = emptyState('', e.message); return; }
  const list = $('#customersList');
  list.innerHTML = customersRows.length ? customersRows.map(c => `<button type="button" class="cust-row ${customerSelected === c.key ? 'active' : ''}" data-cust="${escapeHtml(c.key)}">
      <span class="avatar">${escapeHtml((c.name || c.phone || '?').slice(0, 1).toUpperCase())}</span>
      <span class="cust-main"><b>${escapeHtml(c.name || c.phone)}</b><small>${escapeHtml(c.phone || 'ไม่มีเบอร์โทร')}</small></span>
      <span class="cust-num"><b>${fmtMoney(c.total_spent)}</b><small>${c.visits} ครั้ง</small></span></button>`).join('')
    : emptyState('<i class="ic ic-user-round" aria-hidden="true"></i>', text ? 'ไม่พบลูกค้าที่ค้นหา' : 'ยังไม่มีข้อมูลลูกค้า — ใส่ชื่อหรือเบอร์โทรตอนรับออเดอร์ เพื่อเก็บประวัติลูกค้า');
  // Wide screens show the list and the history side by side — open the first customer straight away.
  if (window.innerWidth > 760 && customersRows.length && !customersRows.some(c => c.key === customerSelected)) { const first = $('#customersList .cust-row'); if (first) first.click(); }
}
$('#customerSearch').addEventListener('input', () => { clearTimeout(customerSearchTimer); customerSearchTimer = setTimeout(loadCustomers, 250); });
$('#customersList').addEventListener('click', async e => {
  const b = e.target.closest('[data-cust]'); if (!b) return;
  const c = customersRows.find(x => x.key === b.dataset.cust); if (!c) return;
  customerSelected = c.key; $$('#customersList .cust-row').forEach(x => x.classList.toggle('active', x === b));
  const qs = new URLSearchParams({ branch_id: currentBranchId }); if (c.phone) qs.set('customer_phone', c.phone); else qs.set('customer_name', c.name);
  const box = $('#customerDetail'); box.innerHTML = '<div class="muted">กำลังโหลด…</div>';
  try {
    const r = await api('/api/orders?' + qs); customerOrdersCache = r.orders || [];
    box.innerHTML = `<div class="cust-head"><span class="avatar lg">${escapeHtml((c.name || c.phone || '?').slice(0, 1).toUpperCase())}</span><div><h2>${escapeHtml(c.name || c.phone)}</h2><div class="muted">${escapeHtml(c.phone || 'ไม่มีเบอร์โทร')}</div></div></div>
      <div class="cust-stats"><div><small>ยอดใช้จ่ายรวม</small><b>${fmtMoney(c.total_spent)}</b></div><div><small>จำนวนครั้ง</small><b>${c.visits}</b></div><div><small>เฉลี่ยต่อครั้ง</small><b>${fmtMoney(c.visits ? c.total_spent / c.visits : 0)}</b></div><div><small>มาล่าสุด</small><b>${escapeHtml(zaabosDateTime(c.last_visit).split(' ')[0] || '')}</b></div></div>
      <h3>ประวัติการสั่ง</h3>` + customerOrdersCache.map(o => `<button type="button" class="dash-row" data-cust-order="${o.id}"><span><b>#${escapeHtml(o.order_no)} · ${escapeHtml(o.table_name_snapshot || orderTypeLabel(o.order_type))}</b><small>${escapeHtml(zaabosDateTime(o.created_at))} · ${o.items.length} รายการ</small></span><span class="dash-row-end"><span class="pill ${o.payment_status}">${escapeHtml(o.payment_status === 'paid' ? t('payment_paid') : t('payment_unpaid'))}</span><b>${fmtMoney(Number(o.total_amount || 0) + Number(o.delivery_fee || 0) - Number(o.discount_amount || 0))}</b></span></button>`).join('');
  } catch (err) { box.innerHTML = emptyState('', err.message); }
});
$('#customerDetail').addEventListener('click', e => {
  const b = e.target.closest('[data-cust-order]'); if (!b) return;
  const o = customerOrdersCache.find(x => x.id === parseInt(b.dataset.custOrder, 10)); if (o) openOrderDetail([o], '#' + o.order_no);
});

// ---- Settings hub ----
initLangSwitcher('#settingsLangSelect');
async function renderSettingsHub() {
  try { await api('/api/local/status', { silent: true }); $('#settingsLocalRow').classList.remove('hidden'); } catch (e) { $('#settingsLocalRow').classList.add('hidden'); }
  applyRoleVisibility();
  if ($('#settingsLocalRow').dataset.need === 'manager' && me && !['owner', 'manager', 'super_admin'].includes(me.role)) $('#settingsLocalRow').classList.add('hidden');
}

// ---- Search in the top bar: dishes, open bills, tables, customers ----
let searchPick = [];
function renderGlobalSearch() {
  const q = $('#globalSearch').value.trim().toLowerCase(), box = $('#globalSearchResults');
  if (!q || !me) { box.classList.add('hidden'); box.innerHTML = ''; searchPick = []; return; }
  const out = [];
  activeOrders.filter(o => (o.order_no + ' ' + (o.table_name_snapshot || '') + ' ' + (o.customer_name || '') + ' ' + (o.customer_phone || '')).toLowerCase().includes(q)).slice(0, 5)
    .forEach(o => out.push({ group: 'บิลที่เปิดอยู่', icon: 'receipt', title: `${o.table_name_snapshot || orderTypeLabel(o.order_type)} · #${o.order_no}`, sub: `${o.customer_name || ''} · ${fmtMoney(o.total_amount)}`, run: () => openAddItemsToOrder(o.id) }));
  branchTables().filter(tb => tb.name.toLowerCase().includes(q)).slice(0, 4)
    .forEach(tb => out.push({ group: 'โต๊ะ', icon: 'armchair', title: tb.name, sub: tableActiveOrders(tb.id).length ? 'มีลูกค้า' : 'ว่าง', run: () => { const os = tableActiveOrders(tb.id); if (!os.length) openTakeOrderForTable(tb.id); else if (os.length === 1) openAddItemsToOrder(os[0].id); else openOrderDetail(os, tb.name); } }));
  branchItems().filter(it => { const n = menuNames(it); return (it.name + ' ' + n.main + ' ' + n.sub).toLowerCase().includes(q); }).slice(0, 6)
    .forEach(it => out.push({ group: 'เมนู', icon: 'utensils', title: menuNames(it).main, sub: fmtMoney(it.base_price) + (it.sold_out ? ' · หมด' : ''), run: () => { openTakeOrderForTable(); $('#takeOrderSearch').value = q; takeOrderQuery = q; renderTakeOrderMenu(); } }));
  out.push({ group: 'ค้นหาต่อ', icon: 'history', title: `ค้นหา "${$('#globalSearch').value.trim()}" ในประวัติออเดอร์`, sub: '', run: () => { $('#historySearch').value = $('#globalSearch').value.trim(); navigate('history'); } });
  out.push({ group: 'ค้นหาต่อ', icon: 'user-round', title: `ค้นหา "${$('#globalSearch').value.trim()}" ในรายชื่อลูกค้า`, sub: '', run: () => { $('#customerSearch').value = $('#globalSearch').value.trim(); navigate('customers'); } });
  searchPick = out;
  let last = '';
  box.innerHTML = out.map((r, i) => { const head = r.group !== last ? `<div class="sr-group">${escapeHtml(r.group)}</div>` : ''; last = r.group;
    return `${head}<button type="button" class="sr-item ${i === 0 ? 'active' : ''}" data-search-pick="${i}"><i class="ic ic-${r.icon}" aria-hidden="true"></i><span><b>${escapeHtml(r.title)}</b>${r.sub ? `<small>${escapeHtml(r.sub)}</small>` : ''}</span></button>`; }).join('');
  box.classList.remove('hidden');
}
function runSearchPick(i) { const r = searchPick[i]; if (!r) return; $('#globalSearch').value = ''; renderGlobalSearch(); $('#globalSearch').blur(); r.run(); }
$('#globalSearch').addEventListener('input', renderGlobalSearch);
$('#globalSearch').addEventListener('focus', renderGlobalSearch);
$('#globalSearch').addEventListener('keydown', e => {
  const items = $$('#globalSearchResults .sr-item'); if (!items.length) return;
  let i = items.findIndex(x => x.classList.contains('active'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items.forEach((x, k) => x.classList.toggle('active', k === i)); items[i].scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'Enter') { e.preventDefault(); runSearchPick(Math.max(0, i)); }
  else if (e.key === 'Escape') { $('#globalSearch').value = ''; renderGlobalSearch(); $('#globalSearch').blur(); }
});
$('#globalSearchResults').addEventListener('mousedown', e => e.preventDefault());
$('#globalSearchResults').addEventListener('click', e => { const b = e.target.closest('[data-search-pick]'); if (b) runSearchPick(parseInt(b.dataset.searchPick, 10)); });
document.addEventListener('click', e => { if (!e.target.closest('#topSearch')) $('#globalSearchResults').classList.add('hidden'); });
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && me) { e.preventDefault(); $('#globalSearch').focus(); } });

// ---- Alerts (bell): new QR orders, food ready, printer problems ----
function notificationItems() {
  const out = [];
  activeOrders.filter(o => o.status === 'received' && o.placed_by === 'customer').forEach(o => out.push({ cls: 'new', icon: 'smartphone', title: `ออเดอร์ QR ใหม่ · ${o.table_name_snapshot || orderTypeLabel(o.order_type)}`, sub: `#${o.order_no} · ${fmtClock(o.created_at)}`, order: o.id }));
  activeOrders.filter(o => o.status === 'ready').forEach(o => out.push({ cls: 'ready', icon: 'bell-ring', title: `อาหารพร้อมเสิร์ฟ · ${o.table_name_snapshot || orderTypeLabel(o.order_type)}`, sub: `#${o.order_no}`, order: o.id }));
  if (printFailures) out.push({ cls: 'bad', icon: 'printer', title: `พิมพ์ไม่สำเร็จ ${printFailures} งาน`, sub: 'แตะเพื่อดูและพิมพ์ซ้ำ', print: true });
  return out;
}
function renderNotifications() {
  const items = notificationItems(), c = $('#notifCount');
  c.textContent = items.length; c.classList.toggle('hidden', !items.length);
  $('#notifMenu').innerHTML = `<div class="notif-title">การแจ้งเตือน</div>` + (items.length ? items.map((n, i) => `<button type="button" class="notif-item ${n.cls}" data-notif="${i}"><i class="ic ic-${n.icon}" aria-hidden="true"></i><span><b>${escapeHtml(n.title)}</b><small>${escapeHtml(n.sub)}</small></span></button>`).join('') : `<div class="notif-empty">ไม่มีอะไรต้องทำตอนนี้</div>`);
}
$('#notifBtn').addEventListener('click', e => { e.stopPropagation(); renderNotifications(); $('#notifMenu').classList.toggle('hidden'); });
$('#notifMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-notif]'); if (!b) return;
  const n = notificationItems()[parseInt(b.dataset.notif, 10)]; $('#notifMenu').classList.add('hidden'); if (!n) return;
  if (n.print) { openPrintCenter(); return; }
  const o = findOrderById(n.order); if (o) openOrderDetail([o], o.table_name_snapshot || orderTypeLabel(o.order_type));
});
document.addEventListener('click', e => { if (!e.target.closest('.notif-wrap')) $('#notifMenu').classList.add('hidden'); });

// ---- Sidebar user card opens the account menu ----
$('#navUserBtn').addEventListener('click', e => { e.stopPropagation(); const m = $('#whoMenu'); m.classList.toggle('from-nav', true); m.classList.toggle('hidden'); });
$('#whoBtn').addEventListener('click', () => $('#whoMenu').classList.remove('from-nav'));

// ---- Esc closes the sheet on top (the order workspace included) ----
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const open = $$('.modal.show'); if (!open.length) return;
  const top = open[open.length - 1];
  if (top.id === 'takeOrderModal' && guardTakeOrderLeave()) return;
  top.classList.remove('show');
});

// ---- Clock ----
function tickClock() {
  const d = new Date(), loc = localeFor(currentLang) + '-u-ca-gregory';
  try {
    $('#topClockDate').textContent = new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: ZAABOS_RESTAURANT_TZ }).format(d);
    $('#topClockTime').textContent = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ZAABOS_RESTAURANT_TZ }).format(d);
  } catch (e) {}
}
tickClock(); setInterval(tickClock, 15000);
setInterval(() => { if (me) refreshPosShiftBadge(); }, 60000);
