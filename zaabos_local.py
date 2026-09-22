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
import sys
import threading
import webbrowser
from pathlib import Path

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


def lan_ip():
    """Address other devices on the shop Wi-Fi use to reach this PC (no packet is sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def needs_first_admin(db_path):
    if not db_path.exists():
        return True
    try:
        with sqlite3.connect(db_path) as c:
            return c.execute("SELECT 1 FROM users WHERE role='super_admin' LIMIT 1").fetchone() is None
    except sqlite3.Error:
        return True


def first_password_changed(db_path):
    try:
        with sqlite3.connect(db_path) as c:
            row = c.execute("SELECT must_change_password FROM users WHERE role='super_admin' ORDER BY id LIMIT 1").fetchone()
            return bool(row) and not row[0]
    except sqlite3.Error:
        return False


def prepare_environment(data_dir, port):
    """Must run before `import app`: the app reads these at import time."""
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ['ZAABOS_DATA_DIR'] = str(data_dir)
    os.environ.pop('DATABASE_URL', None)          # local mode is always SQLite on this PC
    os.environ.setdefault('ZAABOS_PUBLIC_URL', f'http://{lan_ip()}:{port}')
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


def backup_loop(core, stop):
    while True:
        try:
            meta = core.backup_db('local')
            prune_backups(core.BACKUP_DIR)
            print(f'[ZaabOS] backup ok: {meta["file"]}', flush=True)
        except Exception as exc:  # never stop the POS because a backup failed
            print(f'[ZaabOS] backup FAILED: {exc}', flush=True)
        if stop.wait(BACKUP_EVERY_SECONDS):
            return


def main(argv=None):
    ap = argparse.ArgumentParser(description='Run ZaabOS on this computer')
    ap.add_argument('--port', type=int, default=int(os.getenv('ZAABOS_PORT') or DEFAULT_PORT))
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--data-dir', default=None)
    args = ap.parse_args(argv)

    local_url = f'http://127.0.0.1:{args.port}'
    if port_in_use(args.port):
        # Already running (double-clicked twice): just bring the POS up.
        print(f'[ZaabOS] already running at {local_url}', flush=True)
        if not args.no_browser:
            webbrowser.open(local_url)
        return 0

    data_dir = Path(args.data_dir).expanduser() if args.data_dir else default_data_dir()
    note = prepare_environment(data_dir, args.port)

    import app as core   # noqa: E402  (environment must be ready first)
    import wsgi          # noqa: E402,F401  registers QR history + one-open-bill hooks

    stop = threading.Event()
    threading.Thread(target=backup_loop, args=(core, stop), daemon=True).start()

    print('=' * 60)
    print(f'  ZaabOS is running on this computer')
    print(f'  Cashier (this PC):  {local_url}')
    print(f'  Tablets / phones:   {os.environ["ZAABOS_PUBLIC_URL"]}')
    print(f'  Data folder:        {data_dir}')
    if note.exists():
        print(f'  First login:        see {note}')
    print('  Keep this window open while the shop is selling.')
    print('=' * 60, flush=True)

    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(local_url)).start()
        if note.exists():
            threading.Timer(2.0, lambda: webbrowser.open(note.as_uri())).start()

    from waitress import serve
    try:
        serve(wsgi.app, host='0.0.0.0', port=args.port, threads=12, ident=APP_NAME)
    finally:
        stop.set()
    return 0


if __name__ == '__main__':
    sys.exit(main())
