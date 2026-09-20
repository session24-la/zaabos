'use strict';
/* ZaabOS admin/staff SPA. Vanilla JS, no build step — same approach as CASHFLOW24. */

let me = null;
let boot = { branches: [], tables: [], categories: [], items: [] };
let currentBranchId = null;
let optGroupsDraft = []; // working copy while editing a menu item's option groups
let cart = []; // staff take-order cart: {menu_item_id,name,unit_price,qty,selected_options:{gid:oid},optionLabels,notes}
let pendingCartItem = null; // item being configured in the option picker

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
  opts.headers = opts.headers || {};
  opts.credentials = 'same-origin';
  if (opts.method && opts.method !== 'GET') {
    opts.headers['X-CSRF-Token'] = (me && me.csrf_token) || '';
  }
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch (e) { /* no body */ }
  if (r.status === 401) {
    me = null;
    showLogin();
    throw new Error((body && body.error) || 'กรุณาเข้าสู่ระบบ');
  }
  if (!r.ok) throw new Error((body && body.error) || 'เกิดข้อผิดพลาด');
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
    if (!r.ok) { $('#loginError').textContent = body.error || 'เข้าสู่ระบบไม่สำเร็จ'; return; }
    me = body;
    await afterLogin();
  } catch (err) { $('#loginError').textContent = 'เชื่อมต่อไม่ได้ กรุณาลองใหม่'; }
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
  const roleLabels = { super_admin: 'ผู้ดูแลระบบ', owner: 'เจ้าของร้าน', manager: 'ผู้จัดการ', staff: 'พนักงาน' };
  $('#whoRole').textContent = roleLabels[me.role] || me.role;

  if (me.role === 'super_admin') {
    $('#tenantSwitcher').classList.remove('hidden');
    $('#tenantsTabBtn').classList.remove('hidden');
    const sel = $('#tenantSwitcher');
    sel.innerHTML = '<option value="all">ทุกร้าน</option>' + (me.tenants || []).map(t => `<option value="${t.id}">${escapeHtml(t.icon || '')} ${escapeHtml(t.name)}</option>`).join('');
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
}

function applyRoleVisibility() {
  const isOwner = me.role === 'owner' || me.role === 'super_admin';
  const isManagerPlus = isOwner || me.role === 'manager';
  $$('.tabs button[data-tab="branches"], .tabs button[data-tab="users"]').forEach(b => {
    b.classList.toggle('hidden', !isOwner);
  });
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
  tab = tab || activeTab();
  if (tab === 'orders') loadOrders();
  else if (tab === 'tables') renderTables();
  else if (tab === 'menu') renderMenu();
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
  if (!current || !next) { $('#pwError').textContent = 'กรุณากรอกข้อมูลให้ครบ'; return; }
  if (next.length < 6) { $('#pwError').textContent = 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร'; return; }
  try {
    await apiJson('/api/change-password', 'POST', { current_password: current, new_password: next });
    me.must_change_password = false;
    closeModals(); toast('เปลี่ยนรหัสผ่านสำเร็จ', 'ok');
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
  if (!newUsername || !pw) { $('#usernameError').textContent = 'กรุณากรอกข้อมูลให้ครบ'; return; }
  if (newUsername.length < 3) { $('#usernameError').textContent = 'ชื่อผู้ใช้ต้องยาวอย่างน้อย 3 ตัวอักษร'; return; }
  try {
    const r = await apiJson('/api/change-username', 'POST', { new_username: newUsername, password: pw });
    me.username = r.username; $('#whoName').textContent = me.display_name || me.username;
    closeModals(); toast('เปลี่ยนชื่อผู้ใช้สำเร็จ', 'ok');
  } catch (e) { $('#usernameError').textContent = e.message; }
});

// ===================== Branches =====================

function renderBranches() {
  const list = $('#branchesList');
  if (!boot.branches.length) { list.innerHTML = emptyState('🏠', 'ยังไม่มีสาขา'); return; }
  list.innerHTML = boot.branches.map(b => `
    <div class="row">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="avatar-badge">${escapeHtml(b.icon || '🏠')}</span>
        <div><div style="font-weight:700">${escapeHtml(b.name)}</div><small>รหัสสาขา #${b.id}</small></div>
      </div>
      <div class="row-right">
        <button class="icon-btn" data-edit-branch="${b.id}">✏️</button>
        <button class="icon-btn danger" data-del-branch="${b.id}">🗑️</button>
      </div>
    </div>`).join('');
}
$('#addBranchBtn').addEventListener('click', () => {
  $('#branchModalTitle').textContent = 'เพิ่มสาขา'; $('#branchId').value = ''; $('#branchIcon').value = '🏠'; $('#branchName').value = ''; $('#branchError').textContent = '';
  openModal('#branchModal');
});
$('#branchesList').addEventListener('click', (e) => {
  const editId = e.target.dataset.editBranch, delId = e.target.dataset.delBranch;
  if (editId) {
    const b = boot.branches.find(x => x.id === parseInt(editId, 10));
    $('#branchModalTitle').textContent = 'แก้ไขสาขา'; $('#branchId').value = b.id; $('#branchIcon').value = b.icon; $('#branchName').value = b.name; $('#branchError').textContent = '';
    openModal('#branchModal');
  } else if (delId) {
    if (!confirm('ยืนยันการลบสาขานี้?')) return;
    apiJson('/api/branches/' + delId, 'DELETE').then(async () => { await loadBootstrap(); renderBranchSelect(); renderBranches(); toast('ลบสาขาแล้ว', 'ok'); }).catch(e => toast(e.message, 'err'));
  }
});
$('#branchSave').addEventListener('click', async () => {
  $('#branchError').textContent = '';
  const id = $('#branchId').value, name = $('#branchName').value.trim(), icon = $('#branchIcon').value.trim() || '🏠';
  if (!name) { $('#branchError').textContent = 'กรุณาใส่ชื่อสาขา'; return; }
  try {
    if (id) await apiJson('/api/branches/' + id, 'PUT', { name, icon });
    else await apiJson('/api/branches', 'POST', { name, icon });
    closeModals(); await loadBootstrap(); renderBranchSelect(); renderBranches(); toast('บันทึกแล้ว', 'ok');
  } catch (e) { $('#branchError').textContent = e.message; }
});

// ===================== Tables & QR =====================

function tableOrderUrl(token) { return location.origin + '/order/' + token; }

function renderTables() {
  const grid = $('#tableGrid');
  const tables = branchTables();
  if (!tables.length) { grid.innerHTML = emptyState('🍽️', 'ยังไม่มีโต๊ะในสาขานี้'); return; }
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
  $('#tableModalTitle').textContent = 'เพิ่มโต๊ะ'; $('#tableId').value = ''; $('#tableName').value = ''; $('#tableError').textContent = '';
  openModal('#tableModal');
});
$('#tableSave').addEventListener('click', async () => {
  $('#tableError').textContent = '';
  const id = $('#tableId').value, name = $('#tableName').value.trim();
  if (!name) { $('#tableError').textContent = 'กรุณาใส่ชื่อโต๊ะ'; return; }
  try {
    if (id) await apiJson('/api/tables/' + id, 'PUT', { name });
    else await apiJson('/api/tables', 'POST', { name, branch_id: currentBranchId });
    closeModals(); await loadBootstrap(); renderTables(); toast('บันทึกแล้ว', 'ok');
  } catch (e) { $('#tableError').textContent = e.message; }
});
$('#bulkAddTablesBtn').addEventListener('click', () => { $('#bulkTableError').textContent = ''; $('#bulkTableCount').value = 10; openModal('#bulkTableModal'); });
$('#bulkTableSave').addEventListener('click', async () => {
  $('#bulkTableError').textContent = '';
  const count = parseInt($('#bulkTableCount').value, 10);
  try {
    const r = await apiJson('/api/tables/bulk', 'POST', { branch_id: currentBranchId, count });
    closeModals(); await loadBootstrap(); renderTables(); toast(`สร้าง ${r.created} โต๊ะแล้ว`, 'ok');
  } catch (e) { $('#bulkTableError').textContent = e.message; }
});
$('#tableGrid').addEventListener('click', (e) => {
  const qrId = e.target.dataset.qr, editId = e.target.dataset.editTable, delId = e.target.dataset.delTable;
  if (qrId) showTableQr(parseInt(qrId, 10));
  else if (editId) {
    const t = boot.tables.find(x => x.id === parseInt(editId, 10));
    $('#tableModalTitle').textContent = 'แก้ไขโต๊ะ'; $('#tableId').value = t.id; $('#tableName').value = t.name; $('#tableError').textContent = '';
    openModal('#tableModal');
  } else if (delId) {
    if (!confirm('ยืนยันการลบโต๊ะนี้?')) return;
    apiJson('/api/tables/' + delId, 'DELETE').then(async () => { await loadBootstrap(); renderTables(); toast('ลบโต๊ะแล้ว', 'ok'); }).catch(e => toast(e.message, 'err'));
  }
});

function qrImgUrl(text, size) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size || 220}x${size || 220}&data=${encodeURIComponent(text)}`;
}
function showTableQr(tableId) {
  const t = boot.tables.find(x => x.id === tableId);
  const url = tableOrderUrl(t.qr_token);
  $('#qrModalTitle').textContent = 'QR โต๊ะ: ' + t.name;
  $('#qrModalBody').innerHTML = `
    <div style="text-align:center">
      <img src="${qrImgUrl(url)}" alt="QR" style="border-radius:16px;border:1px solid var(--border)">
      <p class="hint" style="word-break:break-all">${escapeHtml(url)}</p>
      <button class="ghost-btn" id="copyQrUrlBtn">📋 คัดลอกลิงก์</button>
      <a class="ghost-btn" href="${url}" target="_blank" style="text-decoration:none;display:inline-block;margin-left:8px">🔗 เปิดหน้าสั่งอาหาร</a>
    </div>`;
  $('#copyQrUrlBtn').onclick = () => { navigator.clipboard.writeText(url).then(() => toast('คัดลอกลิงก์แล้ว', 'ok')); };
  openModal('#qrModal');
}
$('#qrOverviewBtn').addEventListener('click', () => {
  const tables = branchTables();
  if (!tables.length) { toast('ยังไม่มีโต๊ะในสาขานี้', 'err'); return; }
  $('#qrModalTitle').textContent = 'QR โต๊ะทั้งหมด';
  $('#qrModalBody').innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px">` +
    tables.map(t => {
      const url = tableOrderUrl(t.qr_token);
      return `<div style="text-align:center"><img src="${qrImgUrl(url, 150)}" style="border-radius:12px;border:1px solid var(--border)"><div style="font-weight:700;margin-top:6px">${escapeHtml(t.name)}</div></div>`;
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
  if (!cats.length) { list.innerHTML = emptyState('🍜', 'ยังไม่มีหมวดหมู่เมนู'); return; }
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
    $('#categoryModalTitle').textContent = 'แก้ไขหมวดหมู่'; $('#categoryId').value = c.id; $('#categoryIcon').value = c.icon; $('#categoryName').value = c.name; $('#categoryError').textContent = '';
    openModal('#categoryModal');
  } else if (delId) {
    if (!confirm('ยืนยันการลบหมวดหมู่นี้?')) return;
    apiJson('/api/menu-categories/' + delId, 'DELETE').then(async () => { await loadBootstrap(); renderMenu(); toast('ลบแล้ว', 'ok'); }).catch(e => toast(e.message, 'err'));
  }
});
$('#addCategoryBtn').addEventListener('click', () => {
  $('#categoryModalTitle').textContent = 'เพิ่มหมวดหมู่'; $('#categoryId').value = ''; $('#categoryIcon').value = '🍜'; $('#categoryName').value = ''; $('#categoryError').textContent = '';
  openModal('#categoryModal');
});
$('#categorySave').addEventListener('click', async () => {
  $('#categoryError').textContent = '';
  const id = $('#categoryId').value, name = $('#categoryName').value.trim(), icon = $('#categoryIcon').value.trim() || '🍜';
  if (!name) { $('#categoryError').textContent = 'กรุณาใส่ชื่อหมวดหมู่'; return; }
  try {
    if (id) await apiJson('/api/menu-categories/' + id, 'PUT', { name, icon });
    else await apiJson('/api/menu-categories', 'POST', { name, icon, branch_id: currentBranchId });
    closeModals(); await loadBootstrap(); renderMenu(); toast('บันทึกแล้ว', 'ok');
  } catch (e) { $('#categoryError').textContent = e.message; }
});

function fillCategorySelect() {
  const sel = $('#menuItemCategory');
  const cats = branchCategories();
  sel.innerHTML = '<option value="">(ไม่มีหมวดหมู่)</option>' + cats.map(c => `<option value="${c.id}">${escapeHtml(c.icon || '')} ${escapeHtml(c.name)}</option>`).join('');
}

function renderMenuItemsGrid() {
  const items = branchItems();
  const grid = $('#menuItemsGrid');
  if (!items.length) { grid.innerHTML = emptyState('📋', 'ยังไม่มีเมนูในสาขานี้'); return; }
  grid.innerHTML = items.map(it => `
    <div class="menu-card ${it.sold_out ? 'sold-out' : ''}">
      ${it.sold_out ? '<span class="mc-badge">หมด</span>' : ''}
      <div class="mc-top"><span class="mc-name">${escapeHtml(it.name)}</span></div>
      ${it.description ? `<div class="mc-desc">${escapeHtml(it.description)}</div>` : ''}
      ${it.option_groups.length ? `<div class="hint">ตัวเลือก: ${it.option_groups.map(g => escapeHtml(g.name)).join(', ')}</div>` : ''}
      <div class="mc-price">${fmtMoney(it.base_price)}</div>
      <div class="mc-actions">
        <button class="ghost-btn" data-edit-item="${it.id}">✏️ แก้ไข</button>
        <button class="ghost-btn" data-toggle-soldout="${it.id}">${it.sold_out ? '✅ กลับมามีของ' : '🚫 แจ้งของหมด'}</button>
        <button class="ghost-btn" data-del-item="${it.id}">🗑️</button>
      </div>
    </div>`).join('');
}
$('#menuItemsGrid').addEventListener('click', (e) => {
  const editId = e.target.dataset.editItem, delId = e.target.dataset.delItem, soId = e.target.dataset.toggleSoldout;
  if (editId) openMenuItemModal(parseInt(editId, 10));
  else if (delId) {
    if (!confirm('ยืนยันการลบเมนูนี้?')) return;
    apiJson('/api/menu-items/' + delId, 'DELETE').then(async () => { await loadBootstrap(); renderMenu(); toast('ลบแล้ว', 'ok'); }).catch(e => toast(e.message, 'err'));
  } else if (soId) {
    const it = boot.items.find(x => x.id === parseInt(soId, 10));
    apiJson('/api/menu-items/' + soId + '/sold-out', 'PUT', { sold_out: !it.sold_out }).then(async () => { await loadBootstrap(); renderMenu(); }).catch(e => toast(e.message, 'err'));
  }
});

$('#addMenuItemBtn').addEventListener('click', () => openMenuItemModal(null));

function openMenuItemModal(id) {
  fillCategorySelect();
  $('#menuItemError').textContent = '';
  if (id) {
    const it = boot.items.find(x => x.id === id);
    $('#menuItemModalTitle').textContent = 'แก้ไขเมนู';
    $('#menuItemId').value = it.id;
    $('#menuItemName').value = it.name;
    $('#menuItemDesc').value = it.description || '';
    $('#menuItemCategory').value = it.category_id || '';
    $('#menuItemPrice').value = it.base_price;
    $('#menuItemSoldOut').checked = !!it.sold_out;
    optGroupsDraft = JSON.parse(JSON.stringify(it.option_groups || []));
  } else {
    $('#menuItemModalTitle').textContent = 'เพิ่มเมนู';
    $('#menuItemId').value = ''; $('#menuItemName').value = ''; $('#menuItemDesc').value = '';
    $('#menuItemCategory').value = ''; $('#menuItemPrice').value = ''; $('#menuItemSoldOut').checked = false;
    optGroupsDraft = [];
  }
  renderOptGroupsBox();
  openModal('#menuItemModal');
}

function renderOptGroupsBox() {
  const box = $('#optionGroupsBox');
  box.innerHTML = optGroupsDraft.map((g, gi) => `
    <div class="opt-group-box" data-gi="${gi}">
      <div class="og-head">
        <input placeholder="ชื่อกลุ่ม เช่น ขนาด" value="${escapeHtml(g.name || '')}" data-og-name="${gi}" style="margin:0">
        <label style="margin:0;display:flex;align-items:center;gap:4px;white-space:nowrap"><input type="checkbox" ${g.required ? 'checked' : ''} data-og-required="${gi}" style="width:auto">บังคับเลือก</label>
        <button type="button" data-og-del="${gi}" class="icon-btn danger">🗑️</button>
      </div>
      ${(g.options || []).map((o, oi) => `
        <div class="opt-row" data-oi="${oi}">
          <input placeholder="ชื่อตัวเลือก" value="${escapeHtml(o.name || '')}" data-opt-name="${gi}:${oi}">
          <input type="number" step="0.01" placeholder="+ราคา" value="${o.price_delta || 0}" data-opt-delta="${gi}:${oi}">
          <button type="button" data-opt-del="${gi}:${oi}" class="icon-btn danger">✕</button>
        </div>`).join('')}
      <button class="add-opt-btn" type="button" data-add-opt="${gi}">➕ เพิ่มตัวเลือก</button>
    </div>`).join('');
}
$('#addOptGroupBtn').addEventListener('click', () => { optGroupsDraft.push({ name: '', required: false, options: [] }); renderOptGroupsBox(); });
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
  const reqGi = e.target.dataset.ogRequired;
  if (reqGi !== undefined) optGroupsDraft[reqGi].required = e.target.checked;
});

$('#menuItemSave').addEventListener('click', async () => {
  $('#menuItemError').textContent = '';
  const id = $('#menuItemId').value;
  const name = $('#menuItemName').value.trim();
  const price = parseFloat($('#menuItemPrice').value);
  if (!name) { $('#menuItemError').textContent = 'กรุณาใส่ชื่อเมนู'; return; }
  if (isNaN(price) || price < 0) { $('#menuItemError').textContent = 'ราคาไม่ถูกต้อง'; return; }
  const payload = {
    name, description: $('#menuItemDesc').value.trim(), category_id: $('#menuItemCategory').value || null,
    base_price: price, sold_out: $('#menuItemSoldOut').checked, option_groups: optGroupsDraft,
  };
  try {
    if (id) await apiJson('/api/menu-items/' + id, 'PUT', payload);
    else await apiJson('/api/menu-items', 'POST', Object.assign({ branch_id: currentBranchId }, payload));
    closeModals(); await loadBootstrap(); renderMenu(); toast('บันทึกแล้ว', 'ok');
  } catch (e) { $('#menuItemError').textContent = e.message; }
});

// ===================== Users =====================

async function loadUsers() {
  const users = await api('/api/users');
  const list = $('#usersList');
  if (!users.length) { list.innerHTML = emptyState('👥', 'ยังไม่มีผู้ใช้งาน'); return; }
  const roleLabels = { owner: 'เจ้าของร้าน', manager: 'ผู้จัดการ', staff: 'พนักงาน' };
  list.innerHTML = users.map(u => `
    <div class="row">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="avatar-badge">${escapeHtml((u.display_name || u.username || '?').slice(0, 1).toUpperCase())}</span>
        <div><div style="font-weight:700">${escapeHtml(u.display_name)} ${u.active ? '' : '<small>(ปิดใช้งาน)</small>'}</div><small>@${escapeHtml(u.username)} · ${roleLabels[u.role] || u.role}</small></div>
      </div>
      <div class="row-right">
        <button class="icon-btn" data-edit-user="${u.id}">✏️</button>
        <button class="icon-btn danger" data-del-user="${u.id}">🗑️</button>
      </div>
    </div>`).join('');
  list.dataset.cache = JSON.stringify(users);
}
$('#addUserBtn').addEventListener('click', () => {
  $('#userModalTitle').textContent = 'เพิ่มผู้ใช้งาน'; $('#userId').value = ''; $('#userUsername').value = ''; $('#userUsername').disabled = false;
  $('#userDisplayName').value = ''; $('#userRole').value = 'staff'; $('#userPassword').value = ''; $('#userPasswordLbl').textContent = 'รหัสผ่าน';
  $('#userActiveRow').classList.add('hidden'); $('#userError').textContent = '';
  openModal('#userModal');
});
$('#usersList').addEventListener('click', (e) => {
  const editId = e.target.dataset.editUser, delId = e.target.dataset.delUser;
  const users = JSON.parse($('#usersList').dataset.cache || '[]');
  if (editId) {
    const u = users.find(x => x.id === parseInt(editId, 10));
    $('#userModalTitle').textContent = 'แก้ไขผู้ใช้งาน'; $('#userId').value = u.id; $('#userUsername').value = u.username; $('#userUsername').disabled = true;
    $('#userDisplayName').value = u.display_name; $('#userRole').value = u.role; $('#userPassword').value = ''; $('#userPasswordLbl').textContent = 'ตั้งรหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)';
    $('#userActiveRow').classList.remove('hidden'); $('#userActive').checked = !!u.active; $('#userError').textContent = '';
    openModal('#userModal');
  } else if (delId) {
    if (!confirm('ยืนยันการปิดใช้งานบัญชีนี้?')) return;
    apiJson('/api/users/' + delId, 'DELETE').then(() => { loadUsers(); toast('ปิดใช้งานแล้ว', 'ok'); }).catch(e => toast(e.message, 'err'));
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
      if (!username || !displayName || !password) { $('#userError').textContent = 'กรุณากรอกข้อมูลให้ครบ'; return; }
      await apiJson('/api/users', 'POST', { username, display_name: displayName, role, password });
    }
    closeModals(); loadUsers(); toast('บันทึกแล้ว', 'ok');
  } catch (e) { $('#userError').textContent = e.message; }
});

// ===================== Tenants (super_admin) =====================

async function loadTenants() {
  const r = await api('/api/tenants');
  const list = $('#tenantsList');
  if (!r.tenants.length) { list.innerHTML = emptyState('🏢', 'ยังไม่มีร้านค้า'); return; }
  list.innerHTML = r.tenants.map(t => `
    <div class="row">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="avatar-badge">${escapeHtml(t.icon || '🍽️')}</span>
        <div><div style="font-weight:700">${escapeHtml(t.name)}</div><small>${t.active ? 'ใช้งานอยู่' : 'ถูกระงับ'} · ${escapeHtml(t.currency)}</small></div>
      </div>
      <div class="row-right"><button class="icon-btn danger" data-del-tenant="${t.id}">🗑️</button></div>
    </div>`).join('');
}
$('#tenantsList').addEventListener('click', (e) => {
  const delId = e.target.dataset.delTenant;
  if (delId) {
    if (!confirm('ยืนยันการระงับร้านค้านี้?')) return;
    apiJson('/api/tenants/' + delId, 'DELETE').then(() => { loadTenants(); toast('ระงับร้านค้าแล้ว', 'ok'); }).catch(e => toast(e.message, 'err'));
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
    closeModals(); toast('สร้างร้านค้าใหม่แล้ว', 'ok');
  } catch (e) { $('#tenantError').textContent = e.message; }
});

// ===================== Orders (staff view) =====================

const STATUS_LABELS = { received: 'รับออเดอร์แล้ว', preparing: 'กำลังทำ', ready: 'พร้อมเสิร์ฟ', served: 'เสิร์ฟแล้ว', completed: 'เสร็จสิ้น', cancelled: 'ยกเลิก' };
const STATUS_FLOW = { received: 'preparing', preparing: 'ready', ready: 'served', served: 'completed' };
const ORDER_TYPE_LABELS = { dine_in: '🍽️ ทานที่ร้าน', takeaway: '🥡 กลับบ้าน', delivery: '🛵 เดลิเวอรี่' };

async function loadOrders() {
  const status = $('#orderStatusFilter').value;
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  const r = await api('/api/orders?' + qs.toString());
  renderOrdersList(r.orders);
}
$('#orderStatusFilter').addEventListener('change', loadOrders);
$('#refreshOrdersBtn').addEventListener('click', loadOrders);

function renderOrdersList(orders) {
  const list = $('#ordersList');
  if (!orders.length) { list.innerHTML = emptyState('🧾', 'ยังไม่มีออเดอร์'); return; }
  list.innerHTML = orders.map(o => {
    const nextStatus = STATUS_FLOW[o.status];
    const itemsHtml = o.items.map(it => `<li><b>${it.quantity}×</b> ${escapeHtml(it.item_name_snapshot)}${it.options.length ? ` <span class="hint">(${it.options.map(op => escapeHtml(op.option_name_snapshot)).join(', ')})</span>` : ''}</li>`).join('');
    return `
    <div class="order-card" style="margin-top:12px">
      <div class="oc-head">
        <div>
          <div class="oc-no">#${escapeHtml(o.order_no)} — ${ORDER_TYPE_LABELS[o.order_type] || o.order_type}${o.table_name_snapshot ? ' · ' + escapeHtml(o.table_name_snapshot) : ''}</div>
          <div class="oc-meta">${escapeHtml(o.customer_name)}${o.customer_phone ? ' · ' + escapeHtml(o.customer_phone) : ''} · ${new Date(o.created_at).toLocaleString('th-TH')}</div>
        </div>
        <div style="text-align:right">
          <span class="pill ${o.status}"><span class="pill-dot ${o.status}"></span>${STATUS_LABELS[o.status]}</span><br>
          <span class="pill ${o.payment_status}" style="margin-top:6px">${o.payment_status === 'paid' ? 'ชำระแล้ว' : 'ยังไม่ชำระ'}</span>
        </div>
      </div>
      <ul class="oc-items">${itemsHtml}</ul>
      ${o.notes ? `<div class="hint">หมายเหตุ: ${escapeHtml(o.notes)}</div>` : ''}
      <div class="row" style="border-top:1px dashed var(--border)"><b>รวม</b><b>${fmtMoney(o.total_amount)}</b></div>
      <div class="head-actions" style="margin-top:8px">
        ${nextStatus ? `<button class="ghost-btn primary" data-set-status="${o.id}:${nextStatus}">➡️ ${STATUS_LABELS[nextStatus]}</button>` : ''}
        ${o.status !== 'cancelled' && o.status !== 'completed' ? `<button class="ghost-btn" data-set-status="${o.id}:cancelled">✕ ยกเลิก</button>` : ''}
        ${o.payment_status === 'unpaid' ? `<button class="ghost-btn" data-set-payment="${o.id}:paid">💰 บันทึกว่าชำระแล้ว</button>` : `<button class="ghost-btn" data-set-payment="${o.id}:unpaid">↩️ ยกเลิกการชำระ</button>`}
      </div>
    </div>`;
  }).join('');
}
$('#ordersList').addEventListener('click', (e) => {
  const s = e.target.dataset.setStatus, p = e.target.dataset.setPayment;
  if (s) { const [id, status] = s.split(':'); apiJson('/api/orders/' + id + '/status', 'PUT', { status }).then(loadOrders).catch(err => toast(err.message, 'err')); }
  else if (p) { const [id, payment_status] = p.split(':'); apiJson('/api/orders/' + id + '/payment', 'PUT', { payment_status }).then(loadOrders).catch(err => toast(err.message, 'err')); }
});

// ===================== Staff take-order =====================

let takeOrderType = 'dine_in';

$('#takeOrderBtn').addEventListener('click', () => {
  cart = []; takeOrderType = 'dine_in';
  $$('#takeOrderType button').forEach(b => b.classList.toggle('active', b.dataset.type === 'dine_in'));
  $('#takeOrderTableRow').classList.remove('hidden'); $('#takeOrderDeliveryFields').classList.add('hidden');
  $('#takeOrderCustomerName').value = ''; $('#takeOrderPhone').value = ''; $('#takeOrderAddress').value = '';
  $('#takeOrderError').textContent = '';
  const tsel = $('#takeOrderTable');
  tsel.innerHTML = branchTables().map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  renderTakeOrderCategories();
  renderTakeOrderMenu();
  renderCart();
  openModal('#takeOrderModal');
});
$('#takeOrderType').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  takeOrderType = btn.dataset.type;
  $$('#takeOrderType button').forEach(b => b.classList.toggle('active', b === btn));
  $('#takeOrderTableRow').classList.toggle('hidden', takeOrderType !== 'dine_in');
  $('#takeOrderDeliveryFields').classList.toggle('hidden', takeOrderType !== 'delivery');
});

let takeOrderActiveCat = null;
function renderTakeOrderCategories() {
  const cats = branchCategories();
  takeOrderActiveCat = null;
  const el = $('#takeOrderCatScroll');
  el.innerHTML = `<button class="cat-chip active" data-cat="">ทั้งหมด</button>` + cats.map(c => `<button class="cat-chip" data-cat="${c.id}">${escapeHtml(c.icon || '')} ${escapeHtml(c.name)}</button>`).join('');
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
  if (!items.length) { grid.innerHTML = emptyState('📋', 'ไม่มีเมนู'); return; }
  grid.innerHTML = items.map(it => `
    <div class="menu-card ${it.sold_out ? 'sold-out' : ''}" data-pick-item="${it.id}" style="cursor:${it.sold_out ? 'default' : 'pointer'}">
      ${it.sold_out ? '<span class="mc-badge">หมด</span>' : ''}
      <span class="mc-name">${escapeHtml(it.name)}</span>
      <div class="mc-price">${fmtMoney(it.base_price)}</div>
    </div>`).join('');
}
$('#takeOrderMenuGrid').addEventListener('click', (e) => {
  const id = e.target.closest('[data-pick-item]');
  if (!id) return;
  const item = boot.items.find(x => x.id === parseInt(id.dataset.pickItem, 10));
  if (item.sold_out) return;
  openItemOptionPicker(item);
});

function openItemOptionPicker(item) {
  pendingCartItem = { item, selected: {}, qty: 1, notes: '' };
  $('#itemOptionTitle').textContent = item.name;
  $('#itemOptionNotes').value = ''; $('#itemOptionQty').textContent = '1'; $('#itemOptionError').textContent = '';
  const body = $('#itemOptionBody');
  if (!item.option_groups.length) {
    body.innerHTML = `<p class="hint">ไม่มีตัวเลือกเพิ่มเติมสำหรับเมนูนี้</p>`;
  } else {
    body.innerHTML = item.option_groups.map(g => `
      <label style="margin:14px 0 4px">${escapeHtml(g.name)}${g.required ? ' <span style="color:var(--neg)">*</span>' : ''}</label>
      <div class="option-pick" data-group="${g.id}">
        ${g.options.map(o => `<label><input type="radio" name="grp-${g.id}" value="${o.id}" data-delta="${o.price_delta}">${escapeHtml(o.name)}${o.price_delta ? ` (+${fmtMoney(o.price_delta)})` : ''}</label>`).join('')}
      </div>`).join('');
  }
  openModal('#itemOptionModal');
}
$('#itemOptionBody').addEventListener('change', (e) => {
  if (e.target.type !== 'radio') return;
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
    const checked = $(`input[name="grp-${g.id}"]:checked`);
    if (g.required && !checked) { $('#itemOptionError').textContent = `กรุณาเลือก "${g.name}"`; return; }
    if (checked) {
      const opt = g.options.find(o => String(o.id) === checked.value);
      selected[g.id] = opt.id;
      unitPrice += opt.price_delta;
      labels.push(opt.name);
    }
  }
  const qty = parseInt($('#itemOptionQty').textContent, 10);
  cart.push({ menu_item_id: item.id, name: item.name, unit_price: unitPrice, qty, selected_options: selected, optionLabels: labels, notes: $('#itemOptionNotes').value.trim() });
  closeModals(); openModal('#takeOrderModal'); renderCart();
});

function renderCart() {
  const el = $('#takeOrderCart');
  if (!cart.length) { el.innerHTML = '<p class="hint">ยังไม่มีรายการในตะกร้า</p>'; $('#takeOrderTotal').textContent = fmtMoney(0); return; }
  let total = 0;
  el.innerHTML = cart.map((c, idx) => {
    const lineTotal = c.unit_price * c.qty; total += lineTotal;
    return `<div class="cart-line">
      <div><div class="cl-name">${c.qty}× ${escapeHtml(c.name)}</div>${c.optionLabels.length ? `<div class="cl-opts">${c.optionLabels.map(escapeHtml).join(', ')}</div>` : ''}${c.notes ? `<div class="cl-opts">หมายเหตุ: ${escapeHtml(c.notes)}</div>` : ''}</div>
      <div style="text-align:right"><div class="cl-price">${fmtMoney(lineTotal)}</div><button class="icon-btn danger" data-cart-remove="${idx}">✕</button></div>
    </div>`;
  }).join('');
  $('#takeOrderTotal').textContent = fmtMoney(total);
}
$('#takeOrderCart').addEventListener('click', (e) => {
  const idx = e.target.dataset.cartRemove;
  if (idx !== undefined) { cart.splice(idx, 1); renderCart(); }
});

$('#takeOrderSubmit').addEventListener('click', async () => {
  $('#takeOrderError').textContent = '';
  if (!cart.length) { $('#takeOrderError').textContent = 'กรุณาเลือกเมนูอย่างน้อย 1 รายการ'; return; }
  const payload = {
    branch_id: currentBranchId, order_type: takeOrderType,
    customer_name: $('#takeOrderCustomerName').value.trim() || 'ลูกค้า',
    cart: cart.map(c => ({ menu_item_id: c.menu_item_id, quantity: c.qty, selected_options: c.selected_options, notes: c.notes })),
  };
  if (takeOrderType === 'dine_in') payload.table_id = parseInt($('#takeOrderTable').value, 10);
  if (takeOrderType === 'delivery') { payload.customer_phone = $('#takeOrderPhone').value.trim(); payload.customer_address = $('#takeOrderAddress').value.trim(); }
  try {
    const r = await apiJson('/api/orders', 'POST', payload);
    closeModals(); toast('บันทึกออเดอร์ #' + r.order_no + ' แล้ว', 'ok'); loadOrders();
  } catch (e) { $('#takeOrderError').textContent = e.message; }
});

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
