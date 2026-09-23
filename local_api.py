"""Shop-PC-only web API (registered by zaabos_local.py, never on the cloud server).

The same actions as the macOS menu-bar icon, for the settings page and for Windows:
version/update, start at login, QR address, backups + restore, import menu from zaabos.com.
"""
import http.cookiejar
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from flask import g, jsonify, request

import local_ops


class CloudError(Exception):
    pass


def cloud_fetcher(base_url, username, password, timeout=20):
    """Log in to the cloud ZaabOS as the owner and return fetch(path) -> JSON."""
    base = base_url.rstrip('/')
    if not base.startswith('https://') and not base.startswith('http://127.0.0.1'):
        raise CloudError('ต้องเป็นที่อยู่ https:// เช่น https://zaabos.com')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    state = {'csrf': ''}

    def call(method, path, data=None):
        req = urllib.request.Request(base + path, method=method, data=None if data is None else json.dumps(data).encode(),
                                     headers={'Content-Type': 'application/json', 'X-CSRF-Token': state['csrf'], 'User-Agent': 'ZaabOS-Local'})
        try:
            with opener.open(req, timeout=timeout) as r:
                return json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read() or b'{}').get('error')
            except ValueError:
                msg = None
            raise CloudError(msg or f'zaabos.com ตอบ {e.code}')
        except (urllib.error.URLError, OSError) as e:
            raise CloudError(f'เชื่อมต่อ {base} ไม่ได้ — ต้องต่ออินเทอร์เน็ต ({e})')

    me = call('POST', '/api/login', {'username': username, 'password': password})
    state['csrf'] = me.get('csrf_token') or ''
    return lambda path: call('GET', path)


def import_from_cloud(core, conn, tenant_id, branch_id, fetch, cloud_branch_id=None, user_id=None):
    """Copy menu (categories, items, options), tables, kitchen stations, tax/service and receipt
    settings from the cloud into this shop PC. Local menu/tables of the branch are archived, not
    deleted, so past orders keep their references."""
    boot = fetch('/api/bootstrap')
    branches = boot.get('branches') or []
    if not branches:
        raise CloudError('บัญชีนี้ไม่มีสาขาบน zaabos.com')
    src = next((b for b in branches if str(b['id']) == str(cloud_branch_id)), branches[0]) if cloud_branch_id else branches[0]
    sb = src['id']
    now = core.now()
    try:
        stations = fetch(f'/api/kitchen/stations?branch_id={sb}') or []
    except CloudError:
        stations = []
    try:
        receipt = fetch(f'/api/settings/receipt?branch_id={sb}')
    except CloudError:
        receipt = None
    try:
        pricing = fetch(f'/api/pricing/settings?branch_id={sb}')
    except CloudError:
        pricing = None

    for table in ('menu_categories', 'menu_items', 'dining_tables'):
        conn.execute(f'UPDATE {table} SET active=0 WHERE tenant_id=? AND branch_id=?', (tenant_id, branch_id))
    station_map = {}
    for st in stations:
        row = conn.execute('SELECT id FROM kitchen_stations WHERE tenant_id=? AND branch_id=? AND name=?', (tenant_id, branch_id, st['name'])).fetchone()
        station_map[st['id']] = row['id'] if row else conn.execute(
            'INSERT INTO kitchen_stations(tenant_id,branch_id,name,active,sort_order,created_at) VALUES(?,?,?,1,?,?)',
            (tenant_id, branch_id, st['name'], st.get('sort_order') or 0, now)).lastrowid
    cat_map = {}
    for c in [c for c in boot.get('categories') or [] if c.get('branch_id') == sb]:
        cat_map[c['id']] = conn.execute('INSERT INTO menu_categories(tenant_id,branch_id,name,icon,sort_order,active,created_at) VALUES(?,?,?,?,?,1,?)',
                                        (tenant_id, branch_id, c['name'], c.get('icon') or '🍜', c.get('sort_order') or 0, now)).lastrowid
    items = 0
    for it in [i for i in boot.get('items') or [] if i.get('branch_id') == sb]:
        iid = conn.execute('''INSERT INTO menu_items(tenant_id,branch_id,category_id,name,description,base_price,image_url,sold_out,sort_order,active,
                              cost_price,track_stock,stock_qty,low_stock_threshold,kitchen_station_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)''',
                           (tenant_id, branch_id, cat_map.get(it.get('category_id')), it['name'], it.get('description') or '',
                            it.get('base_price') or 0, it.get('image_url'), it.get('sold_out') or 0, it.get('sort_order') or 0,
                            it.get('cost_price') or 0, it.get('track_stock') or 0, it.get('stock_qty'), it.get('low_stock_threshold') or 5,
                            station_map.get(it.get('kitchen_station_id')), now)).lastrowid
        for grp in it.get('option_groups') or []:
            gid = conn.execute('INSERT INTO menu_option_groups(menu_item_id,name,required,selection_type,min_select,max_select,sort_order) VALUES(?,?,?,?,?,?,?)',
                               (iid, grp['name'], grp.get('required') or 0, grp.get('selection_type') or 'single',
                                grp.get('min_select') or 0, grp.get('max_select') or 1, grp.get('sort_order') or 0)).lastrowid
            for op in grp.get('options') or []:
                conn.execute('INSERT INTO menu_options(group_id,name,price_delta,active,sort_order) VALUES(?,?,?,1,?)',
                             (gid, op['name'], op.get('price_delta') or 0, op.get('sort_order') or 0))
        items += 1
    tables = 0
    for t in [t for t in boot.get('tables') or [] if t.get('branch_id') == sb]:
        # New QR tokens: the cloud tokens point at zaabos.com, these QR codes point at this PC.
        conn.execute('INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,active,created_at) VALUES(?,?,?,?,1,?)',
                     (tenant_id, branch_id, t['name'], core.gen_qr_token(), now))
        tables += 1
    if pricing and 'tax_rate' in pricing:
        conn.execute('DELETE FROM pricing_settings WHERE tenant_id=? AND branch_id=?', (tenant_id, branch_id))
        conn.execute('INSERT INTO pricing_settings(tenant_id,branch_id,tax_rate,service_charge_rate,updated_by_user_id,updated_at) VALUES(?,?,?,?,?,?)',
                     (tenant_id, branch_id, pricing.get('tax_rate') or 0, pricing.get('service_charge_rate') or 0, user_id, now))
    if receipt and not receipt.get('error'):
        conn.execute('DELETE FROM receipt_settings WHERE tenant_id=? AND branch_id=?', (tenant_id, branch_id))
        conn.execute('INSERT INTO receipt_settings(tenant_id,branch_id,settings_json,updated_by_user_id,updated_at) VALUES(?,?,?,?,?)',
                     (tenant_id, branch_id, json.dumps(receipt, ensure_ascii=False), user_id, now))
    return {'branch': src.get('name'), 'categories': len(cat_map), 'items': items, 'tables': tables, 'stations': len(station_map)}


def register(core, data_dir, port):
    app = core.app
    if getattr(app, '_zaabos_local_api', False):
        return
    app._zaabos_local_api = True
    data_dir = Path(data_dir)
    owner = lambda f: core.login_required(core.role_required('owner', 'manager')(f))
    state = {'update': None}

    def backups():
        rows = []
        for folder, where in ((core.BACKUP_DIR, 'เครื่องนี้'), (local_ops.mirror_dir(data_dir), 'iCloud/OneDrive')):
            if folder and Path(folder).is_dir():
                for p in sorted(Path(folder).glob('zaabos_*.db'), key=lambda x: x.stat().st_mtime, reverse=True)[:15]:
                    rows.append({'file': p.name, 'where': where, 'path': str(p), 'bytes': p.stat().st_size, 'mtime': int(p.stat().st_mtime)})
        return rows

    @app.get('/api/local/status')
    @owner
    def local_status():
        mirror = local_ops.mirror_dir(data_dir)
        return jsonify(version=local_ops.APP_VERSION, update=state['update'], autostart=local_ops.autostart_enabled(),
                       public_url=os.getenv('ZAABOS_PUBLIC_URL'), address_mode=local_ops.load_config(data_dir).get('address_mode') or 'ip',
                       hostname=local_ops.local_hostname(), address_warning=os.getenv('ZAABOS_ADDRESS_WARNING') or '',
                       mirror_dir=str(mirror) if mirror else '', data_dir=str(data_dir),
                       backups=[{k: v for k, v in b.items() if k != 'path'} for b in backups()])

    @app.post('/api/local/check-update')
    @owner
    def local_check_update():
        try:
            state['update'] = local_ops.check_update()
        except Exception as exc:
            return jsonify(error=f'ตรวจอัปเดตไม่ได้ — ต้องต่ออินเทอร์เน็ต ({exc})'), 502
        return jsonify(update=state['update'], version=local_ops.APP_VERSION)

    @app.post('/api/local/update')
    @owner
    def local_update():
        info = state['update'] or local_ops.check_update()
        if not info:
            return jsonify(error='ใช้เวอร์ชันล่าสุดแล้ว'), 409
        try:
            local_ops.install_update(info, core)
        except Exception as exc:
            return jsonify(error=f'อัปเดตไม่สำเร็จ: {exc}'), 500
        _exit_soon()
        return jsonify(ok=True, version=info['version'])

    @app.put('/api/local/autostart')
    @owner
    def local_autostart():
        on = bool((request.get_json() or {}).get('enabled'))
        try:
            return jsonify(ok=True, autostart=local_ops.set_autostart(on))
        except Exception as exc:
            return jsonify(error=str(exc)), 500

    @app.put('/api/local/address-mode')
    @owner
    def local_address_mode():
        mode = (request.get_json() or {}).get('mode')
        local_ops.set_address_mode(data_dir, mode)
        return jsonify(ok=True, restart_required=True)

    @app.post('/api/local/backup')
    @owner
    def local_backup():
        meta = core.backup_db('local')
        mirrored = local_ops.mirror_backup(data_dir, core.BACKUP_DIR / meta['file'])
        return jsonify(ok=True, file=meta['file'], mirrored=bool(mirrored))

    @app.post('/api/local/restore')
    @owner
    def local_restore():
        name = (request.get_json() or {}).get('file') or ''
        match = next((b for b in backups() if b['file'] == name), None)   # only files ZaabOS listed
        if not match:
            return jsonify(error='ไม่พบไฟล์สำรองนี้'), 404
        try:
            orders = local_ops.stage_restore(data_dir, match['path'])
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        core.log_action('local_restore_staged', detail=name)
        core.db().commit()
        local_ops.relaunch_after_exit()
        _exit_soon()
        return jsonify(ok=True, orders=orders)

    @app.post('/api/local/import-cloud')
    @owner
    def local_import_cloud():
        d = request.get_json() or {}
        try:
            branch_id = int(d.get('branch_id'))
        except (TypeError, ValueError):
            return jsonify(error='กรุณาเลือกสาขา'), 400
        if not d.get('username') or not d.get('password'):
            return jsonify(error='กรุณาใส่ชื่อผู้ใช้และรหัสผ่านของ zaabos.com'), 400
        conn = core.db()
        if not conn.execute('SELECT 1 FROM branches WHERE id=? AND tenant_id=?', (branch_id, g.tenant_id)).fetchone():
            return jsonify(error='ไม่พบสาขา'), 404
        try:
            fetch = cloud_fetcher(d.get('url') or 'https://zaabos.com', d['username'], d['password'])
            core.backup_db('before-import')
            result = import_from_cloud(core, conn, g.tenant_id, branch_id, fetch, d.get('cloud_branch_id'), g.user['id'])
        except CloudError as exc:
            conn.rollback()
            return jsonify(error=str(exc)), 502
        core.log_action('import_from_cloud', detail=json.dumps(result, ensure_ascii=False))
        conn.commit()
        return jsonify(ok=True, **result)

    def _exit_soon():
        """Let the HTTP reply go out, then exit so the relaunch script can take over."""
        import threading
        threading.Timer(1.0, lambda: os._exit(0)).start()
