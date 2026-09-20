'use strict';
const $ = (s, el) => (el || document).querySelector(s);

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(n, currency) {
  const symbols = { LAK: '₭', THB: '฿', USD: '$', CNY: '¥' };
  return (symbols[currency] || '') + Math.round(Number(n) || 0).toLocaleString('en-US');
}

const STATUS_STEPS = ['received', 'preparing', 'ready', 'served', 'completed'];

// ===================== i18n wiring =====================

initLangSwitcher('#langSelect');
applyI18n();
onLangChange(() => { applyI18n(); if (lastOrder) renderResult(lastOrder); });

let lastOrder = null;

async function lookup() {
  const orderNo = $('#orderNoInput').value.trim();
  const phone = $('#phoneInput').value.trim();
  $('#lookupError').textContent = '';
  if (!orderNo || !phone) { $('#lookupError').textContent = t('err_fill_order_phone'); return; }
  try {
    const r = await fetch('/api/public/orders/track', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({order_no:orderNo, phone}), credentials:'same-origin' });
    const body = await r.json();
    if (!r.ok) { $('#lookupError').textContent = body.error || t('err_order_not_found'); return; }
    renderResult(body.order);
  } catch (e) { $('#lookupError').textContent = t('err_connect_failed'); }
}
$('#lookupBtn').addEventListener('click', lookup);
$('#phoneInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookup(); });

function renderResult(order) {
  lastOrder = order;
  $('#resultPanel').classList.remove('hidden');
  const cancelled = order.status === 'cancelled';
  let stepsHtml = '';
  if (!cancelled) {
    const currentIdx = STATUS_STEPS.indexOf(order.status);
    stepsHtml = `<div class="status-track">` + STATUS_STEPS.map((s, i) => {
      const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : '';
      return `<div class="st-step ${cls}"><div class="st-dot">${i < currentIdx ? '✓' : ''}</div><div class="st-label">${escapeHtml(t('status_' + s))}</div></div>`;
    }).join('') + `</div>`;
  }
  const itemsHtml = order.items.map(it => `<li><b>${it.quantity}×</b> ${escapeHtml(it.item_name_snapshot)}${it.options.length ? ` <span class="hint">(${it.options.map(o => escapeHtml(o.option_name_snapshot)).join(', ')})</span>` : ''}</li>`).join('');
  $('#resultPanel').innerHTML = `
    <div class="order-card">
      <div class="oc-head">
        <div>
          <div class="oc-no">#${escapeHtml(order.order_no)}</div>
          <div class="oc-meta">${escapeHtml(order.customer_name)} · ${new Date(order.created_at).toLocaleString(localeFor(currentLang))}</div>
        </div>
        <span class="pill ${order.status}"><span class="pill-dot ${order.status}"></span>${escapeHtml(t('status_' + order.status))}</span>
      </div>
      ${stepsHtml}
      <ul class="oc-items">${itemsHtml}</ul>
      <div class="row" style="border-top:1px dashed var(--border)"><b>${escapeHtml(t('label_total_short'))}</b><b>${fmtMoney(order.total_amount)}</b></div>
      <div class="row"><span>${escapeHtml(t('label_payment_status'))}</span><span class="pill ${order.payment_status}">${escapeHtml(order.payment_status === 'paid' ? t('payment_paid') : t('payment_unpaid'))}</span></div>
    </div>`;
}

// Pre-fill from query string (linked from the order-success screen)
(function initFromQuery() {
  const params = new URLSearchParams(location.search);
  const orderNo = params.get('order_no') || '';
  if (orderNo) $('#orderNoInput').value = orderNo;
  let savedPhone = '';
  try { savedPhone = sessionStorage.getItem('zaabos_track_phone_'+orderNo) || ''; } catch(e) {}
  if (savedPhone) { $('#phoneInput').value = savedPhone; lookup(); }
})();
