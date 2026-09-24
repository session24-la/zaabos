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

// ===================== i18n wiring =====================

initLangSwitcher('#langSelect');
applyI18n();
onLangChange(() => {
  applyI18n();
  if (menuData) {
    renderCategoryTiles();
    renderCategories();
    renderMenuGrid();
    updateCartFab();
    updateItemsViewTitle();
  }
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
  else { showError(t('err_shop_not_found')); return; }

  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    const body = await r.json();
    if (!r.ok) { showError(body.error || t('err_shop_not_found')); return; }
    menuData = body;
    showMenu();
  } catch (e) { showError(t('err_connect_failed')); }
}

function showError(msg) {
  $('#loadingView').classList.add('hidden');
  $('#errorView').classList.remove('hidden');
  $('#errorMsg').textContent = msg;
}

function showMenu() {
  $('#loadingView').classList.add('hidden');
  $('#menuView').classList.remove('hidden');
  $('#ohIcon').innerHTML = iconHtml(menuData.tenant.icon, 'utensils');
  $('#ohName').textContent = menuData.tenant.name;
  if (menuData.table) {
    $('#ohTable').textContent = ''+ menuData.table.name;
    $('#ohTable').classList.remove('hidden');
  }
  renderCategoryTiles();
  renderCategories();
  showCategoriesStage();
  startSoldOutWatch();
}

// Dishes that run out while the customer is browsing: the shop taps "หมด" and this page follows (~30 s),
// so nobody orders what the kitchen can't make.
let soldOutTimer = null;
function isSoldOut(id) { const it = menuData && menuData.items.find(x => x.id === id); return !!(it && it.sold_out); }
async function refreshSoldOut() {
  if (!menuData || !menuData.branch_id || document.hidden) return;
  try {
    const r = await fetch('/api/public/sold-out?branch_id=' + encodeURIComponent(menuData.branch_id), { credentials: 'same-origin' });
    if (!r.ok) return;
    const ids = new Set(((await r.json()).ids) || []);
    let changed = false;
    menuData.items.forEach(it => { const f = ids.has(it.id); if (!!it.sold_out !== f) { it.sold_out = f; changed = true; } });
    if (changed) { renderMenuGrid(); if ($('#cartModal').classList.contains('show')) renderCartLines(); }
  } catch (e) {}
}
function startSoldOutWatch() {
  if (soldOutTimer) clearInterval(soldOutTimer);
  soldOutTimer = setInterval(refreshSoldOut, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSoldOut(); });
}

// ===== Category drill-down: scan in -> shop name -> category tiles -> items =====
// Small menus can still jump straight to "view all"; the cat-scroll chip row
// inside the items view lets people switch categories without going back.
let menuStage = 'categories';
function showCategoriesStage() {
  menuStage = 'categories';
  $('#categoriesView').classList.remove('hidden');
  $('#itemsView').classList.add('hidden');
}
function showItemsStage(catId, title) {
  menuStage = 'items';
  activeCat = catId || null;
  $('#categoriesView').classList.add('hidden');
  $('#itemsView').classList.remove('hidden');
  renderCategories();
  renderMenuGrid();
  updateItemsViewTitle(title);
}
function updateItemsViewTitle(title) {
  if (title === undefined) {
    const c = activeCat ? menuData.categories.find(x => String(x.id) === String(activeCat)) : null;
    title = c ? c.name : t('cat_all');
  }
  $('#itemsViewTitle').textContent = title;
}
function renderCategoryTiles() {
  const el = $('#categoryTiles');
  const counts = {};
  menuData.items.forEach(it => { counts[it.category_id] = (counts[it.category_id] || 0) + 1; });
  const allTile = `<div class="category-tile ct-all" data-cat-tile="">
    <span class="ct-icon"><i class="ic ic-utensils" aria-hidden="true"></i></span><div class="ct-name">${escapeHtml(t('cat_view_all_tile'))}</div>
    <div class="ct-count">${escapeHtml(t('cat_items_count', { n: menuData.items.length }))}</div>
  </div>`;
  const catTiles = menuData.categories.map(c => `<div class="category-tile" data-cat-tile="${c.id}">
    <span class="ct-icon">${iconHtml(c.icon,'soup')}</span><div class="ct-name">${escapeHtml(c.name)}</div>
    <div class="ct-count">${escapeHtml(t('cat_items_count', { n: counts[c.id] || 0 }))}</div>
  </div>`).join('');
  el.innerHTML = allTile + catTiles;
}
$('#categoryTiles').addEventListener('click', (e) => {
  const tile = e.target.closest('[data-cat-tile]');
  if (!tile) return;
  const catId = tile.dataset.catTile || null;
  const cat = catId ? menuData.categories.find(c => String(c.id) === String(catId)) : null;
  showItemsStage(catId, cat ? cat.name : t('cat_view_all_tile'));
});
$('#backToCatsBtn').addEventListener('click', showCategoriesStage);

let activeCat = null;
function renderCategories() {
  const el = $('#catScroll');
  el.innerHTML = `<button class="cat-chip active" data-cat="">${escapeHtml(t('cat_all'))}</button>` +
    menuData.categories.map(c => `<button class="cat-chip" data-cat="${c.id}">${iconHtml(c.icon)} ${escapeHtml(c.name)}</button>`).join('');
  $$('#catScroll .cat-chip').forEach(b => b.classList.toggle('active', (b.dataset.cat || null) === activeCat));
}
$('#catScroll').addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-chip');
  if (!btn) return;
  activeCat = btn.dataset.cat || null;
  $$('#catScroll .cat-chip').forEach(b => b.classList.toggle('active', b === btn));
  renderMenuGrid();
  updateItemsViewTitle();
});

function renderMenuGrid() {
  let items = menuData.items;
  if (activeCat) items = items.filter(i => String(i.category_id) === String(activeCat));
  const grid = $('#menuGrid');
  if (!items.length) { grid.innerHTML = `<div class="empty-state"><span class="es-ic"><i class="ic ic-clipboard-list" aria-hidden="true"></i></span>${escapeHtml(t('empty_menu_category'))}</div>`; return; }
  grid.innerHTML = items.map(it => `
    <div class="menu-card ${it.sold_out ? 'sold-out' : ''}" data-pick="${it.id}" style="cursor:${it.sold_out ? 'default' : 'pointer'}">
      ${it.sold_out ? `<span class="mc-badge">${escapeHtml(t('badge_sold_out'))}</span>` : ''}
      ${it.image_url ? `<img class="mc-photo" src="${it.image_url}" alt="">` : ''}
      <span class="mc-name">${escapeHtml(qrNames(it).main)}</span>${qrNames(it).sub ? `<span class="mc-sub">${escapeHtml(qrNames(it).sub)}</span>` : ''}
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
  $('#itemModalTitle').textContent = qrNames(item).main;
  $('#itemModalDesc').textContent = item.description || '';
  $('#itemNotes').value = ''; $('#itemQty').textContent = '1'; $('#itemError').textContent = '';
  const body = $('#itemModalBody');
  const photoHtml = item.image_url ? `<img class="item-modal-photo" src="${item.image_url}" alt="">` : '';
  if (!item.option_groups.length) body.innerHTML = photoHtml;
  else body.innerHTML = photoHtml + item.option_groups.map(g => `
    <label style="margin:14px 0 4px">${escapeHtml(g.name)}${g.required ? ' <span style="color:var(--neg)">*</span>' : ''}</label>
    <div class="option-pick" data-group="${g.id}">
      ${g.options.map(o => `<label><input type="${g.selection_type === 'multiple' ? 'checkbox' : 'radio'}" name="ig-${g.id}" value="${o.id}" data-delta="${o.price_delta}">${escapeHtml(o.name)}${o.price_delta ? ` (+${fmtMoney(o.price_delta)})` : ''}</label>`).join('')}
      ${g.selection_type === 'multiple' ? `<div class="hint">เลือกได้สูงสุด ${g.max_select || 1} รายการ</div>` : ''}
    </div>`).join('');
  updateItemAddPrice();
  openModal('#itemModal');
}
$('#itemModalBody').addEventListener('change', (e) => {
  if (!['radio','checkbox'].includes(e.target.type)) return;
  const group = e.target.closest('[data-group]');
  $$('label', group).forEach(l => l.classList.toggle('checked', l.querySelector('input').checked));
  updateItemAddPrice();
});
$('#itemMinus').addEventListener('click', () => { const q = Math.max(1, parseInt($('#itemQty').textContent, 10) - 1); $('#itemQty').textContent = q; updateItemAddPrice(); });
$('#itemPlus').addEventListener('click', () => { const q = Math.min(50, parseInt($('#itemQty').textContent, 10) + 1); $('#itemQty').textContent = q; updateItemAddPrice(); });
function currentItemUnitPrice() {
  let price = pendingItem.base_price;
  for (const g of pendingItem.option_groups) {
    const checked = $$(`input[name="ig-${g.id}"]:checked`);
    checked.forEach(el => { price += parseFloat(el.dataset.delta) || 0; });
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
    const checked = $$(`input[name="ig-${g.id}"]:checked`);
    const minSel = Number(g.min_select != null ? g.min_select : (g.required ? 1 : 0));
    const maxSel = Number(g.selection_type === 'multiple' ? (g.max_select || 1) : 1);
    if (checked.length < minSel) { $('#itemError').textContent = `${t('err_choose_option_group')} "${g.name}"`; return; }
    if (checked.length > maxSel) { $('#itemError').textContent = `เลือก "${g.name}" ได้ไม่เกิน ${maxSel} รายการ`; return; }
    if (checked.length) {
      const opts = checked.map(el => g.options.find(o => String(o.id) === el.value)).filter(Boolean);
      selected[g.id] = g.selection_type === 'multiple' ? opts.map(o => o.id) : opts[0].id;
      opts.forEach(opt => labels.push(opt.name));
    }
  }
  const qty = parseInt($('#itemQty').textContent, 10);
  cart.push({ menu_item_id: pendingItem.id, name: qrNames(pendingItem).main, unit_price: currentItemUnitPrice(), qty, selected_options: selected, optionLabels: labels, notes: $('#itemNotes').value.trim() });
  closeModals();
  updateCartFab();
  toast(t('toast_added_to_cart'), 'ok');
});

function cartTotal() { return cart.reduce((s, c) => s + c.unit_price * c.qty, 0); }
function updateCartFab() {
  const fab = $('#cartFab');
  if (!cart.length) { fab.classList.add('hidden'); return; }
  fab.classList.remove('hidden');
  const count = cart.reduce((s, c) => s + c.qty, 0);
  $('#cartFabCount').textContent = t('cart_fab_count', { n: count });
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
  if (!cart.length) { el.innerHTML = `<p class="hint">${escapeHtml(t('empty_cart_customer'))}</p>`; $('#cartTotal').textContent = fmtMoney(0); return; }
  el.innerHTML = cart.map((c, idx) => `
    <div class="cart-line">
      <div><div class="cl-name">${c.qty}× ${escapeHtml(c.name)}${isSoldOut(c.menu_item_id) ? ` <span class="cl-out">${escapeHtml(t('badge_sold_out'))}</span>` : ''}</div>${c.optionLabels.length ? `<div class="cl-opts">${c.optionLabels.map(escapeHtml).join(', ')}</div>` : ''}${c.notes ? `<div class="cl-opts">${escapeHtml(t('label_notes'))}: ${escapeHtml(c.notes)}</div>` : ''}</div>
      <div style="text-align:right"><div class="cl-price">${fmtMoney(c.unit_price * c.qty)}</div><button class="icon-btn danger" data-remove="${idx}"><i class="ic ic-x" aria-hidden="true"></i></button></div>
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
  $('#scheduleRow').classList.toggle('hidden', orderType === 'dine_in');
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
  if (!publicTablesCache.length) { grid.innerHTML = `<p class="hint">${escapeHtml(t('err_no_tables_setup'))}</p>`; return; }
  grid.innerHTML = publicTablesCache.map(t2 => `<button type="button" data-table="${t2.id}">${escapeHtml(t2.name)}</button>`).join('');
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
  if (!cart.length) { $('#checkoutError').textContent = t('empty_cart_customer'); return; }
  if ($('#checkoutSubmit').disabled) return; // already submitting — ignore extra taps
  const customerName = $('#custName').value.trim(); // optional — server defaults it when blank

  if (orderType === 'dine_in' && !pickedTableId) {
    $('#tableSelectError').classList.remove('hidden');
    $('#checkoutError').textContent = t('err_pick_table_first');
    return;
  }

  const payload = {
    branch_id: menuData.branch_id, order_type: orderType, customer_name: customerName,
    notes: $('#orderNotes').value.trim(),
    scheduled_for: orderType === 'dine_in' ? null : ($('#scheduledFor').value || null),
    cart: cart.map(c => ({ menu_item_id: c.menu_item_id, quantity: c.qty, selected_options: c.selected_options, notes: c.notes })),
  };
  const token = getTableTokenFromPath();
  if (orderType === 'dine_in') {
    if (token) payload.table_token = token;
    else payload.table_id = pickedTableId;
  }
  if (orderType === 'delivery') {
    const phone = $('#custPhone').value.trim(), phoneConfirm = $('#custPhoneConfirm').value.trim();
    if (!phone || !phoneConfirm) { $('#checkoutError').textContent = t('err_phone_both_required'); return; }
    if (phone !== phoneConfirm) { $('#checkoutError').textContent = t('err_phone_mismatch'); return; }
    payload.customer_phone = phone;
    payload.customer_address = $('#custAddress').value.trim();
  } else {
    payload.customer_phone = $('#custPhoneOptional').value.trim();
  }

  const btn = $('#checkoutSubmit');
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.textContent = t('btn_submitting') || originalLabel;
  try {
    const r = await fetch('/api/public/orders', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    const raw = await r.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (e) {}
    if (!r.ok) {
      $('#checkoutError').textContent = body.error || (r.status >= 500
        ? 'ระบบบันทึกออเดอร์ขัดข้อง กรุณาลองอีกครั้ง'
        : t('err_generic'));
      return;
    }
    if (!body || !body.order_no) {
      $('#checkoutError').textContent = 'ไม่ได้รับเลขออเดอร์จากระบบ กรุณาลองอีกครั้ง';
      return;
    }
    closeModals();
    cart = []; updateCartFab();
    $('#successOrderNo').textContent = '#' + body.order_no;
    const trackPhone = payload.customer_phone || '';
    try { sessionStorage.setItem('zaabos_track_phone_'+body.order_no, trackPhone); } catch(e) {}
    $('#successTrackLink').href = '/track?order_no=' + encodeURIComponent(body.order_no);
    openModal('#successModal');
  } catch (e) { $('#checkoutError').textContent = t('err_connect_failed'); }
  finally { btn.disabled = false; btn.textContent = originalLabel; }
});
$('#successNewOrderBtn').addEventListener('click', () => { closeModals(); });

loadMenu();

// Customer sees the dish in the language they picked on their phone when the shop entered it,
// with the shop's second language (or the main name) underneath.
function qrNames(it) {
  let n = {}; try { n = typeof it.name_i18n === 'object' ? (it.name_i18n || {}) : JSON.parse(it.name_i18n || '{}'); } catch (e) {}
  const L = (menuData && menuData.menu_langs) || {};
  const shopMain = (L.primary && n[L.primary]) || it.name;
  const main = n[currentLang] || shopMain;
  let sub = L.secondary && n[L.secondary] && n[L.secondary] !== main ? n[L.secondary] : '';
  if (!sub && main !== shopMain) sub = shopMain;
  return { main, sub };
}
