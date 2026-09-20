'use strict';
const $ = (s, el) => (el || document).querySelector(s);

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(n, currency) {
  const symbols = { LAK: '₭', THB: '฿', USD: '$', CNY: '¥' };
  return (symbols[currency] || '') + Math.round(Number(n) || 0).toLocaleString('en-US');
}

const STATUS_LABELS = { received: 'รับออเดอร์แล้ว', preparing: 'กำลังทำ', ready: 'พร้อมเสิร์ฟ', served: 'เสิร์ฟแล้ว', completed: 'เสร็จสิ้น', cancelled: 'ยกเลิก' };
const STATUS_STEPS = ['received', 'preparing', 'ready', 'served', 'completed'];

async function lookup() {
  const orderNo = $('#orderNoInput').value.trim();
  const phone = $('#phoneInput').value.trim();
  $('#lookupError').textContent = '';
  if (!orderNo || !phone) { $('#lookupError').textContent = 'กรุณากรอกเลขที่ออเดอร์และเบอร์โทร'; return; }
  try {
    const r = await fetch('/api/public/orders/track?order_no=' + encodeURIComponent(orderNo) + '&phone=' + encodeURIComponent(phone), { credentials: 'same-origin' });
    const body = await r.json();
    if (!r.ok) { $('#lookupError').textContent = body.error || 'ไม่พบออเดอร์'; return; }
    renderResult(body.order);
  } catch (e) { $('#lookupError').textContent = 'เชื่อมต่อไม่ได้ กรุณาลองใหม่'; }
}
$('#lookupBtn').addEventListener('click', lookup);
$('#phoneInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookup(); });

function renderResult(order) {
  $('#resultPanel').classList.remove('hidden');
  const cancelled = order.status === 'cancelled';
  let stepsHtml = '';
  if (!cancelled) {
    const currentIdx = STATUS_STEPS.indexOf(order.status);
    stepsHtml = `<div class="status-track">` + STATUS_STEPS.map((s, i) => {
      const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : '';
      return `<div class="st-step ${cls}"><div class="st-dot">${i < currentIdx ? '✓' : ''}</div><div class="st-label">${STATUS_LABELS[s]}</div></div>`;
    }).join('') + `</div>`;
  }
  const itemsHtml = order.items.map(it => `<li><b>${it.quantity}×</b> ${escapeHtml(it.item_name_snapshot)}${it.options.length ? ` <span class="hint">(${it.options.map(o => escapeHtml(o.option_name_snapshot)).join(', ')})</span>` : ''}</li>`).join('');
  $('#resultPanel').innerHTML = `
    <div class="order-card">
      <div class="oc-head">
        <div>
          <div class="oc-no">#${escapeHtml(order.order_no)}</div>
          <div class="oc-meta">${escapeHtml(order.customer_name)} · ${new Date(order.created_at).toLocaleString('th-TH')}</div>
        </div>
        <span class="pill ${order.status}"><span class="pill-dot ${order.status}"></span>${STATUS_LABELS[order.status]}</span>
      </div>
      ${stepsHtml}
      <ul class="oc-items">${itemsHtml}</ul>
      <div class="row" style="border-top:1px dashed var(--border)"><b>รวม</b><b>${fmtMoney(order.total_amount)}</b></div>
      <div class="row"><span>สถานะการชำระเงิน</span><span class="pill ${order.payment_status}">${order.payment_status === 'paid' ? 'ชำระแล้ว' : 'ยังไม่ชำระ'}</span></div>
    </div>`;
}

// Pre-fill from query string (linked from the order-success screen)
(function initFromQuery() {
  const params = new URLSearchParams(location.search);
  if (params.get('order_no')) $('#orderNoInput').value = params.get('order_no');
  if (params.get('phone')) $('#phoneInput').value = params.get('phone');
  if (params.get('order_no') && params.get('phone')) lookup();
})();
