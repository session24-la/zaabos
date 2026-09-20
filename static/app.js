'use strict';
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
  catch (e) { if (!silent) toast('การเชื่อมต่อขัดข้อง กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง','err'); throw new Error('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้'); }
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
    throw new Error((body && body.error) || t('err_please_login'));
  }
  if (!r.ok) {
    const fallback = r.status >= 500 ? 'ระบบบันทึกข้อมูลขัดข้อง กรุณาลองอีกครั้ง' : t('err_generic');
    throw new Error((body && body.error) || fallback);
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
  $$('.tabs button[data-tab="reports"], .tabs button[data-tab="pricing"]').forEach(b => b.classList.toggle('hidden', !isManagerPlus));
  $('#addTableBtn').classList.toggle('hidden', !isManagerPlus);
  $('#bulkAddTablesBtn').classList.toggle('hidden', !isManagerPlus);
  $('#addCategoryBtn').classList.toggle('hidden', !isManagerPlus);
  $('#addMenuItemBtn').classList.toggle('hidden', !isManagerPlus);
}

// ===================== Bootstrap / branch scope =====================

async function loadBootstrap() {
  boot = await api('/api/bootstrap');
  if (!currentBranchId || !boot.branches.some(b => b.id === currentBranchId)) {
    currentBranchId = boot.branches.length ? boot.branches[0].id : null;
  }
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
  if (btn) switchTab(btn.dataset.tab);
});

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
  if (tab === 'orders') { loadOrders(); loadBoardData(); }
  else if (tab === 'tables') renderTables();
  else if (tab === 'menu') loadBootstrap().then(renderMenu); // re-fetch so stock counts (which change from orders placed elsewhere — staff or customer QR) are current whenever this tab is opened
  else if (tab === 'pricing') loadPricing();
  else if (tab === 'operations') loadOperations();
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
    <div class="report-card rc-profit ${profit < 0 ? 'rc-loss' : ''}"><div class="rc-label">${escapeHtml(t('label_net_profit'))}</div><div class="rc-value">${fmtMoney(profit)}</div></div>
  `;
  const labels={cash:'เงินสด',qr:'QR',card:'บัตร',bank_transfer:'โอนธนาคาร',other:'อื่น ๆ'};
  if (s.refund_total > 0) cards.insertAdjacentHTML('beforeend', `<div class="report-card"><div class="rc-label">คืนเงิน</div><div class="rc-value">-${fmtMoney(s.refund_total)}</div><div class="hint">${s.refund_count||0} รายการ · ยอดสุทธิ ${fmtMoney(s.net_sales)}</div></div>`);
  const pb=$('#paymentBreakdown'); if(pb) pb.innerHTML=(s.payment_breakdown||[]).length ? s.payment_breakdown.map(x=>`<div class="report-card"><div class="rc-label">${labels[x.payment_method]||escapeHtml(x.payment_method)}</div><div class="rc-value">${fmtMoney(x.total)}</div><div class="hint">${x.count} รายการ</div></div>`).join('') : emptyState('💳','ยังไม่มีรายการชำระเงิน');
}

async function loadDailyClosing() {
  if(!currentBranchId) return;
  const d=$('#closingDate').value || new Date().toISOString().slice(0,10); $('#closingDate').value=d;
  try { const r=await api(`/api/daily-closing?branch_id=${currentBranchId}&date=${encodeURIComponent(d)}`); const c=r.closing;
    $('#openingCash').value=c?c.opening_cash:0; $('#cashOut').value=c?c.cash_out:0; $('#countedCash').value=c?c.counted_cash:0; $('#closingNotes').value=c?c.notes:'';
    $('#closingPreview').textContent=`ยอดขายเงินสด: ${fmtMoney(r.cash_sales||0)}${c ? ` · เงินสดที่ควรมี ${fmtMoney(c.expected_cash)} · ส่วนต่าง ${fmtMoney(c.difference)}`:''}`;
  } catch(e){toast(e.message,'err');}
}
$('#loadClosingBtn').addEventListener('click',loadDailyClosing);
$('#saveClosingBtn').addEventListener('click',async()=>{ if(!currentBranchId)return; const btn=$('#saveClosingBtn'); btn.disabled=true;
  try { const r=await apiJson('/api/daily-closing','POST',{branch_id:currentBranchId,closing_date:$('#closingDate').value,opening_cash:$('#openingCash').value,cash_out:$('#cashOut').value,counted_cash:$('#countedCash').value,notes:$('#closingNotes').value});
    $('#closingPreview').textContent=`ยอดขายเงินสด: ${fmtMoney(r.cash_sales)} · เงินสดที่ควรมี ${fmtMoney(r.expected_cash)} · นับจริง ${fmtMoney(r.counted_cash)} · ส่วนต่าง ${fmtMoney(r.difference)}`; toast('บันทึกปิดยอดแล้ว','ok');
  } catch(e){toast(e.message,'err');} finally{btn.disabled=false;}
});

function renderTopItems(items) {
  const el = $('#reportTopItems');
  if (!items || !items.length) { el.innerHTML = emptyState('📊', t('label_no_data')); return; }
  el.innerHTML = items.map((it, i) => `
    <div class="top-item-row">
      <div><span class="top-item-rank">#${i + 1}</span>${escapeHtml(it.name)}</div>
      <div>${it.qty} ${escapeHtml(t('label_qty_short'))} · ${fmtMoney(it.revenue)}</div>
    </div>`).join('');
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

function renderMenu() {
  renderCategoriesList();
  renderMenuItemsGrid();
  fillCategorySelect();
}
function renderCategoriesList() {
  const cats = branchCategories();
  const list = $('#categoriesList');
  if (!cats.length) { list.innerHTML = emptyState('🍜', t('empty_categories')); return; }
  list.innerHTML = cats.map(c => `
    <div class="row">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="avatar-badge">${escapeHtml(c.icon || '🍜')}</span>
        <div style="font-weight:700">${escapeHtml(c.name)}</div>
      </div>
      <div class="row-right">
        <button class="icon-btn" data-edit-cat="${c.id}">✏️</button>
        <button class="icon-btn danger" data-del-cat="${c.id}">🗑️</button>
      </div>
    </div>`).join('');
}
$('#categoriesList').addEventListener('click', (e) => {
  const editId = e.target.dataset.editCat, delId = e.target.dataset.delCat;
  if (editId) {
    const c = boot.categories.find(x => x.id === parseInt(editId, 10));
    $('#categoryModalTitle').textContent = t('modal_edit_category_title'); $('#categoryId').value = c.id; $('#categoryIcon').value = c.icon; $('#categoryName').value = c.name; $('#categoryError').textContent = '';
    openModal('#categoryModal');
  } else if (delId) {
    if (!confirm(t('confirm_delete_category'))) return;
    apiJson('/api/menu-categories/' + delId, 'DELETE').then(async () => { await loadBootstrap(); renderMenu(); toast(t('toast_deleted'), 'ok'); }).catch(e => toast(e.message, 'err'));
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
  const items = branchItems();
  const grid = $('#menuItemsGrid');
  if (!items.length) { grid.innerHTML = emptyState('📋', t('empty_menu_items')); return; }
  grid.innerHTML = items.map(it => {
    const low = it.track_stock && it.stock_qty != null && it.stock_qty <= it.low_stock_threshold;
    return `
    <div class="menu-card ${it.sold_out ? 'sold-out' : ''}">
      ${it.sold_out ? `<span class="mc-badge">${escapeHtml(t('badge_sold_out'))}</span>` : (low ? `<span class="mc-badge-stock">${escapeHtml(it.stock_qty <= 0 ? t('badge_out_of_stock') : t('badge_low_stock'))}</span>` : '')}
      ${it.image_url ? `<img class="mc-photo" src="${it.image_url}" alt="">` : ''}
      <div class="mc-top"><span class="mc-name">${escapeHtml(it.name)}</span></div>
      ${it.description ? `<div class="mc-desc">${escapeHtml(it.description)}</div>` : ''}
      ${it.option_groups.length ? `<div class="hint">${escapeHtml(t('label_options_prefix'))}: ${it.option_groups.map(g => escapeHtml(g.name)).join(', ')}</div>` : ''}
      ${it.track_stock ? `<div class="mc-stock-info">📦 ${escapeHtml(t('label_stock_qty'))}: ${it.stock_qty != null ? it.stock_qty : 0}</div>` : ''}
      <div class="mc-price">${fmtMoney(it.base_price)}</div>
      <div class="mc-actions">
        <button class="ghost-btn" data-edit-item="${it.id}">${escapeHtml(t('btn_edit'))}</button>
        ${it.track_stock ? `<button class="ghost-btn" data-adjust-stock="${it.id}">${escapeHtml(t('btn_adjust_stock'))}</button>` : ''}
        <button class="ghost-btn" data-toggle-soldout="${it.id}">${escapeHtml(it.sold_out ? t('btn_mark_available') : t('btn_mark_sold_out'))}</button>
        <button class="ghost-btn" data-del-item="${it.id}">🗑️</button>
      </div>
    </div>`;
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

$('#addMenuItemBtn').addEventListener('click', () => openMenuItemModal(null));

function openMenuItemModal(id) {
  fillCategorySelect();
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
    optGroupsDraft = JSON.parse(JSON.stringify(it.option_groups || []));
    menuItemImageDraft = it.image_url || null;
  } else {
    $('#menuItemModalTitle').textContent = t('modal_add_menu_item_title');
    $('#menuItemId').value = ''; $('#menuItemName').value = ''; $('#menuItemDesc').value = '';
    $('#menuItemCategory').value = ''; $('#menuItemPrice').value = ''; $('#menuItemSoldOut').checked = false;
    $('#menuItemCostPrice').value = ''; $('#menuItemTrackStock').checked = false;
    $('#menuItemStockQty').value = ''; $('#menuItemLowStockThreshold').value = 5;
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

async function loadTenants() {
  const r = await api('/api/tenants');
  const list = $('#tenantsList');
  if (!r.tenants.length) { list.innerHTML = emptyState('🏢', t('empty_tenants')); return; }
  list.innerHTML = r.tenants.map(tn => `
    <div class="row">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="avatar-badge">${escapeHtml(tn.icon || '🍽️')}</span>
        <div><div style="font-weight:700">${escapeHtml(tn.name)}</div><small>${tn.active ? escapeHtml(t('tenant_active')) : escapeHtml(t('tenant_suspended'))} · ${escapeHtml(tn.currency)}</small></div>
      </div>
      <div class="row-right"><button class="icon-btn danger" data-del-tenant="${tn.id}">🗑️</button></div>
    </div>`).join('');
}
$('#tenantsList').addEventListener('click', (e) => {
  const delId = e.target.dataset.delTenant;
  if (delId) {
    if (!confirm(t('confirm_suspend_tenant'))) return;
    apiJson('/api/tenants/' + delId, 'DELETE').then(() => { loadTenants(); toast(t('toast_tenant_suspended'), 'ok'); }).catch(e => toast(e.message, 'err'));
  }
});
$('#addTenantBtn').addEventListener('click', () => {
  $('#tenantName').value = ''; $('#tenantOwnerUsername').value = ''; $('#tenantOwnerDisplay').value = ''; $('#tenantOwnerPassword').value = ''; $('#tenantError').textContent = '';
  openModal('#tenantModal');
});
$('#tenantSave').addEventListener('click', async () => {
  $('#tenantError').textContent = '';
  const payload = {
    name: $('#tenantName').value.trim(), owner_username: $('#tenantOwnerUsername').value.trim(),
    owner_display: $('#tenantOwnerDisplay').value.trim(), owner_password: $('#tenantOwnerPassword').value,
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
$('#refreshOrdersBtn').addEventListener('click', () => { loadOrders(); loadBoardData(); });

function fmtClock(iso) {
  try { return new Date(iso).toLocaleTimeString(localeFor(currentLang), { hour: '2-digit', minute: '2-digit' }); }
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
    const editControls = editable && activeQty > 0 ? `<span class="oc-edit-controls"><button type="button" class="mini-step" data-item-qty="${o.id}:${it.id}:${Math.max(1,activeQty-1)}" ${activeQty<=1?'disabled':''}>−</button><b>${activeQty}</b><button type="button" class="mini-step" data-item-qty="${o.id}:${it.id}:${activeQty+1}">+</button><button type="button" class="mini-cancel" data-cancel-item="${o.id}:${it.id}:${activeQty}">ยกเลิกรายการ</button></span>` : '';
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
          <div class="oc-meta">${escapeHtml(o.customer_name)}${o.customer_phone ? ' · ' + escapeHtml(o.customer_phone) : ''} · ${new Date(o.created_at).toLocaleString(localeFor(currentLang))}${o.scheduled_for ? ' · ⏰ '+escapeHtml(new Date(o.scheduled_for).toLocaleString(localeFor(currentLang))) : ''}${o.order_type==='delivery' && Number(o.delivery_fee||0)>0 ? ' · 🛵 '+fmtMoney(o.delivery_fee) : ''}</div>
        </div>
        <div style="text-align:right">
          <span class="pill ${o.status}"><span class="pill-dot ${o.status}"></span>${escapeHtml(statusLabel(o.status))}</span><br>
          <span class="pill ${o.payment_status}" style="margin-top:6px">${escapeHtml(o.payment_status === 'paid' ? t('payment_paid') : t('payment_unpaid'))}</span>
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
        ${o.payment_status === 'unpaid' ? `<button class="ghost-btn btn-confirm-pay" data-confirm-payment="${o.id}">${escapeHtml(t('btn_confirm_payment_done'))}</button>` : ''}
        <button class="ghost-btn" data-print-receipt="${o.id}">${escapeHtml(t('btn_print_receipt'))}</button>
        ${o.payment_status === 'paid' && (me.role === 'owner' || me.role === 'manager' || me.role === 'super_admin') ? `<button class="ghost-btn danger" data-refund-order="${o.id}">↩️ คืนเงิน</button>` : ''}
        ${o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn" data-merge-order="${o.id}">🔗 รวมบิล</button>` : ''}
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


async function criticalActionPayload(actionLabel) {
  const reason=prompt(`เหตุผล${actionLabel}:`);
  if(reason===null) return null;
  if(!reason.trim()){ toast('กรุณาระบุเหตุผล','err'); return null; }
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
  try{ await apiJson('/api/orders/'+id+'/status','PUT',payload); onOrderActionDone(); }catch(e){ toast(e.message,'err'); }
}

function wireOrderActionClicks(container) {
  container.addEventListener('click', (e) => {
    const s = e.target.dataset.setStatus, p = e.target.dataset.setPayment;
    const cp = e.target.dataset.confirmPayment, pr = e.target.dataset.printReceipt;
    const sk = e.target.dataset.sendKitchen, ai = e.target.dataset.addItems, mv = e.target.dataset.moveOrder;
    const rf = e.target.dataset.refundOrder, mg = e.target.dataset.mergeOrder, ff=e.target.dataset.fulfillment;
    const iq = e.target.dataset.itemQty, ci = e.target.dataset.cancelItem;
    if (ff) { const [oid,status]=ff.split(':'); apiJson(`/api/orders/${oid}/fulfillment`,'PUT',{fulfillment_status:status}).then(onOrderActionDone).catch(err=>toast(err.message,'err')); }
    else if (iq) { const [oid,iid,qty]=iq.split(':'); apiJson(`/api/orders/${oid}/items/${iid}/quantity`,'PUT',{quantity:Number(qty)}).then(onOrderActionDone).catch(err=>toast(err.message,'err')); }
    else if (ci) { const [oid,iid,qty]=ci.split(':'); cancelOrderItemCritical(oid,iid,qty); }
    else if (ai) { openAddItemsToOrder(parseInt(ai,10)); }
    else if (mv) { openMoveTable(parseInt(mv,10)); }
    else if (s) { const [id, status] = s.split(':'); setOrderStatusCritical(id,status); }
    else if (p) { const [id, payment_status] = p.split(':'); apiJson('/api/orders/' + id + '/payment', 'PUT', { payment_status }).then(onOrderActionDone).catch(err => toast(err.message, 'err')); }
    else if (cp) { openConfirmPaymentModal(parseInt(cp, 10)); }
    else if (pr) { printReceipt(parseInt(pr, 10)); }
    else if (rf) { refundOrder(parseInt(rf,10)); }
    else if (mg) { mergeOrder(parseInt(mg,10)); }
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

async function refundOrder(orderId) {
  const reason=prompt('เหตุผลการคืนเงิน:'); if(reason===null) return;
  if(!reason.trim()) { toast('กรุณาระบุเหตุผลการคืนเงิน','err'); return; }
  if(!confirm('ยืนยันคืนเงินเต็มจำนวนสำหรับบิลนี้? รายการจะถูกบันทึกในประวัติ')) return;
  try { const r=await apiJson(`/api/orders/${orderId}/refund`,'POST',{reason:reason.trim()}); toast(`บันทึกคืนเงิน ${fmtMoney(r.amount)} แล้ว`,'ok'); onOrderActionDone(); }
  catch(e){ toast(e.message,'err'); }
}
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

function onOrderActionDone() { loadOrders(); loadBoardData(); }

function findOrderById(orderId) {
  return activeOrders.find(x => x.id === orderId) || lastOrdersFlat.find(x => x.id === orderId);
}

let cpOrderId = null;

function updateCpChange() {
  const ord = findOrderById(cpOrderId);
  if (!ord) return;
  const tax = 0;
  const method = $('#cpMethod').value;
  const cash = method === 'cash' ? (parseFloat($('#cpCash').value) || 0) : 0;
  $('#cpCash').closest('label').classList.toggle('hidden', method !== 'cash');
  const manual = parseFloat($('#cpDiscount').value) || 0; const due = Math.max(0, ord.total_amount - manual) + tax;
  $('#cpChange').textContent = fmtMoney(cash > 0 ? Math.max(0, cash - due) : 0);
}
$('#cpDiscount').addEventListener('input', updateCpChange);
$('#cpCash').addEventListener('input', updateCpChange);
$('#cpMethod').addEventListener('change', updateCpChange);

function openConfirmPaymentModal(orderId) {
  const ord = findOrderById(orderId);
  if (!ord) return;
  cpOrderId = orderId;
  $('#cpTotal').textContent = fmtMoney(ord.total_amount);
  $('#cpPromo').value = ''; $('#cpDiscount').value = ''; $('#cpDiscountReason').value = ''; $('#cpApprovalUser').value=''; $('#cpApprovalPass').value='';
  $('#cpCash').value = ord.cash_received ? String(ord.cash_received) : '';
  $('#cpError').textContent = '';
  $('#cpMethod').value = ord.payment_method || 'cash';
  updateCpChange();
  openModal('#confirmPaymentModal');
}

$('#cpSubmit').addEventListener('click', async () => {
  if (cpOrderId == null) return;
  $('#cpError').textContent = '';
  const orderId = cpOrderId;
  const payload = { payment_status: 'paid', payment_method: $('#cpMethod').value };
  const promo=$('#cpPromo').value.trim(); if(promo) payload.promotion_code=promo; const disc=$('#cpDiscount').value.trim(); if(disc) payload.discount_amount=parseFloat(disc); const dr=$('#cpDiscountReason').value.trim(); if(dr) payload.discount_reason=dr; const au=$('#cpApprovalUser').value.trim(); const ap=$('#cpApprovalPass').value; if(au) payload.approval_username=au; if(ap) payload.approval_password=ap;
  const cashRaw = $('#cpCash').value.trim(); if (payload.payment_method === 'cash' && cashRaw) payload.cash_received = parseFloat(cashRaw);
  try {
    await apiJson('/api/orders/' + orderId + '/payment', 'PUT', payload);
    toast(t('toast_payment_confirmed'), 'ok');
    closeModals();
    cpOrderId = null;
    onOrderActionDone();
  } catch (e) { $('#cpError').textContent = e.message; }
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

function printReceipt(orderId) {
  const o = findOrderById(orderId);
  if (!o) return;
  const shopName = (me && me.tenant && me.tenant.name) || 'ZaabOS';
  const branch = (boot && boot.branches && boot.branches.find(b => Number(b.id) === Number(o.branch_id))) || null;
  const tax = Number(o.tax_amount || 0);
  const subtotal = Number(o.total_amount || 0);
  const discount = Number(o.discount_amount || 0);
  const service = Number(o.service_charge_amount || 0);
  const grandTotal = Math.max(0, subtotal - discount) + service + tax;
  const cash = (o.cash_received != null && o.cash_received !== '') ? Number(o.cash_received) : null;
  const change = cash != null ? Math.max(0, cash - grandTotal) : null;
  const paymentNames = {cash:'Cash / ເງິນສົດ',qr:'QR',card:'Card',bank_transfer:'Bank transfer',other:'Other'};
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
  $('#receiptPrintArea').innerHTML = `
    <div class="rp-brand">${escapeHtml(shopName)}</div>
    <div class="rp-brand-sub">RESTAURANT · POS</div>
    ${branch ? `<div class="rp-center">${escapeHtml(branch.name || '')}</div>` : ''}
    <div class="rp-sep"></div>
    <div class="rp-meta"><span>${escapeHtml(t('label_table') || 'Table')}</span><b>${escapeHtml(o.table_name_snapshot || orderTypeLabel(o.order_type))}</b><span>${escapeHtml(t('label_guest_count_short') || 'Guests')}</span><b>${escapeHtml(String(guest))}</b></div>
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
    ${o.payment_method ? `<div class="rp-row"><span>Payment</span><span>${escapeHtml(paymentNames[o.payment_method] || o.payment_method)}</span></div>` : ''}
    ${cash != null ? `<div class="rp-row"><span>${escapeHtml(t('label_cash_received'))}</span><span>${fmtMoney(cash)}</span></div>` : ''}
    ${change != null ? `<div class="rp-row"><span>${escapeHtml(t('label_change'))}</span><span>${fmtMoney(change)}</span></div>` : ''}
    <div class="rp-sep"></div>
    <div class="rp-footrow"><span>Order time</span><span>${createdAt.toLocaleString(localeFor(currentLang))}</span></div>
    ${paidAt ? `<div class="rp-footrow"><span>Paid time</span><span>${paidAt.toLocaleString(localeFor(currentLang))}</span></div>` : ''}
    ${o.created_by_name ? `<div class="rp-footrow"><span>Cashier</span><span>${escapeHtml(o.created_by_name)}</span></div>` : ''}
    <div class="rp-thanks">${escapeHtml(t('receipt_thank_you'))}</div>
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
    <div class="rp-sub">${new Date().toLocaleString(localeFor(currentLang))}</div>
    <div class="rp-line"></div>
    ${itemsHtml}
    ${o.notes ? `<div class="rp-line"></div><div class="kt-print-notes">📝 ${escapeHtml(o.notes)}</div>` : ''}`;
  printElement($('#kitchenTicketPrintArea'));
}

// ===================== Live table board + side panel =====================

let lastOrdersFlat = []; // most recent unfiltered branch order fetch (feeds board/panel + card lookups)
const STATUS_PRIORITY = { received: 0, preparing: 1, ready: 2, served: 3 };

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
  if (!orders.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  list.innerHTML = orders.map(o => sidePanelRowHtml(o)).join('');
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
    const sendPayload = addItemsOrderId ? {items: payload.cart} : payload;
    const r = await apiJson(endpoint, 'POST', sendPayload);
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
  const choices=branchTables().filter(tb=>tb.id!==ord.table_id && tableActiveOrders(tb.id).length===0);
  if(!choices.length){ toast('ไม่มีโต๊ะว่างสำหรับย้าย','err'); return; }
  const msg='เลือกหมายเลขโต๊ะปลายทาง:\n'+choices.map((tb,i)=>`${i+1}. ${tb.name}`).join('\n');
  const raw=prompt(msg,'1'); if(raw===null) return; const idx=Number(raw)-1; if(!choices[idx]){toast('เลือกโต๊ะไม่ถูกต้อง','err');return;}
  try{await apiJson(`/api/orders/${orderId}/move-table`,'PUT',{table_id:choices[idx].id}); closeModals(); toast(`ย้ายไป ${choices[idx].name} แล้ว`,'ok'); onOrderActionDone();}catch(e){toast(e.message,'err');}
}

// ===================== Misc =====================

function emptyState(icon, text) { return `<div class="empty-state"><span class="es-ic">${icon}</span>${escapeHtml(text)}</div>`; }

// ===================== Bootstrap on load =====================

(async function initApp() {
  try {
    me = await api('/api/me');
    await afterLogin();
  } catch (e) {
    showLogin();
  }
})();


// ===================== Round 14A Operations =====================
async function loadOperations() {
  if (!currentBranchId) return;
  try {
    const data = await api('/api/operations/shift?branch_id=' + currentBranchId);
    const sh = data.shift;
    $('#shiftStatus').innerHTML = sh ? `<div class="report-card"><div class="rc-label">สถานะกะ</div><div class="rc-value">เปิดอยู่</div></div><div class="report-card"><div class="rc-label">เงินเปิดกะ</div><div class="rc-value">${fmtMoney(sh.opening_cash)}</div></div><div class="report-card"><div class="rc-label">เปิดโดย</div><div class="rc-value">${escapeHtml(sh.opened_by_name||'')}</div></div>` : `<div class="report-card"><div class="rc-label">สถานะกะ</div><div class="rc-value">ยังไม่ได้เปิดกะ</div></div>`;
    $('#cashMovementList').innerHTML = data.movements.length ? data.movements.map(m=>`<div class="list-row"><div><b>${m.movement_type==='cash_in'?'เงินเข้า':'เงินออก'}</b><div class="muted">${escapeHtml(m.reason)} · ${escapeHtml(m.created_at)}</div></div><strong>${fmtMoney(m.amount)}</strong></div>`).join('') : emptyState('💵','ยังไม่มีรายการเงินสด');
    if ($('#criticalOpsList') && me && ['owner','manager','super_admin'].includes(me.role)) {
      const ops=await api('/api/operations/critical');
      $('#criticalOpsList').innerHTML=ops.length?ops.map(x=>`<div class="list-row"><div><b>${escapeHtml(x.operation_type)}</b><div class="muted">${escapeHtml(x.reason_text||'')} · ทำโดย ${escapeHtml(x.performed_by_name||'')} ${x.approved_by_name?'· อนุมัติโดย '+escapeHtml(x.approved_by_name):''}</div></div><span class="muted">${escapeHtml(x.created_at)}</span></div>`).join(''):emptyState('🛡️','ยังไม่มี Critical Operation');
    }
  } catch(e) { toast(e.message,'err'); }
}
async function opsPost(url, body) { try { await apiJson(url,'POST',body); toast('บันทึกแล้ว','ok'); $('#opsAmount').value=''; $('#opsReason').value=''; loadOperations(); } catch(e){ toast(e.message,'err'); } }
$('#refreshOpsBtn').onclick=()=>loadOperations();
$('#openShiftBtn').onclick=()=>opsPost('/api/operations/shift/open',{branch_id:currentBranchId,opening_cash:Number($('#opsAmount').value||0),notes:$('#opsReason').value});
$('#cashInBtn').onclick=()=>opsPost('/api/operations/cash-movement',{branch_id:currentBranchId,movement_type:'cash_in',amount:Number($('#opsAmount').value||0),reason:$('#opsReason').value});
$('#cashOutBtn').onclick=()=>opsPost('/api/operations/cash-movement',{branch_id:currentBranchId,movement_type:'cash_out',amount:Number($('#opsAmount').value||0),reason:$('#opsReason').value});
$('#closeShiftBtn').onclick=()=>opsPost('/api/operations/shift/close',{branch_id:currentBranchId,counted_cash:Number($('#opsAmount').value||0),notes:$('#opsReason').value});


// Round 14D pricing / promotions
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
