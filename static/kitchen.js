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

'use strict';
let me = null;
let branches = [];
let currentBranchId = null;
let pollTimer = null;
let lastOrders = [];
let statusFilter = '';
// Inside the POS (Version E sidebar → ครัว) the page runs framed: no own header/back link, branch from the POS.
const KITCHEN_PARAMS = new URLSearchParams(location.search);
const KITCHEN_EMBED = KITCHEN_PARAMS.get('embed') === '1';
if (KITCHEN_EMBED) document.documentElement.classList.add('kitchen-embed');
// Inside the POS the kitchen follows the POS screen mode (blue-white unless dark was picked); the stand-alone KDS stays dark.
if (KITCHEN_EMBED) try { const m = localStorage.getItem('zaabos_theme_f'); if (m !== 'dark' && !(m === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.dataset.theme = 'light'; } catch (e) { document.documentElement.dataset.theme = 'light'; }

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  const silent = opts.silent; // true for the background board refresh — see loadBoard()
  opts.headers = opts.headers || {};
  opts.credentials = 'same-origin';
  if (opts.method && opts.method !== 'GET') opts.headers['X-CSRF-Token'] = (me && me.csrf_token) || '';
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch (e) {}
  if (r.status === 401) {
    // Same fix as the admin app: the 8-second poll must not force this screen
    // back to login on its own — only an actual user action should.
    if (!silent) { me = null; showLogin(); }
    throw new Error((body && body.error) || t('err_please_login'));
  }
  if (!r.ok) throw new Error((body && body.error) || t('err_generic'));
  return body;
}
function apiJson(url, method, data) { return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) }); }

function hideKitchenBoot(){ const el=$('#kitchenBootView'); if(el) el.classList.add('hidden'); }
function showLogin() { hideKitchenBoot(); $('#boardView').classList.add('hidden'); $('#loginView').classList.remove('hidden'); if (pollTimer) clearInterval(pollTimer); }
function showBoard() { hideKitchenBoot(); $('#loginView').classList.add('hidden'); $('#boardView').classList.remove('hidden'); }

// ===================== i18n wiring =====================

initLangSwitcher('#langSelect');
initLangSwitcher('#loginLangSelect');
applyI18n();
onLangChange(() => {
  applyI18n();
  if (branches.length) {
    const sel = $('#branchSelect');
    const cur = sel.value;
    sel.innerHTML = `<option value="">${escapeHtml(t('select_all_branches'))}</option>` + branches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    sel.value = cur;
  }
  renderBoard(lastOrders);
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#loginUsername').value.trim(), password: $('#loginPassword').value }) });
    const body = await r.json();
    if (!r.ok) { $('#loginError').textContent = body.error || t('err_login_failed'); return; }
    me = body;
    await afterLogin();
  } catch (err) { $('#loginError').textContent = t('err_connect_failed'); }
});

async function afterLogin() {
  showBoard();
  const boot = await api('/api/bootstrap');
  branches = boot.branches;
  const sel = $('#branchSelect');
  sel.innerHTML = `<option value="">${escapeHtml(t('select_all_branches'))}</option>` + branches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  sel.onchange = () => { currentBranchId = sel.value || null; loadKitchenStations(); loadBoard(); soUpdateCount(); };
  const wanted = KITCHEN_PARAMS.get('branch');
  if (wanted && branches.some(b => String(b.id) === wanted)) { sel.value = wanted; currentBranchId = wanted; }
  else if (KITCHEN_EMBED && branches.length === 1) { sel.value = String(branches[0].id); currentBranchId = sel.value; }
  await loadKitchenStations();
  loadBoard(); soRefresh();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadBoard, 2500);
}


async function loadKitchenStations(){
  const sel=$('#kitchenStationFilter'); if(!sel)return;
  const qs=new URLSearchParams(); if(currentBranchId)qs.set('branch_id',currentBranchId);
  try{
    const rows=await api('/api/kitchen/stations?'+qs.toString(),{silent:true});
    const cur=sel.value;
    sel.innerHTML='<option value="">ทุกสถานี</option>'+rows.map(x=>`<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
    if(rows.some(x=>String(x.id)===cur))sel.value=cur;
  }catch(e){}
}
const kitchenStationFilter=$('#kitchenStationFilter'); if(kitchenStationFilter) kitchenStationFilter.addEventListener('change',loadBoard);

const STATUS_ACTIONS = {
  received: [{ to: 'ready', labelKey: 'kt_btn_ready', cls: 'btn-ready' }, { to: 'cancelled', labelKey: 'kt_btn_cancel', cls: 'btn-cancel' }],
  preparing: [{ to: 'ready', labelKey: 'kt_btn_ready', cls: 'btn-ready' }, { to: 'cancelled', labelKey: 'kt_btn_cancel', cls: 'btn-cancel' }],
  ready: [{ to: 'served', labelKey: 'kt_btn_served', cls: 'btn-served' }],
};
function orderTypeLabel(s) { return t('order_type_' + s) || s; }

async function loadBoard() {
  const qs = new URLSearchParams();
  if (currentBranchId) qs.set('branch_id', currentBranchId);
  const station=$('#kitchenStationFilter'); if(station && station.value) qs.set('station_id',station.value);
  try {
    const r = await api('/api/kitchen/orders?' + qs.toString(), { silent: true });
    const all = r.orders || [];
    // Tables the floor asked to rush come first; otherwise first come, first served.
    all.sort((a, b) => (isRushed(b) - isRushed(a)) || a.id - b.id);
    renderBoard(all);
  } catch (e) { return; }
}

function isRushed(o) { return (o.items || []).some(it => it.rush_at && it.kitchen_sent_at && Number(it.quantity || 0) > Number(it.cancelled_quantity || 0)) ? 1 : 0; }
const KITCHEN_HIGHLIGHT_MS = 3 * 60 * 1000; // how long a "sent to kitchen" flag stays pulsing before it fades to a plain timestamp

const KITCHEN_FILTERS = [['', 'ทั้งหมด'], ['received', 'ใหม่'], ['preparing', 'กำลังทำ'], ['ready', 'พร้อมเสิร์ฟ']];
function renderFilterChips(all) {
  const box = $('#kitchenFilters'); if (!box) return;
  box.innerHTML = KITCHEN_FILTERS.map(([v, label]) => `<button type="button" class="chip ${v === statusFilter ? 'active' : ''}" data-kfilter="${v}">${escapeHtml(label)} <small>${all.filter(o => !v || o.status === v).length}</small></button>`).join('');
}
function renderBoard(allOrders) {
  lastOrders = allOrders;
  renderFilterChips(allOrders);
  const orders = allOrders.filter(o => !statusFilter || o.status === statusFilter);
  const board = $('#board');
  if (!orders.length) { board.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><span class="es-ic"><i class="ic ic-chef-hat" aria-hidden="true"></i></span>${escapeHtml(t('empty_kitchen_queue'))}</div>`; return; }
  board.innerHTML = orders.map(o => {
    const itemsHtml = o.items.filter(it => it.kitchen_sent_at).map(it => {
      let liClass = '', sentBadge = '';
      const cancelled = Number(it.cancelled_quantity || 0);
      const activeQty = Math.max(0, Number(it.quantity || 0) - cancelled);
      const age = Date.now() - new Date(it.kitchen_sent_at).getTime();
      const clock = zaabosTime(it.kitchen_sent_at);
      liClass = age >= 0 && age < KITCHEN_HIGHLIGHT_MS ? ' kt-item-highlight' : ' kt-item-sent';
      sentBadge = `<span class="kt-sent-badge"><i class="ic ic-bell" aria-hidden="true"></i> ${clock}</span>`;
      const cancelNote = cancelled > 0 ? `<div class="kt-cancelled"><i class="ic ic-circle-x" aria-hidden="true"></i> ${escapeHtml(t('kt_cancelled_qty') || 'Cancelled')} ${cancelled}${it.cancellation_reason ? ' · ' + escapeHtml(it.cancellation_reason) : ''}</div>` : '';
      const active = (activeQty > 0 ? `<b>${activeQty}×</b> ${escapeHtml(it.item_name_snapshot)}` : `<s>${escapeHtml(it.item_name_snapshot)}</s>`) + (it.item_name2_snapshot ? `<div class="kt-name2">${escapeHtml(it.item_name2_snapshot)}</div>` : '');
      return `<li class="${liClass}${activeQty === 0 ? ' kt-item-cancelled' : ''}">${active} ${sentBadge}
      ${it.options.length ? `<div class="kt-opts">${it.options.map(op => escapeHtml(op.option_name_snapshot)).join(', ')}</div>` : ''}
      ${it.notes ? `<div class="kt-notes"><i class="ic ic-notebook-pen" aria-hidden="true"></i> ${escapeHtml(it.notes)}</div>` : ''}${cancelNote}
      ${activeQty > 0 && (Number(it.takeaway) || it.rush_at) ? `<div class="kt-tags">${it.rush_at ? '<span class="kt-tag kt-tag-rush"><i class="ic ic-flame" aria-hidden="true"></i> เร่ง / ເລັ່ງ</span>' : ''}${Number(it.takeaway) ? '<span class="kt-tag kt-tag-take"><i class="ic ic-shopping-bag" aria-hidden="true"></i> ห่อกลับ / ຫໍ່ກັບ</span>' : ''}</div>` : ''}</li>`;
    }).join('');
    const actions = (STATUS_ACTIONS[o.status] || []).map(a => `<button class="${a.cls}" data-set="${o.id}:${a.to}">${escapeHtml(t(a.labelKey))}</button>`).join('');
    // Kitchen reads from a distance: the table is the headline, and the wait time turns orange/red.
    const firstSent = o.items.filter(it => it.kitchen_sent_at).map(it => new Date(it.kitchen_sent_at).getTime()).sort((a, b) => a - b)[0] || new Date(o.created_at).getTime();
    const mins = Math.max(0, Math.floor((Date.now() - firstSent) / 60000));
    const waitCls = mins >= 20 ? 'kt-wait-late' : mins >= 10 ? 'kt-wait-slow' : '';
    const where = o.table_name_snapshot || orderTypeLabel(o.order_type);
    const count = o.items.filter(it => it.kitchen_sent_at && Number(it.quantity || 0) > Number(it.cancelled_quantity || 0)).length;
    return `<div class="kitchen-ticket ${o.status} ${waitCls}${isRushed(o) ? ' kt-rushed' : ''}">
      <div class="kt-head"><span class="kt-no">#${escapeHtml(String(o.order_no).split('-').pop())}</span><span class="kt-where">${escapeHtml(where)}</span><span class="kt-wait" data-since="${firstSent}">${mins} นาที</span></div>
      <div class="kt-table">${count} รายการ · ${escapeHtml(orderTypeLabel(o.order_type))} · ${zaabosTime(o.created_at)}${o.customer_name && o.customer_name !== 'ลูกค้า' ? ' · ' + escapeHtml(o.customer_name) : ''}</div>
      <ul>${itemsHtml}</ul>
      ${o.notes ? `<div class="kt-notes"><i class="ic ic-notebook-pen" aria-hidden="true"></i> ${escapeHtml(o.notes)}</div>` : ''}
      <div class="kt-actions">${actions}</div>
    </div>`;
  }).join('');
}
$('#board').addEventListener('click', (e) => {
  const s = e.target.dataset.set;
  if (!s) return;
  const [id, status] = s.split(':');
  apiJson('/api/orders/' + id + '/status', 'PUT', { status }).then(loadBoard).catch(err => toast(err.message, 'err'));
});
$('#refreshBtn').addEventListener('click', loadBoard);

// ---- Sold out from the kitchen: one tap, every POS / tablet / QR page follows ----
let soItems = [], soCats = [];
function soBranchItems() { return soItems.filter(it => !currentBranchId || String(it.branch_id) === String(currentBranchId)); }
function soUpdateCount() {
  const n = soBranchItems().filter(it => it.sold_out).length, el = $('#soldOutCount');
  el.textContent = n; el.classList.toggle('hidden', !n);
}
async function soRefresh() {
  try { const b = await api('/api/bootstrap', { silent: true }); soItems = b.items || []; soCats = b.categories || []; soUpdateCount(); } catch (e) {}
}
function soRender() {
  const q = ($('#soldOutSearch').value || '').trim().toLowerCase();
  const catName = id => (soCats.find(c => c.id === id) || {}).name || '';
  const multi = !currentBranchId && branches.length > 1;
  const rows = soBranchItems().filter(it => !q || (it.name + ' ' + (it.name_i18n || '')).toLowerCase().includes(q))
    .sort((a, b) => (b.sold_out ? 1 : 0) - (a.sold_out ? 1 : 0) || catName(a.category_id).localeCompare(catName(b.category_id)) || a.name.localeCompare(b.name));
  $('#soldOutList').innerHTML = rows.length ? rows.map(it => `<div class="so-row ${it.sold_out ? 'is-out' : ''}">
      <span class="so-name"><b>${escapeHtml(it.name)}</b><small>${escapeHtml(catName(it.category_id))}${multi ? ' · ' + escapeHtml((branches.find(b => b.id === it.branch_id) || {}).name || '') : ''}</small></span>
      <button type="button" class="so-toggle" data-so="${it.id}">${it.sold_out ? '<i class="ic ic-undo-2" aria-hidden="true"></i> มีของ' : '<i class="ic ic-ban" aria-hidden="true"></i> หมด'}</button>
    </div>`).join('') : `<div class="empty-state">ไม่พบเมนู</div>`;
}
$('#soldOutBtn').addEventListener('click', async () => { $('#soldOutSearch').value = ''; $('#soldOutModal').classList.add('show'); soRender(); await soRefresh(); soRender(); });
$('#soldOutSearch').addEventListener('input', soRender);
$('#soldOutList').addEventListener('click', async e => {
  const b = e.target.closest('[data-so]'); if (!b) return;
  const it = soItems.find(x => x.id === Number(b.dataset.so)); if (!it) return;
  const flag = !it.sold_out; b.disabled = true;
  try { await apiJson('/api/menu-items/' + it.id + '/sold-out', 'PUT', { sold_out: flag }); it.sold_out = flag; toast(`${it.name} · ${flag ? 'หมดแล้ว' : 'กลับมาขายแล้ว'}`, 'ok'); }
  catch (err) { toast(err.message, 'err'); }
  soUpdateCount(); soRender();
});
document.addEventListener('click', e => {
  if (e.target.closest('[data-close]') || e.target.classList.contains('modal')) (e.target.closest('.modal') || e.target).classList.remove('show');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal.show').forEach(m => m.classList.remove('show')); });
$('#kitchenFilters').addEventListener('click', e => { const b = e.target.closest('[data-kfilter]'); if (!b) return; statusFilter = b.dataset.kfilter; renderBoard(lastOrders); });

(async function initApp() {
  try { me = await api('/api/me'); await afterLogin(); } catch (e) { showLogin(); }
})();

// Keep the wait counters and colours live between refreshes.
setInterval(() => {
  document.querySelectorAll('.kt-wait[data-since]').forEach(el => {
    const mins = Math.max(0, Math.floor((Date.now() - Number(el.dataset.since)) / 60000));
    el.textContent = mins + ' นาที';
    const card = el.closest('.kitchen-ticket');
    if (card) { card.classList.toggle('kt-wait-slow', mins >= 10 && mins < 20); card.classList.toggle('kt-wait-late', mins >= 20); }
  });
}, 30000);
