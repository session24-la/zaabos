'use strict';
let me = null;
let branches = [];
let currentBranchId = null;
let pollTimer = null;
let lastOrders = [];

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
  opts.headers = opts.headers || {};
  opts.credentials = 'same-origin';
  if (opts.method && opts.method !== 'GET') opts.headers['X-CSRF-Token'] = (me && me.csrf_token) || '';
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch (e) {}
  if (r.status === 401) { me = null; showLogin(); throw new Error((body && body.error) || t('err_please_login')); }
  if (!r.ok) throw new Error((body && body.error) || t('err_generic'));
  return body;
}
function apiJson(url, method, data) { return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) }); }

function showLogin() { $('#boardView').classList.add('hidden'); $('#loginView').classList.remove('hidden'); if (pollTimer) clearInterval(pollTimer); }
function showBoard() { $('#loginView').classList.add('hidden'); $('#boardView').classList.remove('hidden'); }

// ===================== i18n wiring =====================

initLangSwitcher('#langSelect');
initLangSwitcher('#loginLangSelect');
applyI18n();
onLangChange(() => {
  applyI18n();
  if (branches.length) {
    const sel = $('#branchSelect');
    const cur = sel.value;
    sel.innerHTML = `<option value="">${escapeHtml(t('select_all_branches'))}</option>` + branches.map(b => `<option value="${b.id}">${escapeHtml(b.icon || '')} ${escapeHtml(b.name)}</option>`).join('');
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
  sel.innerHTML = `<option value="">${escapeHtml(t('select_all_branches'))}</option>` + branches.map(b => `<option value="${b.id}">${escapeHtml(b.icon || '')} ${escapeHtml(b.name)}</option>`).join('');
  sel.onchange = () => { currentBranchId = sel.value || null; loadBoard(); };
  loadBoard();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadBoard, 8000);
}

const STATUS_ACTIONS = {
  received: [{ to: 'preparing', labelKey: 'kt_btn_start', cls: 'btn-preparing' }, { to: 'cancelled', labelKey: 'kt_btn_cancel', cls: 'btn-cancel' }],
  preparing: [{ to: 'ready', labelKey: 'kt_btn_ready', cls: 'btn-ready' }, { to: 'cancelled', labelKey: 'kt_btn_cancel', cls: 'btn-cancel' }],
  ready: [{ to: 'served', labelKey: 'kt_btn_served', cls: 'btn-served' }],
};
function orderTypeLabel(s) { return t('order_type_' + s) || s; }

async function loadBoard() {
  const qs = new URLSearchParams();
  if (currentBranchId) qs.set('branch_id', currentBranchId);
  let all = [];
  try {
    for (const status of ['received', 'preparing', 'ready']) {
      const q2 = new URLSearchParams(qs); q2.set('status', status);
      const r = await api('/api/orders?' + q2.toString());
      all = all.concat(r.orders);
    }
  } catch (e) { return; }
  all.sort((a, b) => a.id - b.id);
  renderBoard(all);
}

function renderBoard(orders) {
  lastOrders = orders;
  const board = $('#board');
  if (!orders.length) { board.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><span class="es-ic">👨‍🍳</span>${escapeHtml(t('empty_kitchen_queue'))}</div>`; return; }
  board.innerHTML = orders.map(o => {
    const itemsHtml = o.items.map(it => `<li><b>${it.quantity}×</b> ${escapeHtml(it.item_name_snapshot)}
      ${it.options.length ? `<div class="kt-opts">${it.options.map(op => escapeHtml(op.option_name_snapshot)).join(', ')}</div>` : ''}
      ${it.notes ? `<div class="kt-notes">📝 ${escapeHtml(it.notes)}</div>` : ''}</li>`).join('');
    const actions = (STATUS_ACTIONS[o.status] || []).map(a => `<button class="${a.cls}" data-set="${o.id}:${a.to}">${escapeHtml(t(a.labelKey))}</button>`).join('');
    return `<div class="kitchen-ticket ${o.status}">
      <div class="kt-head"><span class="kt-no">#${escapeHtml(o.order_no)}</span><span class="kt-time">${new Date(o.created_at).toLocaleTimeString(localeFor(currentLang), { hour: '2-digit', minute: '2-digit' })}</span></div>
      <div class="kt-table">${escapeHtml(orderTypeLabel(o.order_type))}${o.table_name_snapshot ? ' · ' + escapeHtml(o.table_name_snapshot) : ''} · ${escapeHtml(o.customer_name)}</div>
      <ul>${itemsHtml}</ul>
      ${o.notes ? `<div class="kt-notes">📝 ${escapeHtml(o.notes)}</div>` : ''}
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

(async function initApp() {
  try { me = await api('/api/me'); await afterLogin(); } catch (e) { showLogin(); }
})();
