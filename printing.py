"""Direct network printing for ZaabOS Local (receipt + kitchen) — no browser print dialog.

Thermal printers such as the Rongta RP331 accept ESC/POS on raw TCP port 9100 over Wi-Fi/LAN.
Tickets are rendered to a bitmap with Pillow and sent as an ESC/POS raster image, so Thai, Lao
and English print correctly without depending on the printer's built-in code pages.

The worker runs only on the shop PC (the cloud cannot reach a printer on the shop Wi-Fi).
Every ticket is a row in kitchen_print_jobs: pending -> printed, or failed after retries, so
staff can always see what did not print and print it again.
"""
import json
import os
import socket
import sys
import threading
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

PAPER_DOTS = {'80': 576, '58': 384}
MAX_ATTEMPTS = 4
RETRY_SECONDS = 5

# ------------------------------------------------------------------ fonts ---
_FONT_CANDIDATES = {
    # Latin + Thai
    'thai': ['/System/Library/Fonts/Supplemental/Tahoma.ttf', 'C:/Windows/Fonts/LeelawUI.ttf', 'C:/Windows/Fonts/tahoma.ttf',
             '/usr/share/fonts/truetype/tlwg/Garuda.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
    'thai_bold': ['/System/Library/Fonts/Supplemental/Tahoma Bold.ttf', 'C:/Windows/Fonts/LeelaUIb.ttf', 'C:/Windows/Fonts/tahomabd.ttf',
                  '/usr/share/fonts/truetype/tlwg/Garuda-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
    'lao': ['/System/Library/Fonts/Supplemental/Lao Sangam MN.ttf', 'C:/Windows/Fonts/LeelawUI.ttf',
            '/usr/share/fonts/truetype/noto/NotoSansLao-Regular.ttf'],
}
_font_cache = {}


def _font(kind, size):
    from PIL import ImageFont
    key = (kind, size)
    if key not in _font_cache:
        font = None
        for path in _FONT_CANDIDATES.get(kind, []):
            if os.path.exists(path):
                try:
                    font = ImageFont.truetype(path, size)
                    break
                except OSError:
                    continue
        if font is None:
            font = _font('thai', size) if kind != 'thai' and kind != 'thai_bold' else ImageFont.load_default()
        _font_cache[key] = font
    return _font_cache[key]


def _is_lao(ch):
    return '\u0e80' <= ch <= '\u0eff'


def _runs(text):
    """Split text into (script, chunk) runs so Lao uses a Lao font and the rest Thai/Latin."""
    runs = []
    for ch in text:
        script = 'lao' if _is_lao(ch) else 'thai'
        if runs and runs[-1][0] == script:
            runs[-1][1] += ch
        else:
            runs.append([script, ch])
    return runs


def _text_width(text, size, bold=False):
    total = 0
    for script, chunk in _runs(text):
        f = _font('thai_bold' if (bold and script == 'thai') else script, size)
        if script == 'lao':   # marks are drawn over their base letter and take no width
            chunk = ''.join(ch for ch in chunk if unicodedata.category(ch) != 'Mn')
        total += f.getlength(chunk)
    return total


_LAO_ABOVE_VOWELS = set('\u0eb1\u0eb4\u0eb5\u0eb6\u0eb7\u0ebb\u0ecd')


def _draw_lao(draw, x, y, chunk, f, bold, size):
    """Pillow without libraqm cannot position Lao combining marks (the font needs GPOS shaping):
    centre each mark over its base letter, and lift a tone mark that sits on an above-vowel."""
    base_x = base_w = None
    above = False
    for ch in chunk:
        if unicodedata.category(ch) == 'Mn' and base_x is not None:
            l, _, r, _ = f.getbbox(ch)
            mx = base_x + base_w / 2 - (l + r) / 2
            my = y - (size * 0.28 if (above and ch not in _LAO_ABOVE_VOWELS) else 0)
            for dx in ((0, 1) if bold else (0,)):
                draw.text((mx + dx, my), ch, font=f, fill=0)
            above = above or ch in _LAO_ABOVE_VOWELS
            continue
        for dx in ((0, 1) if bold else (0,)):
            draw.text((x + dx, y), ch, font=f, fill=0)
        base_x, base_w, above = x, f.getlength(ch), False
        x += base_w
    return x


def _draw_text(draw, x, y, text, size, bold=False):
    for script, chunk in _runs(text):
        f = _font('thai_bold' if (bold and script == 'thai') else script, size)
        if script == 'lao':
            x = _draw_lao(draw, x, y, chunk, f, bold, size)
            continue
        draw.text((x, y), chunk, font=f, fill=0)
        x += f.getlength(chunk)


def _wrap(text, width, size, bold=False):
    words, lines, cur = str(text).split(' '), [], ''
    for w in words:
        trial = (cur + ' ' + w) if cur else w
        if _text_width(trial, size, bold) <= width:
            cur = trial
            continue
        if cur:
            lines.append(cur)
        cur = ''
        for ch in w:   # a word longer than the paper (Thai has no spaces): break by character
            if _text_width(cur + ch, size, bold) > width and cur:
                lines.append(cur)
                cur = ''
            cur += ch
    lines.append(cur)
    return lines


# ----------------------------------------------------------------- render ---
SIZES = {'small': 22, 'normal': 26, 'large': 34, 'xlarge': 44}


def render(lines, paper='80'):
    """lines: list of dicts
         {'text': str, 'size': 'normal', 'align': 'left|center|right', 'bold': bool}
         {'left': str, 'right': str, 'size': ..., 'bold': ...}   two columns (item ... price)
         {'rule': True}                                          dashed separator
         {'space': px}
    Returns a 1-bit PIL image exactly the printable width of the paper."""
    from PIL import Image, ImageDraw
    width = PAPER_DOTS.get(str(paper), 576)
    margin = 8
    inner = width - margin * 2
    ops, y = [], 4
    for ln in lines:
        if ln.get('space'):
            y += int(ln['space'])
            continue
        size = SIZES.get(ln.get('size') or 'normal', 26)
        step = int(size * 1.45)
        if ln.get('rule'):
            ops.append(('rule', y + step // 2))
            y += step
            continue
        bold = bool(ln.get('bold'))
        if 'left' in ln:
            right = str(ln.get('right') or '')
            rw = _text_width(right, size, bold)
            wrapped = _wrap(ln.get('left') or '', inner - rw - 16, size, bold)
            for i, part in enumerate(wrapped):
                ops.append(('text', margin, y, part, size, bold))
                if i == 0 and right:
                    ops.append(('text', width - margin - rw, y, right, size, bold))
                y += step
            continue
        for part in _wrap(ln.get('text') or '', inner, size, bold):
            w = _text_width(part, size, bold)
            align = ln.get('align') or 'left'
            x = margin if align == 'left' else (width - margin - w if align == 'right' else (width - w) / 2)
            ops.append(('text', x, y, part, size, bold))
            y += step
    img = Image.new('1', (width, y + 24), 1)
    draw = ImageDraw.Draw(img)
    for op in ops:
        if op[0] == 'rule':
            for x in range(margin, width - margin, 12):
                draw.line((x, op[1], x + 6, op[1]), fill=0, width=2)
        else:
            _draw_text(draw, op[1], op[2], op[3], op[4], op[5])
    return img


def escpos(img, cut=True):
    """ESC/POS: initialize, raster image (GS v 0) in bands, feed, partial cut."""
    out = bytearray(b'\x1b@')
    w = img.width
    wb = (w + 7) // 8
    band = 256
    px = img.load()
    for top in range(0, img.height, band):
        h = min(band, img.height - top)
        out += b'\x1dv0\x00' + bytes([wb & 0xff, wb >> 8, h & 0xff, h >> 8])
        for yy in range(top, top + h):
            row = bytearray(wb)
            for xx in range(w):
                if px[xx, yy] == 0:          # black dot
                    row[xx >> 3] |= 0x80 >> (xx & 7)
            out += row
    out += b'\x1bd\x04'                      # feed 4 lines so the cut clears the text
    if cut:
        out += b'\x1dVB\x00'                 # partial cut
    return bytes(out)


def send(host, port, data, timeout=6):
    with socket.create_connection((host, int(port or 9100)), timeout=timeout) as s:
        s.sendall(data)


# ---------------------------------------------------------------- tickets ---
def _money(v):
    v = float(v or 0)
    return f'{v:,.0f}' if abs(v - round(v)) < 0.005 else f'{v:,.2f}'


def _local_time(ts, tz):
    if not ts:
        return ''
    try:
        return datetime.fromisoformat(str(ts).replace('Z', '+00:00')).astimezone(tz).strftime('%d/%m/%Y %H:%M')
    except ValueError:
        return str(ts)[:16]


def kitchen_lines(order, items, station_name, tz):
    where = order['table_name_snapshot'] or {'takeaway': 'กลับบ้าน / ກັບບ້ານ', 'delivery': 'เดลิเวอรี่ / Delivery'}.get(order['order_type'], '')
    lines = [{'text': f'ครัว · {station_name}' if station_name else 'ใบสั่งครัว / ໃບສັ່ງເຮືອນຄົວ', 'size': 'normal', 'align': 'center', 'bold': True},
             {'text': where, 'size': 'xlarge', 'align': 'center', 'bold': True},
             {'text': f"#{order['order_no']}  ·  {_local_time(datetime.now(timezone.utc).isoformat(), tz)}", 'size': 'small', 'align': 'center'},
             {'rule': True}]
    for it in items:
        lines.append({'text': f"{it['qty']} × {it['name']}", 'size': 'large', 'bold': True})
        if it.get('options'):
            lines.append({'text': '   + ' + ', '.join(it['options']), 'size': 'normal'})
        if it.get('notes'):
            lines.append({'text': '   * ' + it['notes'], 'size': 'normal', 'bold': True})
    if order['notes']:
        lines += [{'rule': True}, {'text': '* ' + order['notes'], 'size': 'normal', 'bold': True}]
    return lines


def receipt_lines(order, items, payments, rs, tz, cashier=''):
    subtotal = float(order['total_amount'] or 0)
    discount = float(order['discount_amount'] or 0)
    service = float(order['service_charge_amount'] or 0)
    tax = float(order['tax_amount'] or 0)
    delivery = float(order['delivery_fee'] or 0)
    total = max(0.0, subtotal - discount) + service + tax + delivery
    align = rs.get('header_align') or 'center'
    lines = [{'text': rs.get('shop_name') or 'ZaabOS', 'size': 'large', 'align': align, 'bold': True}]
    for key in ('subtitle', 'address', 'phone'):
        if rs.get(key):
            lines.append({'text': rs[key], 'size': 'small', 'align': align})
    if rs.get('show_branch', True) and rs.get('branch_name'):
        lines.append({'text': rs['branch_name'], 'size': 'small', 'align': align})
    if rs.get('tax_id'):
        lines.append({'text': 'TAX ID ' + rs['tax_id'], 'size': 'small', 'align': align})
    lines.append({'rule': True})
    lines.append({'left': f"#{order['order_no']}", 'right': order['table_name_snapshot'] or '', 'size': 'small'})
    if rs.get('show_paid_time', True) and order['paid_at']:
        lines.append({'left': 'ชำระ / Paid', 'right': _local_time(order['paid_at'], tz), 'size': 'small'})
    if rs.get('show_cashier', True) and cashier:
        lines.append({'left': 'แคชเชียร์', 'right': cashier, 'size': 'small'})
    lines.append({'rule': True})
    for it in items:
        lines.append({'left': f"{it['qty']} × {it['name']}", 'right': _money(it['qty'] * it['unit_price'])})
        if it.get('options'):
            lines.append({'text': '   + ' + ', '.join(it['options']), 'size': 'small'})
    lines.append({'rule': True})
    lines.append({'left': 'รวม / Subtotal', 'right': _money(subtotal)})
    if discount:
        lines.append({'left': 'ส่วนลด ' + (order['discount_label'] or ''), 'right': '-' + _money(discount)})
    if service:
        lines.append({'left': 'ค่าบริการ / Service', 'right': _money(service)})
    if tax:
        lines.append({'left': 'ภาษี / Tax', 'right': _money(tax)})
    if delivery:
        lines.append({'left': 'ค่าส่ง / Delivery', 'right': _money(delivery)})
    lines.append({'left': 'ยอดสุทธิ / TOTAL', 'right': _money(total), 'size': 'large', 'bold': True})
    if rs.get('show_payment_breakdown', True) and payments:
        names = {'cash': 'เงินสด / Cash', 'qr': 'QR', 'card': 'บัตร / Card', 'bank_transfer': 'โอน / Transfer', 'other': 'อื่นๆ'}
        change = 0.0
        for p in payments:
            lines.append({'left': names.get(p['payment_method'], p['payment_method']), 'right': _money(p['amount']), 'size': 'small'})
            if p['payment_method'] == 'cash' and p['cash_received']:
                change += max(0.0, float(p['cash_received']) - float(p['amount']))
        if change:
            lines.append({'left': 'เงินทอน / Change', 'right': _money(change), 'size': 'small'})
    if order['payment_status'] != 'paid':
        lines += [{'rule': True}, {'text': 'ใบแจ้งยอด — ยังไม่ชำระ', 'align': 'center', 'bold': True}]
    if rs.get('footer'):
        lines += [{'rule': True}, {'text': rs['footer'], 'align': 'center', 'size': 'small'}]
    return lines


def test_lines(printer_name, public_url=''):
    return [{'text': 'ZaabOS', 'size': 'xlarge', 'align': 'center', 'bold': True},
            {'text': 'ทดสอบเครื่องพิมพ์ / ທົດສອບເຄື່ອງພິມ', 'align': 'center'},
            {'text': 'Printer test OK', 'align': 'center'},
            {'rule': True},
            {'left': 'เครื่อง', 'right': printer_name},
            {'left': 'ภาษาไทย', 'right': 'ก่อน ผู้ใหญ่ ชั่วโมง'},
            {'left': 'ພາສາລາວ', 'right': 'ເຂົ້າປຽກ ລາບໄກ່'},
            {'left': 'เงิน', 'right': _money(1234567)},
            {'text': public_url, 'size': 'small', 'align': 'center'}]


# ----------------------------------------------------------------- worker ---
def _items_for(conn, order_id, item_ids=None):
    rows = conn.execute('SELECT * FROM order_items WHERE order_id=? ORDER BY id', (order_id,)).fetchall()
    out = []
    for r in rows:
        qty = int(r['quantity']) - int(r['cancelled_quantity'] or 0)
        if qty <= 0 or (item_ids is not None and r['id'] not in item_ids):
            continue
        opts = [o['option_name_snapshot'] for o in conn.execute('SELECT option_name_snapshot FROM order_item_options WHERE order_item_id=? ORDER BY id', (r['id'],)).fetchall()]
        out.append({'id': r['id'], 'qty': qty, 'name': r['item_name_snapshot'], 'unit_price': float(r['unit_price'] or 0),
                    'options': opts, 'notes': r['notes'] or ''})
    return out


def resolve_printer(conn, job):
    if job['printer_id']:
        return conn.execute('SELECT * FROM printers WHERE id=? AND active=1', (job['printer_id'],)).fetchone()
    role = 'receipt' if job['job_type'] == 'receipt' else 'kitchen'
    rows = conn.execute('SELECT * FROM printers WHERE tenant_id=? AND branch_id=? AND role=? AND active=1 ORDER BY id',
                        (job['tenant_id'], job['branch_id'], role)).fetchall()
    if role == 'kitchen':
        for r in rows:
            if job['station_id'] and r['station_id'] == job['station_id']:
                return r
        for r in rows:
            if not r['station_id']:
                return r
        return None
    return rows[0] if rows else None


def build_job(core, conn, job, printer):
    tz = core.RESTAURANT_TZ
    paper = str(printer['paper_width'] or '80')
    if job['job_type'] == 'test':
        return render(test_lines(printer['name'], os.getenv('ZAABOS_PUBLIC_URL') or ''), paper)
    order = conn.execute('SELECT * FROM orders WHERE id=?', (job['order_id'],)).fetchone()
    if not order:
        raise ValueError('ไม่พบออเดอร์')
    if job['job_type'] == 'receipt':
        rs = core.receipt_settings_for(conn, order['tenant_id'], order['branch_id'])
        pays = conn.execute('SELECT * FROM payments WHERE order_id=? AND reversed_at IS NULL ORDER BY id', (order['id'],)).fetchall()
        cashier = ''
        if pays:
            u = conn.execute('SELECT display_name FROM users WHERE id=?', (pays[0]['paid_by_user_id'],)).fetchone()
            cashier = u['display_name'] if u else ''
        return render(receipt_lines(order, _items_for(conn, order['id']), pays, rs, tz, cashier), paper)
    item_ids = set(json.loads(job['item_ids'])) if job['item_ids'] else None
    items = _items_for(conn, order['id'], item_ids)
    if job['station_id'] and item_ids is None:
        items = [it for it in items if conn.execute('SELECT kitchen_station_id FROM menu_items mi JOIN order_items oi ON oi.menu_item_id=mi.id WHERE oi.id=?', (it['id'],)).fetchone()['kitchen_station_id'] == job['station_id']]
    if not items:
        return None
    station = conn.execute('SELECT name FROM kitchen_stations WHERE id=?', (job['station_id'],)).fetchone() if job['station_id'] else None
    return render(kitchen_lines(order, items, station['name'] if station else '', tz), paper)


def process_once(core, sender=send):
    """Print every due job that has a printer. Returns the number of jobs handled."""
    handled = 0
    with core.app.app_context():
        conn = core.db()
        ts = core.now()
        jobs = conn.execute("""SELECT * FROM kitchen_print_jobs WHERE status='pending'
                               AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY id LIMIT 20""", (ts,)).fetchall()
        for job in jobs:
            printer = resolve_printer(conn, job)
            if not printer:
                continue   # no network printer for this route: the browser prints it as before
            try:
                img = build_job(core, conn, job, printer)
                if img is not None:
                    sender(printer['host'], printer['port'], escpos(img))
                conn.execute("UPDATE kitchen_print_jobs SET status='printed',attempts=attempts+1,last_error='',printed_at=?,printer_id=? WHERE id=?",
                             (core.now(), printer['id'], job['id']))
            except Exception as exc:
                attempts = int(job['attempts'] or 0) + 1
                status = 'failed' if attempts >= MAX_ATTEMPTS else 'pending'
                nxt = (datetime.now(timezone.utc) + timedelta(seconds=RETRY_SECONDS * attempts)).isoformat(timespec='seconds')
                conn.execute('UPDATE kitchen_print_jobs SET status=?,attempts=?,last_error=?,next_attempt_at=?,printer_id=? WHERE id=?',
                             (status, attempts, f'{printer["name"]}: {exc}'[:300], nxt, printer['id'], job['id']))
            conn.commit()
            handled += 1
    return handled


def start_worker(core, interval=1.0):
    stop = threading.Event()

    def loop():
        while not stop.is_set():
            try:
                process_once(core)
            except Exception as exc:   # the POS must keep selling even if printing breaks
                print(f'[ZaabOS] print worker error: {exc}', file=sys.stderr, flush=True)
            stop.wait(interval)

    threading.Thread(target=loop, name='zaabos-print', daemon=True).start()
    return stop
