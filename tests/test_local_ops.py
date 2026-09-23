"""Items 1–6 for the shop PC: keep awake, auto-start, stable QR address, off-machine backup,
restore, self-update, import from the cloud."""
import io
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import local_ops  # noqa: E402


def _zaabos_db(path, orders=2):
    with sqlite3.connect(path) as c:
        for t in ('orders', 'payments', 'menu_items', 'users'):
            c.execute(f'CREATE TABLE {t}(id INTEGER PRIMARY KEY, x TEXT)')
        c.executemany('INSERT INTO orders(x) VALUES(?)', [('o',)] * orders)
    return path


def test_qr_address_warns_when_ip_changes(tmp_path, monkeypatch):
    monkeypatch.setattr(local_ops, 'lan_ip', lambda: '192.168.1.21')
    url, warn = local_ops.resolve_public_url(tmp_path, 8080)
    assert url == 'http://192.168.1.21:8080' and warn == ''
    monkeypatch.setattr(local_ops, 'lan_ip', lambda: '192.168.1.35')
    url, warn = local_ops.resolve_public_url(tmp_path, 8080)
    assert url == 'http://192.168.1.35:8080' and '192.168.1.21' in warn and '192.168.1.35' in warn
    assert local_ops.resolve_public_url(tmp_path, 8080)[1] == '', 'warn once, not every start'
    local_ops.set_address_mode(tmp_path, 'hostname')
    monkeypatch.setattr(local_ops, 'local_hostname', lambda: 'Shop-Mac.local')
    assert local_ops.resolve_public_url(tmp_path, 8080)[0] == 'http://Shop-Mac.local:8080'


def test_backup_is_mirrored_off_machine_and_pruned(tmp_path, monkeypatch):
    mirror = tmp_path / 'iCloud' / 'ZaabOS Backups'
    local_ops.save_config(tmp_path, {'mirror_dir': str(mirror)})
    monkeypatch.setattr(local_ops, 'MIRROR_KEEP', 3)
    import os, time
    for i in range(5):
        f = _zaabos_db(tmp_path / f'zaabos_local_{i}.db')
        os.utime(f, (time.time() + i, time.time() + i))
        local_ops.mirror_backup(tmp_path, f)
    assert sorted(p.name for p in mirror.glob('*.db')) == ['zaabos_local_2.db', 'zaabos_local_3.db', 'zaabos_local_4.db']
    local_ops.save_config(tmp_path, {'mirror_dir': ''})
    assert local_ops.mirror_backup(tmp_path, f) is None, 'owner can switch the copy off'


def test_restore_swaps_database_on_next_start_and_keeps_the_old_one(tmp_path):
    data = tmp_path / 'data'; (data / 'backups').mkdir(parents=True)
    _zaabos_db(data / 'zaabos.db', orders=1)
    (data / 'zaabos.db-wal').write_bytes(b'stale')
    backup = _zaabos_db(tmp_path / 'zaabos_local_old.db', orders=7)
    assert local_ops.stage_restore(data, backup) == 7
    local_ops.apply_pending_restore(data)
    with sqlite3.connect(data / 'zaabos.db') as c:
        assert c.execute('SELECT COUNT(*) FROM orders').fetchone()[0] == 7
    assert not (data / 'zaabos.db-wal').exists() and not (data / 'restore-pending.db').exists()
    kept = list((data / 'backups').glob('zaabos_before-restore_*.db'))
    with sqlite3.connect(kept[0]) as c:
        assert c.execute('SELECT COUNT(*) FROM orders').fetchone()[0] == 1


def test_restore_refuses_files_that_are_not_zaabos_backups(tmp_path):
    junk = tmp_path / 'x.db'
    with sqlite3.connect(junk) as c:
        c.execute('CREATE TABLE t(a)')
    with pytest.raises(ValueError):
        local_ops.stage_restore(tmp_path, junk)
    (tmp_path / 'y.db').write_bytes(b'not a database at all')
    with pytest.raises(ValueError):
        local_ops.validate_backup(tmp_path / 'y.db')


def test_update_check_picks_newest_release_with_this_platforms_file(monkeypatch):
    releases = [
        {'tag_name': 'local-v2.0.9', 'assets': [{'name': local_ops.asset_name(), 'browser_download_url': 'u1', 'size': 1}]},
        {'tag_name': 'local-v2.3.0', 'draft': True, 'assets': [{'name': local_ops.asset_name(), 'browser_download_url': 'd', 'size': 1}]},
        {'tag_name': 'local-v2.2.0', 'body': 'notes', 'assets': [{'name': local_ops.asset_name(), 'browser_download_url': 'u2', 'size': 5}]},
        {'tag_name': 'local-v9.0.0', 'assets': [{'name': 'other.zip', 'browser_download_url': 'x'}]},
        {'tag_name': 'v99', 'assets': [{'name': local_ops.asset_name(), 'browser_download_url': 'y'}]},
    ]
    monkeypatch.setattr(local_ops, 'APP_VERSION', '2.1.0')
    monkeypatch.setattr(local_ops.urllib.request, 'urlopen', lambda req, timeout=0: io.BytesIO(json.dumps(releases).encode()))
    info = local_ops.check_update()
    assert info['version'] == '2.2.0' and info['url'] == 'u2' and info['notes'] == 'notes'
    monkeypatch.setattr(local_ops, 'APP_VERSION', '2.2.0')
    assert local_ops.check_update() is None


@pytest.mark.skipif(sys.platform != 'darwin', reason='macOS LaunchAgent')
def test_autostart_launch_agent_restarts_only_after_a_crash(tmp_path, monkeypatch):
    import plistlib, subprocess
    monkeypatch.setattr(local_ops.Path, 'home', classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(local_ops.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a, 0))
    assert local_ops.set_autostart(True) and local_ops.autostart_enabled()
    plist = plistlib.loads((tmp_path / 'Library/LaunchAgents/com.zaabos.local.plist').read_bytes())
    assert plist['RunAtLoad'] is True and plist['KeepAlive'] == {'SuccessfulExit': False}
    assert local_ops.set_autostart(False) is False and not local_ops.autostart_enabled()


def test_import_from_cloud_copies_menu_tables_and_settings():
    sys.path.insert(0, str(ROOT / 'tests'))
    from test_money_reconciliation import core, shop as _shop  # noqa: F401
    import local_api
    import uuid
    with core.app.app_context():
        c = core.db()
        tenant = c.execute("INSERT INTO tenants(name,active,subscription_status,created_at) VALUES(?,1,'active',?)", ('Import ' + uuid.uuid4().hex, core.now())).lastrowid
        branch = c.execute('INSERT INTO branches(tenant_id,name,active,created_at) VALUES(?,?,1,?)', (tenant, 'B', core.now())).lastrowid
        old_table = c.execute("INSERT INTO dining_tables(tenant_id,branch_id,name,qr_token,active,created_at) VALUES(?,?,?,?,1,?)",
                              (tenant, branch, 'Old', uuid.uuid4().hex, core.now())).lastrowid
        cloud = {
            '/api/bootstrap': {'branches': [{'id': 9, 'name': 'สาขาหลัก'}],
                               'categories': [{'id': 1, 'branch_id': 9, 'name': 'ອາຫານ', 'icon': '🍛', 'sort_order': 0}],
                               'items': [{'id': 5, 'branch_id': 9, 'category_id': 1, 'name': 'ตำหมากหุ่ง', 'base_price': 25000, 'kitchen_station_id': 3,
                                          'option_groups': [{'name': 'เผ็ด', 'selection_type': 'single', 'max_select': 1,
                                                             'options': [{'name': 'น้อย', 'price_delta': 0}, {'name': 'มาก', 'price_delta': 1000}]}]}],
                               'tables': [{'id': 1, 'branch_id': 9, 'name': 'โต๊ะ 1', 'qr_token': 'cloud-token'}, {'id': 2, 'branch_id': 9, 'name': 'โต๊ะ 2'}]},
            '/api/kitchen/stations?branch_id=9': [{'id': 3, 'name': 'ครัวร้อน'}],
            '/api/settings/receipt?branch_id=9': {'shop_name': 'SESSION24 Café', 'footer': 'ຂອບໃຈ'},
            '/api/pricing/settings?branch_id=9': {'tax_rate': 10, 'service_charge_rate': 0},
        }
        result = local_api.import_from_cloud(core, c, tenant, branch, cloud.__getitem__)
        c.commit()
        assert result == {'branch': 'สาขาหลัก', 'categories': 1, 'items': 1, 'tables': 2, 'stations': 1}
        item = c.execute('SELECT * FROM menu_items WHERE tenant_id=? AND active=1', (tenant,)).fetchone()
        assert item['name'] == 'ตำหมากหุ่ง' and c.execute('SELECT name FROM kitchen_stations WHERE id=?', (item['kitchen_station_id'],)).fetchone()['name'] == 'ครัวร้อน'
        opts = c.execute('SELECT o.name,o.price_delta FROM menu_options o JOIN menu_option_groups g2 ON g2.id=o.group_id WHERE g2.menu_item_id=? ORDER BY o.id', (item['id'],)).fetchall()
        assert [(o['name'], o['price_delta']) for o in opts] == [('น้อย', 0), ('มาก', 1000)]
        tables = c.execute('SELECT name,qr_token,active FROM dining_tables WHERE tenant_id=? ORDER BY id', (tenant,)).fetchall()
        assert [(t['name'], t['active']) for t in tables] == [('Old', 0), ('โต๊ะ 1', 1), ('โต๊ะ 2', 1)]
        assert 'cloud-token' not in [t['qr_token'] for t in tables], 'QR codes must point at this PC, not the cloud'
        assert c.execute('SELECT tax_rate FROM pricing_settings WHERE tenant_id=?', (tenant,)).fetchone()['tax_rate'] == 10
        assert json.loads(c.execute('SELECT settings_json FROM receipt_settings WHERE tenant_id=?', (tenant,)).fetchone()['settings_json'])['shop_name'] == 'SESSION24 Café'


@pytest.mark.skipif(sys.platform.startswith('win'), reason='POSIX shell swap (macOS)')
def test_update_swap_replaces_app_and_rolls_back_on_failure(tmp_path):
    import subprocess
    bundle = tmp_path / 'Apps' / 'ZaabOS Local.app'; (bundle / 'Contents').mkdir(parents=True)
    (bundle / 'Contents' / 'v').write_text('old')
    new = tmp_path / 'new' / 'ZaabOS.app'; (new / 'Contents').mkdir(parents=True); (new / 'Contents' / 'v').write_text('new')
    log = tmp_path / 'relaunched'
    dead_pid = 999999
    subprocess.run(['/bin/sh', '-c', local_ops.mac_swap_script(dead_pid, bundle, new, relaunch=f'echo >"{log}"')], check=True, timeout=20)
    assert (bundle / 'Contents' / 'v').read_text() == 'new' and not Path(str(bundle) + '.old').exists() and log.exists()
    # new app missing (bad download): old app must come back and still be started
    log.unlink()
    subprocess.run(['/bin/sh', '-c', local_ops.mac_swap_script(dead_pid, bundle, tmp_path / 'missing.app', relaunch=f'echo >"{log}"')], timeout=20)
    assert (bundle / 'Contents' / 'v').read_text() == 'new' and log.exists()
