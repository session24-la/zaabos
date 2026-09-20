'use strict';
/* ZaabOS customer ordering page — no login required.
   Per-table QR (/order/<token>) auto-resolves the table. A generic QR
   (/order?branch_id=<id>, no table in the URL) falls back to forcing the
   customer to explicitly pick their table before the order can be confirmed
   — the hybrid design agreed with the shop owner. */

let menuData = null; // response from /api/public/menu
let cart = []; // {menu_item_id,name,unit_price,qty,selected_options,optionLabels,notes}
let orderType = 'dine_in';
let pickedTableId = null;
let publicTablesCache = null;

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

function fmtMoney(n) {
  const cur = (menuData && menuData.tenant && menuData.tenant.currency) || 'LAK';
  const symbols = { LAK: '₭', THB: '฿', USD: '$', CNY: '¥' };
  const sym = symbols[cur] || '';
  return sym + Math.round(Number(n) || 0).toLocaleString('en-US');
}
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
function openModal(sel) { $(sel).classList.add('show'); }
function closeModals() { $$('.modal').forEach(m => m.classList.remove('show')); }
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]') || e.target.classList.contains('modal')) closeModals();
});

function getTableTokenFromPath() {
  const m = location.pathname.match(/^\/order\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function loadMenu() {
  const token = getTableTokenFromPath();
  const params = new URLSearchParams(location.search);
  let url = '/api/public/menu?';
  if (token) url += 'table=' + encodeURIComponent(token);
  else if (params.get('branch_id')) url += 'branch_id=' + encodeURIComponent(params.get('branch_id'));
  else { showError('ไม่พบข้อมูลร้าน กรุณาสแกน QR โค้ดที่โต๊ะอีกครั้ง'); return; }

  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    const body = await r.json();
    if (!r.ok) { showError(body.error || 'ไม่พบข้อมูลร้าน'); return; }
    menuData = body;
    showMenu();
  } catch (e) { showError('เชื่อมต่อไม่ได้ กรุณาลองใหม่อีกครั้ง'); }
}

function showError(msg) {
  $('#loadingView').classList.add('hidden');
  $('#errorView').classList.remove('hidden');
  $('#errorMsg').textContent = msg;
}

function showMenu() {
  $('#loadingView').classList.add('hidden');
  $('#menuView').classList.remove('hidden');
  $('#ohIcon').textContent = menuData.tenant.icon || '🍽️';
  $('#ohName').textContent = menuData.tenant.name;
  if (menuData.table) {
    $('#ohTable').textContent = '📍 ' + menuData.table.name;
    $('#ohTable').classList.remove('hidden');
  }
  renderCategories();
  renderMenuGrid();
}

let activeCat = null;
function renderCategories() {
  const el = $('#catScroll');
  el.innerHTML = `<button class="cat-chip active" data-cat="">ทั้งหมด</button>` +
    menuData.categories.map(c => `<button class="cat-chip" data-cat="${c.id}">${escapeHtml(c.icon || '')} ${escapeHtml(c.name)}</button>`).join('');
}
$('#catScroll').addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-chip');
  if (!btn) return;
  activeCat = btn.dataset.cat || null;
  $$('#catScroll .cat-chip').forEach(b => b.classList.toggle('active', b === btn));
  renderMenuGrid();
});

function renderMenuGrid() {
  let items = menuData.items;
  if (activeCat) items = items.filter(i => String(i.category_id) === String(activeCat));
  const grid = $('#menuGrid');
  if (!items.length) { grid.innerHTML = `<div class="empty-state"><span class="es-ic">📋</span>ยังไม่มีเมนูในหมวดนี้</div>`; return; }
  grid.innerHTML = items.map(it => `
    <div class="menu-card ${it.sold_out ? 'sold-out' : ''}" data-pick="${it.id}" style="cursor:${it.sold_out ? 'default' : 'pointer'}">
      ${it.sold_out ? '<span class="mc-badge">หมด</span>' : ''}
      <span class="mc-name">${escapeHtml(it.name)}</span>
      ${it.description ? `<div class="mc-desc">${escapeHtml(it.description)}</div>` : ''}
      <div class="mc-price">${fmtMoney(it.base_price)}</div>
    </div>`).join('');
}
$('#menuGrid').addEventListener('click', (e) => {
  const box = e.target.closest('[data-pick]');
  if (!box) return;
  const item = menuData.items.find(x => x.id === parseInt(box.dataset.pick, 10));
  if (item.sold_out) return;
  openItemModal(item);
});

let pendingItem = null;
function openItemModal(item) {
  pendingItem = item;
  $('#itemModalTitle').textContent = item.name;
  $('#itemModalDesc').textContent = item.description || '';
  $('#itemNotes').value = ''; $('#itemQty').textContent = '1'; $('#itemError').textContent = '';
  const body = $('#itemModalBody');
  if (!item.option_groups.length) body.innerHTML = '';
  else body.innerHTML = item.option_groups.map(g => `
    <label style="margin:14px 0 4px">${escapeHtml(g.name)}${g.required ? ' <span style="color:var(--neg)">*</span>' : ''}</label>
    <div class="option-pick" data-group="${g.id}">
      ${g.options.map(o => `<label><input type="radio" name="ig-${g.id}" value="${o.id}" data-delta="${o.price_delta}">${escapeHtml(o.name)}${o.price_delta ? ` (+${fmtMoney(o.price_delta)})` : ''}</label>`).join('')}
    </div>`).join('');
  updateItemAddPrice();
  openModal('#itemModal');
}
$('#itemModalBody').addEventListener('change', (e) => {
  if (e.target.type !== 'radio') return;
  const group = e.target.closest('[data-group]');
  $$('label', group).forEach(l => l.classList.toggle('checked', l.querySelector('input').checked));
  updateItemAddPrice();
});
$('#itemMinus').addEventListener('click', () => { const q = Math.max(1, parseInt($('#itemQty').textContent, 10) - 1); $('#itemQty').textContent = q; updateItemAddPrice(); });
$('#itemPlus').addEventListener('click', () => { const q = Math.min(50, parseInt($('#itemQty').textContent, 10) + 1); $('#itemQty').textContent = q; updateItemAddPrice(); });
function currentItemUnitPrice() {
  let price = pendingItem.base_price;
  for (const g of pendingItem.option_groups) {
    const checked = $(`input[name="ig-${g.id}"]:checked`);
    if (checked) price += parseFloat(checked.dataset.delta) || 0;
  }
  return price;
}
function updateItemAddPrice() {
  const qty = parseInt($('#itemQty').textContent, 10);
  $('#itemAddPrice').textContent = fmtMoney(currentItemUnitPrice() * qty);
}
$('#itemAdd').addEventListener('click', () => {
  $('#itemError').textContent = '';
  const selected = {}; const labels = [];
  for (const g of pendingItem.option_groups) {
    const checked = $(`input[name="ig-${g.id}"]:checked`);
    if (g.required && !checked) { $('#itemError').textContent = `กรุณาเลือก "${g.name}"`; return; }
    if (checked) {
      const opt = g.options.find(o => String(o.id) === checked.value);
      selected[g.id] = opt.id; labels.push(opt.name);
    }
  }
  const qty = parseInt($('#itemQty').textContent, 10);
  cart.push({ menu_item_id: pendingItem.id, name: pendingItem.name, unit_price: currentItemUnitPrice(), qty, selected_options: selected, optionLabels: labels, notes: $('#itemNotes').value.trim() });
  closeModals();
  updateCartFab();
  toast('เพิ่มลงตะกร้าแล้ว', 'ok');
});

function cartTotal() { return cart.reduce((s, c) => s + c.unit_price * c.qty, 0); }
function updateCartFab() {
  const fab = $('#cartFab');
  if (!cart.length) { fab.classList.add('hidden'); return; }
  fab.classList.remove('hidden');
  const count = cart.reduce((s, c) => s + c.qty, 0);
  $('#cartFabCount').textContent = count + ' รายการ';
  $('#cartFabTotal').textContent = fmtMoney(cartTotal());
}
$('#cartFab').addEventListener('click', openCart);

async function openCart() {
  renderCartLines();
  $('#checkoutError').textContent = '';
  // reset order-type UI
  orderType = menuData.table ? 'dine_in' : orderType;
  $$('#orderTypePicker button').forEach(b => b.classList.toggle('active', b.dataset.type === orderType));
  await updateTableUi();
  updateDeliveryFieldsVisibility();
  openModal('#cartModal');
}
function renderCartLines() {
  const el = $('#cartLines');
  if (!cart.length) { el.innerHTML = '<p class="hint">ตะกร้าว่างเปล่า</p>'; $('#cartTotal').textContent = fmtMoney(0); return; }
  el.innerHTML = cart.map((c, idx) => `
    <div class="cart-line">
      <div><div class="cl-name">${c.qty}× ${escapeHtml(c.name)}</div>${c.optionLabels.length ? `<div class="cl-opts">${c.optionLabels.map(escapeHtml).join(', ')}</div>` : ''}${c.notes ? `<div class="cl-opts">หมายเหตุ: ${escapeHtml(c.notes)}</div>` : ''}</div>
      <div style="text-align:right"><div class="cl-price">${fmtMoney(c.unit_price * c.qty)}</div><button class="icon-btn danger" data-remove="${idx}">✕</button></div>
    </div>`).join('');
  $('#cartTotal').textContent = fmtMoney(cartTotal());
}
$('#cartLines').addEventListener('click', (e) => {
  const idx = e.target.dataset.remove;
  if (idx !== undefined) { cart.splice(idx, 1); renderCartLines(); updateCartFab(); if (!cart.length) closeModals(); }
});

$('#orderTypePicker').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  orderType = btn.dataset.type;
  $$('#orderTypePicker button').forEach(b => b.classList.toggle('active', b === btn));
  await updateTableUi();
  updateDeliveryFieldsVisibility();
});
function updateDeliveryFieldsVisibility() {
  $('#deliveryFields').classList.toggle('hidden', orderType !== 'delivery');
  $('#phoneOptionalRow').classList.toggle('hidden', orderType === 'delivery');
}
async function updateTableUi() {
  $('#tableResolvedRow').classList.add('hidden');
  $('#tablePickRow').classList.add('hidden');
  if (orderType !== 'dine_in') { pickedTableId = null; return; }
  if (menuData.table) {
    $('#tableResolvedRow').classList.remove('hidden');
    $('#tableResolvedDisplay').value = menuData.table.name;
    pickedTableId = menuData.table.id;
    return;
  }
  // Generic QR / no table detected — force explicit table selection.
  $('#tablePickRow').classList.remove('hidden');
  $('#tableSelectError').classList.add('hidden');
  if (!publicTablesCache) {
    try {
      const r = await fetch('/api/public/tables?branch_id=' + encodeURIComponent(menuData.branch_id), { credentials: 'same-origin' });
      publicTablesCache = (await r.json()).tables || [];
    } catch (e) { publicTablesCache = []; }
  }
  const grid = $('#tablePickGrid');
  if (!publicTablesCache.length) { grid.innerHTML = '<p class="hint">ร้านยังไม่ได้ตั้งค่าโต๊ะ กรุณาติดต่อพนักงาน</p>'; return; }
  grid.innerHTML = publicTablesCache.map(t => `<button type="button" data-table="${t.id}">${escapeHtml(t.name)}</button>`).join('');
}
$('#tablePickGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-table]');
  if (!btn) return;
  pickedTableId = parseInt(btn.dataset.table, 10);
  $$('#tablePickGrid button').forEach(b => b.classList.toggle('active', b === btn));
  $('#tableSelectError').classList.add('hidden');
});

$('#checkoutSubmit').addEventListener('click', async () => {
  $('#checkoutError').textContent = '';
  if (!cart.length) { $('#checkoutError').textContent = 'ตะกร้าว่างเปล่า'; return; }
  const customerName = $('#custName').value.trim();
  if (!customerName) { $('#checkoutError').textContent = 'กรุณากรอกชื่อผู้สั่ง'; return; }

  if (orderType === 'dine_in' && !pickedTableId) {
    $('#tableSelectError').classList.remove('hidden');
    $('#checkoutError').textContent = 'กรุณาเลือกโต๊ะก่อนยืนยันออเดอร์';
    return;
  }

  const payload = {
    branch_id: menuData.branch_id, order_type: orderType, customer_name: customerName,
    notes: $('#orderNotes').value.trim(),
    cart: cart.map(c => ({ menu_item_id: c.menu_item_id, quantity: c.qty, selected_options: c.selected_options, notes: c.notes })),
  };
  const token = getTableTokenFromPath();
  if (orderType === 'dine_in') {
    if (token) payload.table_token = token;
    else payload.table_id = pickedTableId;
  }
  if (orderType === 'delivery') {
    const phone = $('#custPhone').value.trim(), phoneConfirm = $('#custPhoneConfirm').value.trim();
    if (!phone || !phoneConfirm) { $('#checkoutError').textContent = 'กรุณากรอกเบอร์โทรทั้งสองช่อง'; return; }
    if (phone !== phoneConfirm) { $('#checkoutError').textContent = 'เบอร์โทรทั้งสองช่องไม่ตรงกัน กรุณาตรวจสอบอีกครั้ง'; return; }
    payload.customer_phone = phone;
    payload.customer_address = $('#custAddress').value.trim();
  } else {
    payload.customer_phone = $('#custPhoneOptional').value.trim();
  }

  try {
    const r = await fetch('/api/public/orders', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await r.json();
    if (!r.ok) { $('#checkoutError').textContent = body.error || 'เกิดข้อผิดพลาด'; return; }
    closeModals();
    cart = []; updateCartFab();
    $('#successOrderNo').textContent = '#' + body.order_no;
    const trackPhone = payload.customer_phone || '';
    $('#successTrackLink').href = '/track?order_no=' + encodeURIComponent(body.order_no) + '&phone=' + encodeURIComponent(trackPhone);
    openModal('#successModal');
  } catch (e) { $('#checkoutError').textContent = 'เชื่อมต่อไม่ได้ กรุณาลองใหม่'; }
});
$('#successNewOrderBtn').addEventListener('click', () => { closeModals(); });

loadMenu();
