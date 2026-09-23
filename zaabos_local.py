"""ZaabOS Local — runs the POS on the shop's own computer (Windows or Mac).

The cashier PC is the server: data lives in a SQLite file on this machine, so selling,
kitchen and payments keep working when the internet is down. Tablets and phones on the
shop Wi-Fi connect to this PC's network address.

    python zaabos_local.py            # start and open the POS in the browser
    python zaabos_local.py --no-browser --port 8080

Data folder (database, session key, backups, first-login note):
    Windows: %APPDATA%\\ZaabOS        macOS: ~/Library/Application Support/ZaabOS
    Override with ZAABOS_DATA_DIR.
"""
import argparse
import os
import secrets
import socket
import sqlite3
from contextlib import closing
import sys
import threading
import webbrowser
from pathlib import Path

import local_ops

APP_NAME = 'ZaabOS'
DEFAULT_PORT = 8080
BACKUP_EVERY_SECONDS = 2 * 60 * 60
KEEP_BACKUPS = 60


def default_data_dir():
    if os.getenv('ZAABOS_DATA_DIR'):
        return Path(os.environ['ZAABOS_DATA_DIR']).expanduser()
    if sys.platform.startswith('win'):
        return Path(os.getenv('APPDATA') or Path.home() / 'AppData' / 'Roaming') / APP_NAME
    if sys.platform == 'darwin':
        return Path.home() / 'Library' / 'Application Support' / APP_NAME
    return Path(os.getenv('XDG_DATA_HOME') or Path.home() / '.local' / 'share') / APP_NAME


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def needs_first_admin(db_path):
    if not db_path.exists():
        return True
    try:
        with closing(sqlite3.connect(db_path)) as c:
            return c.execute("SELECT 1 FROM users WHERE role='super_admin' LIMIT 1").fetchone() is None
    except sqlite3.Error:
        return True


def first_password_changed(db_path):
    try:
        with closing(sqlite3.connect(db_path)) as c:
            row = c.execute("SELECT must_change_password FROM users WHERE role='super_admin' ORDER BY id LIMIT 1").fetchone()
            return bool(row) and not row[0]
    except sqlite3.Error:
        return False


def prepare_environment(data_dir, port):
    """Must run before `import app`: the app reads these at import time."""
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ['ZAABOS_DATA_DIR'] = str(data_dir)
    os.environ.pop('DATABASE_URL', None)          # local mode is always SQLite on this PC
    local_ops.apply_pending_restore(data_dir)       # before anything opens the database
    url, warning = local_ops.resolve_public_url(data_dir, port)
    os.environ.setdefault('ZAABOS_PUBLIC_URL', url)
    if warning:
        os.environ['ZAABOS_ADDRESS_WARNING'] = warning
    os.environ['ZAABOS_LOCAL_PRINT'] = '1'           # this PC sends tickets to the Wi-Fi printers
    os.environ['ZAABOS_LOCAL_DATA_DIR'] = str(data_dir)
    note = data_dir / 'first-login.txt'
    if note.exists() and first_password_changed(data_dir / 'zaabos.db'):
        note.unlink(missing_ok=True)   # the one-time password is dead; don't leave it lying around
    if needs_first_admin(data_dir / 'zaabos.db') and not os.getenv('ZAABOS_ADMIN_PASSWORD'):
        # Nobody reads a console on a shop PC: write the one-time password to a file the owner
        # can open. The app forces a password change on first login.
        password = secrets.token_urlsafe(9)
        os.environ['ZAABOS_ADMIN_PASSWORD'] = password
        note.write_text(f'ZaabOS first login\n\nusername: admin\npassword: {password}\n\n'
                        'You will be asked to set a new password after logging in.\n'
                        'Delete this file after that.\n', encoding='utf-8')
    return note


def prune_backups(backup_dir, keep=KEEP_BACKUPS):
    files = sorted((p for p in backup_dir.glob('zaabos_local_*.db')), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[keep:]:
        old.unlink(missing_ok=True)
        Path(str(old) + '.json').unlink(missing_ok=True)


def backup_loop(core, stop, data_dir):
    while True:
        try:
            meta = core.backup_db('local')
            prune_backups(core.BACKUP_DIR)
            print(f'[ZaabOS] backup ok: {meta["file"]}', flush=True)
            try:
                mirrored = local_ops.mirror_backup(data_dir, core.BACKUP_DIR / meta['file'])
                if mirrored:
                    print(f'[ZaabOS] backup copied to {mirrored.parent}', flush=True)
            except Exception as exc:
                print(f'[ZaabOS] off-machine backup FAILED: {exc}', flush=True)
        except Exception as exc:  # never stop the POS because a backup failed
            print(f'[ZaabOS] backup FAILED: {exc}', flush=True)
        if stop.wait(BACKUP_EVERY_SECONDS):
            return


def open_url(url):
    """webbrowser.open needs Apple Events permission inside a .app bundle and silently does
    nothing; `open` always works on macOS."""
    if sys.platform == 'darwin':
        import subprocess
        subprocess.Popen(['open', url])
    else:
        webbrowser.open(url)


def run_mac_menu_bar(local_url, public_url, data_dir, core):
    """macOS: a menu-bar icon instead of a Dock icon that bounces forever. The server runs in a
    background thread; this menu is how staff reopen the POS, back up, restore, update or quit."""
    import rumps

    def notify(title, msg=''):
        try:
            rumps.notification('ZaabOS', title, msg)
        except Exception:
            pass

    class ZaabOSMenu(rumps.App):
        def __init__(self):
            icon = Path(__file__).resolve().parent / 'static' / 'menubar-icon.png'
            # Brand icon in the menu bar (no emoji: consistent on every Mac); text fallback if missing.
            super().__init__('ZaabOS', title=None if icon.exists() else 'ZaabOS', icon=str(icon) if icon.exists() else None,
                             template=False, quit_button=None)
            self.update_info = None
            self.autostart_item = rumps.MenuItem('เปิดอัตโนมัติเมื่อเปิดเครื่อง', callback=self.toggle_autostart)
            self.autostart_item.state = local_ops.autostart_enabled()
            self.hostname_item = rumps.MenuItem('QR ใช้ชื่อเครื่องแทน IP', callback=self.toggle_hostname)
            self.hostname_item.state = local_ops.load_config(data_dir).get('address_mode') == 'hostname'
            self.update_item = rumps.MenuItem(f'เวอร์ชัน {local_ops.APP_VERSION} — ตรวจหาอัปเดต', callback=self.update)
            self.menu = [rumps.MenuItem('เปิด ZaabOS', callback=self.open_pos),
                         rumps.MenuItem(f'แท็บเล็ต/มือถือ: {public_url}', callback=self.copy_public), None,
                         rumps.MenuItem('สำรองข้อมูลตอนนี้', callback=self.backup_now),
                         rumps.MenuItem('กู้ข้อมูลจากไฟล์สำรอง…', callback=self.restore),
                         rumps.MenuItem('เปิดโฟลเดอร์ข้อมูล', callback=self.open_data),
                         rumps.MenuItem('ตรวจสุขภาพระบบ', callback=self.health), None,
                         self.autostart_item, self.hostname_item, self.update_item, None,
                         rumps.MenuItem('ปิด ZaabOS', callback=self.quit_app)]
            if os.getenv('ZAABOS_ADDRESS_WARNING'):
                notify('ที่อยู่เครื่องเปลี่ยน', os.environ['ZAABOS_ADDRESS_WARNING'])
            if os.getenv('ZAABOS_UPDATE_MESSAGE'):
                notify('อัปเดตโปรแกรม', os.environ['ZAABOS_UPDATE_MESSAGE'])
            local_ops.check_update_async(self.found_update)

        def found_update(self, info):
            self.update_info = info
            self.update_item.title = f'อัปเดตเป็นเวอร์ชัน {info["version"]} (ใหม่)'
            self.title = ' ใหม่'
            notify('มีเวอร์ชันใหม่', f'กดไอคอน ZaabOS ด้านบนจอ → อัปเดตเป็นเวอร์ชัน {info["version"]}')

        def open_pos(self, _):
            open_url(local_url)

        def copy_public(self, _):
            import subprocess
            subprocess.run(['pbcopy'], input=public_url.encode(), check=False)
            notify('คัดลอกที่อยู่แล้ว', public_url)

        def backup_now(self, _):
            try:
                meta = core.backup_db('local')
                where = local_ops.mirror_backup(data_dir, core.BACKUP_DIR / meta['file'])
                notify('สำรองข้อมูลแล้ว', f'{meta["file"]}' + (f' · สำเนาใน {where.parent.name}' if where else ''))
            except Exception as exc:
                rumps.alert('สำรองข้อมูลไม่สำเร็จ', str(exc))

        def restore(self, _):
            import subprocess
            start = local_ops.mirror_dir(data_dir) or (Path(data_dir) / 'backups')
            script = (f'POSIX path of (choose file with prompt "เลือกไฟล์สำรอง ZaabOS (.db)" '
                      f'default location (POSIX file "{start if Path(start).exists() else Path(data_dir) / "backups"}"))')
            r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
            path = r.stdout.strip()
            if not path:
                return
            try:
                orders = local_ops.validate_backup(path)
            except ValueError as exc:
                rumps.alert('ใช้ไฟล์นี้ไม่ได้', str(exc))
                return
            if not rumps.alert('กู้ข้อมูลจากไฟล์นี้?', f'{Path(path).name}\nมี {orders} ออเดอร์\n\n'
                               'ข้อมูลปัจจุบันจะถูกเก็บสำรองไว้ก่อน แล้ว ZaabOS จะเปิดใหม่', ok='กู้ข้อมูล', cancel='ยกเลิก'):
                return
            local_ops.stage_restore(data_dir, path)
            local_ops.relaunch_after_exit()
            rumps.quit_application()

        def health(self, _):
            import local_api
            try:
                with core.app.app_context():
                    conn = core.db()
                    tenant = conn.execute('SELECT id FROM tenants WHERE active=1 ORDER BY id LIMIT 1').fetchone()
                    checks = local_api.health_checks(core, conn, tenant['id'], data_dir)
            except Exception as exc:
                rumps.alert('ตรวจไม่สำเร็จ', str(exc))
                return
            icon = {'ok': '✓', 'warn': '!', 'bad': '✗'}
            bad = sum(c['level'] != 'ok' for c in checks)
            rumps.alert('ทุกอย่างปกติ ✓' if not bad else f'ต้องดู {bad} เรื่อง',
                        '\n'.join(f"{icon[c['level']]} {c['title']}" + (f"\n     {c['detail']}" if c['detail'] and c['level'] != 'ok' else '') for c in checks))

        def open_data(self, _):
            open_url(str(data_dir))

        def toggle_autostart(self, item):
            try:
                item.state = local_ops.set_autostart(not item.state)
            except Exception as exc:
                rumps.alert('ตั้งค่าไม่สำเร็จ', str(exc))

        def toggle_hostname(self, item):
            mode = 'ip' if item.state else 'hostname'
            local_ops.set_address_mode(data_dir, mode)
            item.state = mode == 'hostname'
            rumps.alert('เปลี่ยนที่อยู่สำหรับ QR แล้ว', 'ปิดแล้วเปิด ZaabOS ใหม่ จากนั้นพิมพ์ QR โต๊ะใหม่\n'
                        + ('ชื่อเครื่อง: ' + local_ops.local_hostname() if mode == 'hostname' else 'ใช้ IP ของเครื่อง'))

        def update(self, _):
            info = self.update_info
            if not info:
                try:
                    info = local_ops.check_update()
                except Exception as exc:
                    rumps.alert('ตรวจอัปเดตไม่ได้', f'ต้องต่ออินเทอร์เน็ต ({exc})')
                    return
            if not info:
                rumps.alert('ใช้เวอร์ชันล่าสุดแล้ว', f'ZaabOS {local_ops.APP_VERSION}')
                return
            if not rumps.alert(f'อัปเดตเป็นเวอร์ชัน {info["version"]}?', (info.get('notes') or '') +
                               '\n\nข้อมูลร้านไม่หาย (สำรองให้ก่อนอัตโนมัติ) · ZaabOS จะปิดและเปิดใหม่ประมาณ 10 วินาที',
                               ok='อัปเดต', cancel='ภายหลัง'):
                return
            try:
                local_ops.install_update(info, core, data_dir)
            except Exception as exc:
                rumps.alert('อัปเดตไม่สำเร็จ', str(exc))
                return
            rumps.quit_application()

        def quit_app(self, _):
            if rumps.alert('ปิด ZaabOS?', 'แท็บเล็ตและ QR จะสั่งอาหารไม่ได้จนกว่าจะเปิดใหม่', ok='ปิด', cancel='ยกเลิก'):
                rumps.quit_application()

    ZaabOSMenu().run()


def main(argv=None):
    # Windows consoles are cp1252/cp874: never let a Thai/Lao log line crash the POS.
    for stream in (sys.stdout, sys.stderr):
        try: stream.reconfigure(errors='replace')
        except (AttributeError, ValueError): pass
    ap = argparse.ArgumentParser(description='Run ZaabOS on this computer')
    ap.add_argument('--port', type=int, default=int(os.getenv('ZAABOS_PORT') or DEFAULT_PORT))
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--data-dir', default=None)
    ap.add_argument(local_ops.LAUNCHD_FLAG, dest='from_launchd', action='store_true', help=argparse.SUPPRESS)
    ap.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    local_url = f'http://127.0.0.1:{args.port}'
    if port_in_use(args.port):
        # Already running (double-clicked twice): just bring the POS up.
        print(f'[ZaabOS] already running at {local_url}', flush=True)
        if not args.no_browser:
            open_url(local_url)
        return 0

    data_dir = Path(args.data_dir).expanduser() if args.data_dir else default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    cfg = local_ops.load_config(data_dir)
    # Only the real install (default data folder, normal launch) registers itself to start at login;
    # a copy run with --data-dir/--no-browser (tests, trying a download) must not replace it.
    real_install = getattr(sys, 'frozen', False) and not args.data_dir and not args.no_browser
    if real_install and not cfg.get('autostart_initialized'):
        # First run of the installed app: start with the computer by default (owner can turn it off).
        try:
            local_ops.set_autostart(True)
        except Exception as exc:
            print(f'[ZaabOS] auto-start not set: {exc}', flush=True)
        cfg['autostart_initialized'] = True
        local_ops.save_config(data_dir, cfg)
    if real_install and sys.platform.startswith('win') and not args.worker:
        # Windows has no launchd: this copy stays as a small supervisor that restarts the POS if it crashes.
        env = dict(os.environ, ZAABOS_SUPERVISOR_PID=str(os.getpid()))
        cmd = [sys.executable, '--worker'] + [a for a in (argv if argv is not None else sys.argv[1:])]
        print('[ZaabOS] supervisor running — the POS restarts itself if it crashes', flush=True)
        return local_ops.supervise(cmd, env=env)
    if real_install and not args.from_launchd and local_ops.launchd_handoff():
        print('[ZaabOS] started under launchd (restarts itself if it crashes)', flush=True)
        return 0

    note = prepare_environment(data_dir, args.port)
    update_msg = local_ops.update_outcome(data_dir)
    if update_msg:
        os.environ['ZAABOS_UPDATE_MESSAGE'] = update_msg
        print('[ZaabOS] ' + update_msg, flush=True)

    import app as core   # noqa: E402  (environment must be ready first)
    import wsgi          # noqa: E402,F401  registers QR history + one-open-bill hooks

    import printing      # noqa: E402
    stop = threading.Event()
    threading.Thread(target=backup_loop, args=(core, stop, data_dir), daemon=True).start()
    import local_api     # noqa: E402  shop-PC settings/update/restore/import API for the web UI
    local_api.register(core, data_dir, args.port)
    local_ops.keep_awake()
    print_stop = printing.start_worker(core)

    print('=' * 60)
    print(f'  ZaabOS {local_ops.APP_VERSION} is running on this computer')
    print(f'  Cashier (this PC):  {local_url}')
    print(f'  Tablets / phones:   {os.environ["ZAABOS_PUBLIC_URL"]}')
    print(f'  Data folder:        {data_dir}')
    if note.exists():
        print(f'  First login:        see {note}')
    if os.getenv('ZAABOS_ADDRESS_WARNING'):
        print('  !! ' + os.environ['ZAABOS_ADDRESS_WARNING'])
    print('  Keep this window open while the shop is selling.')
    print('=' * 60, flush=True)

    if not args.no_browser:
        threading.Timer(1.5, lambda: open_url(local_url)).start()
        if note.exists():
            threading.Timer(2.0, lambda: open_url(note.as_uri())).start()

    from waitress import serve
    server = lambda: serve(wsgi.app, host='0.0.0.0', port=args.port, threads=12, ident=APP_NAME)
    use_menu_bar = sys.platform == 'darwin' and not args.no_browser
    if use_menu_bar:
        try:
            import rumps  # noqa: F401
        except ImportError:
            use_menu_bar = False
    try:
        if use_menu_bar:
            threading.Thread(target=server, name='zaabos-http', daemon=True).start()
            run_mac_menu_bar(local_url, os.environ['ZAABOS_PUBLIC_URL'], data_dir, core)
        else:
            server()
    finally:
        stop.set()
        print_stop.set()
    return 0


if __name__ == '__main__':
    sys.exit(main())
