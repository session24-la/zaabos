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


def _seg_width(segs, size):
    return sum(_text_width(t, size, b) for t, b in segs)


def _draw_segs(draw, x, y, segs, size):
    for t, b in segs:
        _draw_text(draw, x, y, t, size, b)
        x += _text_width(t, size, b)


def _segs(v, bold):
    """A cell is plain text or a list of (text, bold) pieces, e.g. [('โต๊ะ  ', False), ('โต๊ะ 2', True)]."""
    return [(str(t), bool(b)) for t, b in v] if isinstance(v, (list, tuple)) else [(str(v or ''), bold)]


def render(lines, paper='80', scale=1.0):
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
        size = int(SIZES.get(ln.get('size') or 'normal', 26) * scale)
        step = int(size * 1.45)
        if ln.get('rule') or ln.get('hline'):
            ops.append(('hline' if ln.get('hline') else 'rule', y + step // 2))
            y += step
            continue
        bold = bool(ln.get('bold'))
        if 'qty' in ln:
            # Item row like the web receipt: qty column | name (wraps) | price right-aligned.
            qty_w = int(size * 2.4)
            price = str(ln.get('right') or '')
            pw = _text_width(price, size, bold)
            name_x = margin + qty_w
            parts = _wrap(ln.get('left') or '', width - margin - pw - 14 - name_x, size, bold)
            ops.append(('text', margin, y, str(ln['qty']), size, True))
            for i, part in enumerate(parts):
                ops.append(('text', name_x, y, part, size, bold))
                if i == 0 and price:
                    ops.append(('text', width - margin - pw, y, price, size, bold))
                y += step
            sub_size = int(size * 0.82)
            for sub in ln.get('subs') or []:
                for part in _wrap(sub, width - margin - name_x, sub_size):
                    ops.append(('text', name_x, y, part, sub_size, False))
                    y += int(sub_size * 1.4)
            continue
        if isinstance(ln.get('left'), (list, tuple)) or isinstance(ln.get('right'), (list, tuple)):
            ls, rs_ = _segs(ln.get('left'), bold), _segs(ln.get('right'), bold)
            ops.append(('segs', margin, y, ls, size))
            if rs_:
                ops.append(('segs', width - margin - _seg_width(rs_, size), y, rs_, size))
            y += step
            continue
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
        text = ln.get('text') or ''
        if ln.get('spaced'):   # letter-spaced subtitle, like the web receipt's "R E S T A U R A N T"
            text = ' '.join(text)
        for part in _wrap(text, inner, size, bold):
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
        elif op[0] == 'hline':
            draw.line((margin, op[1], width - margin, op[1]), fill=0, width=3)
        elif op[0] == 'segs':
            _draw_segs(draw, op[1], op[2], op[3], op[4])
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


# --- USB printers plugged into this Mac/PC, through the OS print queue (CUPS on macOS) ---
SYSTEM_WAIT_SECONDS = 15


def _win32print():
    try:
        import win32print   # pywin32, bundled in the Windows build only
        return win32print
    except ImportError:
        return None


def system_queues():
    """Print queues this computer knows: Windows printers, or CUPS queues on macOS/Linux."""
    if sys.platform.startswith('win'):
        wp = _win32print()
        if not wp:
            return []
        flags = wp.PRINTER_ENUM_LOCAL | wp.PRINTER_ENUM_CONNECTIONS
        return [p[2] for p in wp.EnumPrinters(flags, None, 1)]
    import subprocess
    try:
        out = subprocess.run(['lpstat', '-e'], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [q.strip() for q in out.splitlines() if q.strip()]


def _send_windows(queue, data, wait):
    """Raw ESC/POS through the Windows spooler (USB receipt printers). Same rule as CUPS: if the
    printer has not taken the job in time, delete it so it can never print by surprise later."""
    wp = _win32print()
    if not wp:
        raise OSError('ไม่มีระบบพิมพ์ของ Windows (pywin32)')
    h = wp.OpenPrinter(queue)
    try:
        job = wp.StartDocPrinter(h, 1, ('ZaabOS', None, 'RAW'))
        try:
            wp.StartPagePrinter(h)
            wp.WritePrinter(h, data)
            wp.EndPagePrinter(h)
        finally:
            wp.EndDocPrinter(h)
        end = time.time() + wait
        while time.time() < end:
            if not any(j['JobId'] == job for j in wp.EnumJobs(h, 0, 50, 1)):
                return
            time.sleep(0.15)
        try:
            wp.SetJob(h, job, 0, None, wp.JOB_CONTROL_DELETE)
        except Exception:
            pass
        raise OSError('เครื่องพิมพ์ USB ไม่ตอบ (ตรวจสาย/เปิดเครื่อง/กระดาษ)')
    finally:
        wp.ClosePrinter(h)


def send_system(queue, data, wait=None):
    """Raw ESC/POS through the OS queue, then wait until the printer really took it. If it did
    not (unplugged, off, paper out), cancel the job so it can never print by surprise later —
    the reprint button is the only way it prints again."""
    import re
    import subprocess
    wait = SYSTEM_WAIT_SECONDS if wait is None else wait
    if sys.platform.startswith('win'):
        return _send_windows(queue, data, wait)
    r = subprocess.run(['lp', '-d', queue, '-o', 'raw', '-t', 'ZaabOS'], input=data, capture_output=True, timeout=15)
    if r.returncode != 0:
        raise OSError((r.stderr or r.stdout).decode(errors='replace').strip() or 'lp failed')
    m = re.search(rb'request id is (\S+)', r.stdout)
    job = m.group(1).decode() if m else None
    if not job:
        return
    end = time.time() + wait
    while time.time() < end:
        pending = subprocess.run(['lpstat', '-o', queue], capture_output=True, text=True, timeout=5).stdout
        if job not in pending:
            return
        time.sleep(0.15)
    subprocess.run(['cancel', job], capture_output=True, timeout=5)
    raise OSError('เครื่องพิมพ์ USB ไม่ตอบ (ตรวจสาย/เปิดเครื่อง/กระดาษ)')


def system_printers():
    """[{queue, label}] for this computer's print queues, with the human name macOS shows."""
    import subprocess
    queues = system_queues()
    if sys.platform.startswith('win'):
        return [{'queue': q, 'label': q} for q in queues]
    labels = {}
    try:
        out = subprocess.run(['lpstat', '-l', '-p'], capture_output=True, text=True, timeout=5).stdout
        cur = None
        for line in out.splitlines():
            if line.startswith('printer '):
                cur = line.split()[1]
            elif cur and line.strip().startswith('Description:'):
                labels[cur] = line.split(':', 1)[1].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return [{'queue': q, 'label': labels.get(q) or q.replace('_', ' ').strip()} for q in queues]


def scan_network(own_ip, port=9100, timeout=0.35):
    """Find receipt printers on the shop Wi-Fi: devices in this /24 that accept raw printing on
    port 9100. Takes ~2 s; skips this computer itself."""
    from concurrent.futures import ThreadPoolExecutor
    parts = str(own_ip).split('.')
    if len(parts) != 4 or own_ip.startswith('127.'):
        return []
    base = '.'.join(parts[:3])

    def probe(i):
        host = f'{base}.{i}'
        if host == own_ip:
            return None
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return host
        except OSError:
            return None
    with ThreadPoolExecutor(64) as ex:
        return [h for h in ex.map(probe, range(1, 255)) if h]


# Names that mark a queue as a receipt/kitchen printer (not an office, photo or label printer).
import re as _re
RECEIPT_HINT = _re.compile(r'receipt|thermal|\bpos\b|pos-?\d|80 ?mm|58 ?mm|80series|58series|rongta|xprinter|\bxp-|epson.*tm|tm-[tmu]|'
                           r'sunmi|star.*tsp|bixolon|gprinter|hprt|sewoo|citizen.*ct|zjiang|goojprt|munbyn|rp3\d\d', _re.I)


def printer_inventory():
    """{queue: {'label', 'uri', 'connected' (True/False/None=unknown), 'receipt_like'}} for this PC."""
    import subprocess
    inv = {p['queue']: {'label': p['label'], 'uri': '', 'connected': None} for p in system_printers()}
    if not sys.platform.startswith('win'):
        try:
            for line in subprocess.run(['lpstat', '-v'], capture_output=True, text=True, timeout=5).stdout.splitlines():
                m = _re.match(r'device for (\S+?):\s*(\S+)', line)
                if m and m.group(1) in inv:
                    inv[m.group(1)]['uri'] = m.group(2)
            plugged = {ln.split(None, 1)[1].strip() for ln in subprocess.run(['lpinfo', '--include-schemes', 'usb', '-v'], capture_output=True, text=True, timeout=20).stdout.splitlines()
                       if ln.startswith('direct ') and len(ln.split(None, 1)) == 2}
            for q in inv.values():
                if q['uri'].startswith('usb:'):
                    q['connected'] = q['uri'] in plugged
        except (OSError, subprocess.SubprocessError):
            pass
    for q, info in inv.items():
        info['receipt_like'] = bool(RECEIPT_HINT.search(q) or RECEIPT_HINT.search(info['label']) or RECEIPT_HINT.search(info['uri']))
    return inv


def find_replacement(current, taken=()):
    """The shop swapped the receipt printer: if the saved USB printer is not plugged in and exactly
    one other receipt printer is, use that one. Never guesses between several, never picks an
    office/photo/label printer, never takes one another ZaabOS route already uses."""
    inv = printer_inventory()
    if inv.get(current, {}).get('connected') is True:
        return None                                   # the saved printer is there; the problem is elsewhere
    pool = [q for q, i in inv.items() if q != current and q not in taken and i['receipt_like'] and i['connected'] is not False]
    plugged = [q for q in pool if inv[q]['connected'] is True]
    pick = plugged if plugged else pool
    return (pick[0], inv[pick[0]]['label']) if len(pick) == 1 else None


def deliver_or_switch(conn, printer, data, sender=None):
    """Deliver; if a USB printer fails because it was replaced, move this route to the new printer
    (updates the saved printer) and print there. Returns the printer row actually used."""
    try:
        deliver(printer, data, sender)
        return printer
    except Exception:
        if printer['connection'] != 'system':
            raise
        taken = {r['host'] for r in conn.execute("SELECT host FROM printers WHERE tenant_id=? AND active=1 AND connection='system' AND id<>?",
                                                   (printer['tenant_id'], printer['id'])).fetchall()}
        repl = find_replacement(printer['host'], taken)
        if not repl:
            raise
        queue, label = repl
        conn.execute('UPDATE printers SET host=?, name=? WHERE id=?', (queue, label, printer['id']))
        conn.commit()
        print(f'[ZaabOS] printer "{printer["host"]}" not connected — switched to "{queue}"', flush=True)
        switched = conn.execute('SELECT * FROM printers WHERE id=?', (printer['id'],)).fetchone()
        deliver(switched, data, sender)
        return switched


def deliver(printer, data, sender=None):
    """Send one ticket to a printer row: Wi-Fi (host:port) or USB/system queue."""
    if (printer['connection'] if 'connection' in printer.keys() else 'network') == 'system':
        return send_system(printer['host'], data)
    return (sender or send)(printer['host'], printer['port'], data)


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
        if it.get('name2'):
            lines.append({'text': '      ' + it['name2'], 'size': 'normal'})
        if it.get('options'):
            lines.append({'text': '   + ' + ', '.join(it['options']), 'size': 'normal'})
        if it.get('notes'):
            lines.append({'text': '   * ' + it['notes'], 'size': 'normal', 'bold': True})
        if it.get('takeaway'):
            lines.append({'text': '   >> ห่อกลับ / ຫໍ່ກັບ', 'size': 'large', 'bold': True})
    if order['notes']:
        lines += [{'rule': True}, {'text': '* ' + order['notes'], 'size': 'normal', 'bold': True}]
    return lines


def notice_lines(order, slip, tz):
    """'rush' (guest is waiting) or 'takeaway' (pack this dish) for food the kitchen already has."""
    where = order['table_name_snapshot'] or {'takeaway': 'กลับบ้าน / ກັບບ້ານ', 'delivery': 'เดลิเวอรี่ / Delivery'}.get(order['order_type'], '')
    title = slip.get('title') or ('เร่ง / ເລັ່ງ' if slip.get('kind') == 'rush' else 'แจ้งครัว')
    lines = [{'text': f'*** {title} ***', 'size': 'xlarge', 'align': 'center', 'bold': True},
             {'text': where, 'size': 'xlarge', 'align': 'center', 'bold': True},
             {'text': f"#{order['order_no']}  ·  {_local_time(datetime.now(timezone.utc).isoformat(), tz)}", 'size': 'small', 'align': 'center'},
             {'rule': True}]
    for it in slip.get('items') or []:
        lines.append({'text': f"{it.get('qty', 1)} × {it.get('name', '')}", 'size': 'large', 'bold': True})
        if it.get('name2'):
            lines.append({'text': '      ' + it['name2'], 'size': 'normal'})
    return lines


def void_lines(order, slip, tz):
    """Cancelled food the kitchen was already making — must stand out from a normal ticket."""
    where = order['table_name_snapshot'] or {'takeaway': 'กลับบ้าน / ກັບບ້ານ', 'delivery': 'เดลิเวอรี่ / Delivery'}.get(order['order_type'], '')
    lines = [{'text': '*** ยกเลิก / ຍົກເລີກ ***', 'size': 'xlarge', 'align': 'center', 'bold': True},
             {'text': where, 'size': 'xlarge', 'align': 'center', 'bold': True},
             {'text': f"#{order['order_no']}  ·  {_local_time(datetime.now(timezone.utc).isoformat(), tz)}", 'size': 'small', 'align': 'center'},
             {'rule': True}]
    for it in slip.get('items') or []:
        lines.append({'text': f"− {it.get('qty', 1)} × {it.get('name', '')}", 'size': 'large', 'bold': True})
        if it.get('name2'):
            lines.append({'text': '      ' + it['name2'], 'size': 'normal'})
    if slip.get('reason'):
        lines += [{'rule': True}, {'text': 'เหตุผล: ' + slip['reason'], 'size': 'normal', 'bold': True}]
    return lines


def move_lines(order, slip, tz):
    """The table moved: food still coming out of the kitchen goes to the new table."""
    return [{'text': '*** ย้ายโต๊ะ / ຍ້າຍໂຕະ ***', 'size': 'xlarge', 'align': 'center', 'bold': True},
            {'text': f"{slip.get('from') or '-'}  →  {slip.get('to') or '-'}", 'size': 'xlarge', 'align': 'center', 'bold': True},
            {'text': f"#{order['order_no']}  ·  {_local_time(datetime.now(timezone.utc).isoformat(), tz)}", 'size': 'small', 'align': 'center'},
            {'rule': True},
            {'text': 'อาหารที่ยังไม่เสิร์ฟ ส่งโต๊ะใหม่', 'size': 'normal', 'align': 'center', 'bold': True}]


CURRENCY_SYMBOLS = {'LAK': '₭', 'THB': '฿', 'USD': '$', 'CNY': '¥'}
PAYMENT_NAMES = {'cash': 'Cash / ເງິນສົດ', 'qr': 'QR', 'card': 'Card', 'bank_transfer': 'Bank transfer', 'other': 'Other'}
# Same words the browser receipt uses (static/i18n.js); the cashier's screen language is sent with the job.
RECEIPT_LABELS = {
    'th': dict(table='โต๊ะ', guests='ลูกค้า', subtotal='ยอดก่อนภาษี', total='รวม', tax='ภาษี (ถ้ามี)', cash='รับเงินมา', change='เงินทอน', thanks='ขอบคุณที่ใช้บริการ', discount='ส่วนลด', delivery='ค่าส่ง', free='แถม'),
    'lo': dict(table='ໂຕະ', guests='ລູກຄ້າ', subtotal='ຍອດກ່ອນອາກອນ', total='ລວມ', tax='ອາກອນ (ຖ້າມີ)', cash='ຮັບເງິນມາ', change='ເງິນທອນ', thanks='ຂອບໃຈທີ່ໃຊ້ບໍລິການ', discount='ສ່ວນຫຼຸດ', delivery='ຄ່າສົ່ງ', free='ແຖມ'),
    'en': dict(table='Table', guests='Guests', subtotal='Subtotal', total='Total', tax='Tax', cash='Cash received', change='Change', thanks='Thank you for your order', discount='Discount', delivery='Delivery', free='Free'),
    'zh': dict(table='桌号', guests='人数', subtotal='小计', total='合计', tax='税额', cash='实收金额', change='找零', thanks='感谢您的光临', discount='折扣', delivery='配送费', free='赠送'),
}


def _fmt_money(v, currency='LAK'):
    return CURRENCY_SYMBOLS.get(currency or 'LAK', '') + f'{round(float(v or 0)):,}'


def _fmt_time(ts, tz, lang):
    if not ts:
        return ''
    try:
        d = datetime.fromisoformat(str(ts).replace('Z', '+00:00')).astimezone(tz)
    except ValueError:
        return str(ts)[:16]
    year = d.year + 543 if lang == 'th' else d.year     # th-TH shows the Buddhist year, as on screen
    return f'{d:%d/%m}/{year} {d:%H:%M}'


def receipt_lines(order, items, payments, rs, tz, cashier='', lang='th', currency='LAK', order_type_label=''):
    """Mirror of the browser receipt (static/app.js printReceipt) so both look the same."""
    L = dict(RECEIPT_LABELS['th'], **RECEIPT_LABELS.get(lang, {}))
    m = lambda v: _fmt_money(v, currency)
    subtotal = float(order['total_amount'] or 0)
    discount = float(order['discount_amount'] or 0)
    service = float(order['service_charge_amount'] or 0)
    tax = float(order['tax_amount'] or 0)
    delivery = float(order['delivery_fee'] or 0)
    total = max(0.0, subtotal - discount) + service + tax + delivery
    align = 'left' if rs.get('header_align') == 'left' else 'center'
    lines = [{'text': rs.get('shop_name') or 'ZaabOS', 'size': 'xlarge', 'align': align, 'bold': True}]
    if rs.get('subtitle', 'RESTAURANT · POS') != '':
        lines.append({'text': rs.get('subtitle') or 'RESTAURANT · POS', 'size': 'small', 'align': align, 'spaced': True})
    if rs.get('show_branch', True) and rs.get('branch_name'):
        lines.append({'text': rs['branch_name'], 'align': align, 'bold': True})
    for key, prefix in (('address', ''), ('phone', ''), ('tax_id', 'Tax ID: ')):
        if rs.get(key):
            lines.append({'text': prefix + rs[key], 'size': 'small', 'align': align})
    lines.append({'rule': True})
    guest = order['guest_count'] if order['guest_count'] is not None else '-'
    lines.append({'left': [(L['table'] + '  ', False), (order['table_name_snapshot'] or order_type_label, True)],
                  'right': [(L['guests'] + '  ', False), (str(guest), True)] if rs.get('show_guest', True) else []})
    lines.append({'left': [('Order  ', False), ('#' + order['order_no'], True)], 'right': []})
    lines.append({'rule': True})
    for it in items:
        subs = ([it['name2']] if it.get('name2') else []) + ([' / '.join(it['options'])] if it.get('options') else []) + ([it['notes']] if it.get('notes') else [])
        free = not it['unit_price'] and it.get('price_reason')
        lines.append({'qty': it['qty'], 'left': it['name'], 'right': L.get('free', 'Free') if free else m(it['qty'] * it['unit_price']), 'subs': subs})
    lines.append({'rule': True})
    lines.append({'left': L['subtotal'], 'right': m(subtotal)})
    if discount > 0:
        lines.append({'left': L['discount'] + (' · ' + order['discount_label'] if order['discount_label'] else ''), 'right': '−' + m(discount)})
    if service > 0:
        lines.append({'left': 'Service charge', 'right': m(service)})
    if tax > 0:
        lines.append({'left': L['tax'], 'right': m(tax)})
    if delivery > 0:
        lines.append({'left': L['delivery'], 'right': m(delivery)})
    lines.append({'hline': True, 'size': 'small'})
    lines.append({'left': L['total'], 'right': m(total), 'size': 'xlarge', 'bold': True})
    if order['payment_status'] == 'paid':
        lines.append({'text': '[ PAID · ຊຳລະແລ້ວ ]', 'align': 'center', 'bold': True})
    cash_rows = [p for p in payments if p['payment_method'] == 'cash']
    if rs.get('show_payment_breakdown', True):
        for p in payments:
            lines.append({'left': PAYMENT_NAMES.get(p['payment_method'], p['payment_method']), 'right': m(p['amount'])})
    elif order['payment_method']:
        lines.append({'left': 'Payment', 'right': PAYMENT_NAMES.get(order['payment_method'], order['payment_method'])})
    if cash_rows:
        received = sum(float(p['cash_received'] if p['cash_received'] is not None else p['amount']) for p in cash_rows)
        change = max(0.0, received - sum(float(p['amount']) for p in cash_rows))
        lines.append({'left': L['cash'], 'right': m(received)})
        lines.append({'left': L['change'], 'right': m(change)})
    lines.append({'rule': True})
    if rs.get('show_order_time', True):
        lines.append({'left': 'Order time', 'right': _fmt_time(order['created_at'], tz, lang), 'size': 'small'})
    if order['paid_at'] and rs.get('show_paid_time', True):
        lines.append({'left': 'Paid time', 'right': _fmt_time(order['paid_at'], tz, lang), 'size': 'small'})
    if cashier and rs.get('show_cashier', True):
        lines.append({'left': 'Cashier', 'right': cashier, 'size': 'small'})
    lines.append({'space': 10})
    lines.append({'text': rs.get('footer') or L['thanks'], 'align': 'center', 'bold': True})
    lines.append({'text': 'ZaabOS', 'size': 'small', 'align': 'center', 'spaced': True})
    return lines


FONT_SCALE = {'small': 0.85, 'normal': 1.0, 'large': 1.15}


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
                    'name2': (r['item_name2_snapshot'] if 'item_name2_snapshot' in r.keys() else '') or '',
                    'options': opts, 'notes': r['notes'] or '',
                    'takeaway': bool(r['takeaway']) if 'takeaway' in r.keys() else False,
                    'price_reason': (r['price_reason'] if 'price_reason' in r.keys() else '') or ''})
    return out


def resolve_printer(conn, job):
    if job['printer_id']:
        return conn.execute('SELECT * FROM printers WHERE id=? AND active=1', (job['printer_id'],)).fetchone()
    role = 'receipt' if job['job_type'] == 'receipt' else 'kitchen'
    rows = conn.execute("SELECT * FROM printers WHERE tenant_id=? AND branch_id=? AND role IN (?,'both') AND active=1 ORDER BY id",
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
        # Same fields as the browser receipt: cashier = who opened the order, shop currency, screen language.
        u = conn.execute('SELECT display_name FROM users WHERE id=?', (order['created_by_user_id'],)).fetchone() if order['created_by_user_id'] else None
        tenant = conn.execute('SELECT currency FROM tenants WHERE id=?', (order['tenant_id'],)).fetchone()
        opts = json.loads(job['payload'] or '{}') if 'payload' in job.keys() else {}
        lang = opts.get('lang') if opts.get('lang') in RECEIPT_LABELS else 'th'
        paper = str(rs.get('paper_width') or paper)
        lines = receipt_lines(order, _items_for(conn, order['id']), pays, rs, tz, u['display_name'] if u else '', lang,
                              (tenant['currency'] if tenant else None) or 'LAK', opts.get('order_type_label') or '')
        return render(lines, paper, FONT_SCALE.get(rs.get('font_scale') or 'normal', 1.0))
    if job['job_type'] in ('void', 'move', 'rush', 'takeaway'):
        slip = json.loads(job['payload'] or '{}') if 'payload' in job.keys() else {}
        slip.setdefault('kind', job['job_type'])
        build = {'void': void_lines, 'move': move_lines}.get(job['job_type'], notice_lines)
        return render(build(order, slip, tz), paper)
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
                    printer = deliver_or_switch(conn, printer, escpos(img), sender)
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


_wake = threading.Event()


def notify():
    """A job was just queued: print now instead of waiting for the next poll."""
    _wake.set()


def start_worker(core, interval=2.0):
    stop = threading.Event()

    def loop():
        while not stop.is_set():
            try:
                process_once(core)
            except Exception as exc:   # the POS must keep selling even if printing breaks
                print(f'[ZaabOS] print worker error: {exc}', file=sys.stderr, flush=True)
            _wake.wait(interval)
            _wake.clear()

    threading.Thread(target=loop, name='zaabos-print', daemon=True).start()
    return stop
