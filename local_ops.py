"""Shop-PC operations for ZaabOS Local: keep awake, start at login, stable tablet/QR address,
off-machine backup + restore, self-update from GitHub Releases.

Everything here is best-effort and must never stop the POS from selling.
"""
import json
import os
import shlex
import shutil
import socket
import sqlite3
from contextlib import closing
import subprocess
import sys
import tempfile
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

APP_VERSION = '2.6.0'
RELEASES_API = os.getenv('ZAABOS_UPDATE_FEED') or 'https://api.github.com/repos/session24-la/zaabos/releases?per_page=20'
RELEASE_TAG_PREFIX = 'local-v'
LAUNCH_AGENT_LABEL = 'com.zaabos.local'
MIRROR_KEEP = 30


def _log(msg):
    print(f'[ZaabOS] {msg}', flush=True)


# ------------------------------------------------------------------ config ---
def config_path(data_dir):
    return Path(data_dir) / 'config.json'


def load_config(data_dir):
    try:
        return json.loads(config_path(data_dir).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def save_config(data_dir, cfg):
    p = config_path(data_dir)
    tmp = p.with_suffix('.tmp')
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(tmp, p)


# -------------------------------------------------------------- keep awake ---
_awake_proc = None


def keep_awake():
    """A sleeping cashier PC takes every tablet and QR phone down with it."""
    global _awake_proc
    try:
        if sys.platform == 'darwin':
            # -i idle sleep, -s system sleep on AC power; ends automatically when this process exits.
            _awake_proc = subprocess.Popen(['caffeinate', '-is', '-w', str(os.getpid())])
        elif sys.platform.startswith('win'):
            import ctypes
            ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        return True
    except Exception as exc:
        _log(f'keep-awake unavailable: {exc}')
        return False


# --------------------------------------------------------- start at login ---
def app_executable():
    return Path(sys.executable if getattr(sys, 'frozen', False) else sys.argv[0]).resolve()


def app_bundle():
    """macOS: the .app folder around the running executable (None when run from source)."""
    exe = app_executable()
    for parent in exe.parents:
        if parent.suffix == '.app':
            return parent
    return None


def _launch_agent_path():
    return Path.home() / 'Library' / 'LaunchAgents' / f'{LAUNCH_AGENT_LABEL}.plist'


def autostart_enabled():
    if sys.platform == 'darwin':
        return _launch_agent_path().exists()
    if sys.platform.startswith('win'):
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run') as k:
                winreg.QueryValueEx(k, 'ZaabOS')
                return True
        except OSError:
            return False
    return False


LAUNCHD_FLAG = '--from-launchd'


def launch_agent_plist(args):
    return {'Label': LAUNCH_AGENT_LABEL, 'ProgramArguments': list(args), 'RunAtLoad': True,
            'KeepAlive': {'SuccessfulExit': False}, 'LimitLoadToSessionType': 'Aqua', 'ProcessType': 'Interactive'}


def supervise(cmd, env=None, max_quick_crashes=5, window=60, backoff=2.0, sleep=None):
    """Windows crash-restart (macOS uses launchd): run the POS as a child process and start it
    again whenever it dies abnormally. A normal quit (exit code 0) ends supervision. Too many
    crashes in a short time slow down instead of spinning. Returns the child's last exit code."""
    import time as _time
    sleep = sleep or _time.sleep
    crashes = []
    while True:
        started = _time.time()
        code = subprocess.call(cmd, env=env)
        if code == 0:
            return 0
        now_t = _time.time()
        crashes = [t for t in crashes if now_t - t < window] + [now_t]
        _log(f'POS stopped unexpectedly (exit {code}) — restarting')
        if len(crashes) >= max_quick_crashes:
            _log('many crashes in a row — waiting 30 s before the next restart')
            sleep(30)
            crashes = []
        else:
            sleep(backoff if now_t - started < 5 else 0.5)


def launchd_handoff():
    """macOS: crash-restart only works for a process that launchd itself started. When the owner
    opens the app by hand (or an update/restore relaunches it), refresh the LaunchAgent and let
    launchd start the real instance, then this copy exits. Returns True if handed off."""
    if sys.platform != 'darwin' or not getattr(sys, 'frozen', False) or not autostart_enabled():
        return False
    set_autostart(True)                      # current app path + launchd flag, even after a move/update
    domain = f'gui/{os.getuid()}'
    subprocess.run(['launchctl', 'bootout', f'{domain}/{LAUNCH_AGENT_LABEL}'], capture_output=True)
    r = subprocess.run(['launchctl', 'bootstrap', domain, str(_launch_agent_path())], capture_output=True, text=True)
    if r.returncode != 0:
        r = subprocess.run(['launchctl', 'kickstart', f'{domain}/{LAUNCH_AGENT_LABEL}'], capture_output=True, text=True)
    if r.returncode != 0:
        _log(f'launchd handoff failed, running directly: {(r.stderr or "").strip()}')
        return False
    return True


def set_autostart(enabled):
    """Start ZaabOS when the owner logs in; on macOS also restart it if it crashes
    (KeepAlive only on a non-zero exit, so 'Quit ZaabOS' really quits)."""
    exe = str(app_executable())
    if sys.platform == 'darwin':
        path = _launch_agent_path()
        if not enabled:
            # No `launchctl unload`: when launchd runs ZaabOS that would kill the POS mid-service.
            # Removing the file stops it from starting at the next login.
            path.unlink(missing_ok=True)
            return False
        import plistlib
        path.parent.mkdir(parents=True, exist_ok=True)
        args = ([exe] if getattr(sys, 'frozen', False) else [sys.executable, exe]) + [LAUNCHD_FLAG]
        with open(path, 'wb') as f:
            plistlib.dump(launch_agent_plist(args), f)
        return True
    if sys.platform.startswith('win'):
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run', 0, winreg.KEY_SET_VALUE) as k:
            if enabled:
                winreg.SetValueEx(k, 'ZaabOS', 0, winreg.REG_SZ, f'"{exe}"')
            else:
                try:
                    winreg.DeleteValue(k, 'ZaabOS')
                except OSError:
                    pass
        return enabled
    return False


# ------------------------------------------------ stable tablet/QR address ---
def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def local_hostname():
    """Bonjour/mDNS name (e.g. LoneWolfs-MacBook-Pro.local) — stays the same when the router
    hands out a different IP."""
    if sys.platform == 'darwin':
        try:
            name = subprocess.run(['scutil', '--get', 'LocalHostName'], capture_output=True, text=True, timeout=3).stdout.strip()
            if name:
                return name + '.local'
        except (OSError, subprocess.SubprocessError):
            pass
    return socket.gethostname().split('.')[0] + '.local'


def resolve_public_url(data_dir, port):
    """Address printed in table QR codes. 'ip' (default, works on every phone) or 'hostname'.
    Returns (url, warning). The warning tells the owner when the IP changed since last start —
    QR stickers printed with the old address stop working."""
    cfg = load_config(data_dir)
    mode = cfg.get('address_mode') or 'ip'
    ip = lan_ip()
    warning = ''
    last = cfg.get('last_ip')
    if mode == 'ip' and last and last != ip and not ip.startswith('127.'):
        warning = (f'IP ของเครื่องเปลี่ยนจาก {last} เป็น {ip} — QR ที่พิมพ์ไว้ใช้ไม่ได้แล้ว '
                   'ให้ล็อก IP ที่เราเตอร์ หรือเปลี่ยนเป็น "ใช้ชื่อเครื่อง" แล้วพิมพ์ QR ใหม่')
    if not ip.startswith('127.') and last != ip:
        cfg['last_ip'] = ip
        save_config(data_dir, cfg)
    host = local_hostname() if mode == 'hostname' else ip
    return f'http://{host}:{port}', warning


def set_address_mode(data_dir, mode):
    cfg = load_config(data_dir)
    cfg['address_mode'] = 'hostname' if mode == 'hostname' else 'ip'
    save_config(data_dir, cfg)


# ----------------------------------------------- off-machine backup mirror ---
def default_mirror_dir():
    """iCloud Drive (Mac) / OneDrive (Windows): a copy survives a dead or stolen shop PC."""
    if sys.platform == 'darwin':
        icloud = Path.home() / 'Library' / 'Mobile Documents' / 'com~apple~CloudDocs'
        if icloud.is_dir():
            return icloud / 'ZaabOS Backups'
    if sys.platform.startswith('win') and os.getenv('OneDrive'):
        return Path(os.environ['OneDrive']) / 'ZaabOS Backups'
    return None


def install_data_dir():
    """Where the installed shop app keeps its data (zaabos_local.default_data_dir without overrides —
    zaabos_local exports ZAABOS_DATA_DIR for whatever --data-dir it was started with)."""
    if sys.platform.startswith('win'):
        return Path(os.getenv('APPDATA') or Path.home() / 'AppData' / 'Roaming') / 'ZaabOS'
    if sys.platform == 'darwin':
        return Path.home() / 'Library' / 'Application Support' / 'ZaabOS'
    return Path(os.getenv('XDG_DATA_HOME') or Path.home() / '.local' / 'share') / 'ZaabOS'


def mirror_dir(data_dir):
    cfg = load_config(data_dir)
    if cfg.get('mirror_dir') == '':
        return None                      # owner switched it off
    if cfg.get('mirror_dir'):
        return Path(cfg['mirror_dir']).expanduser()
    # Only the real shop install copies to iCloud/OneDrive by default. Test runs and extra
    # instances (--data-dir …) on the same computer must never push the shop's own copies
    # out of the folder (it keeps the newest MIRROR_KEEP files only).
    try:
        if Path(data_dir).expanduser().resolve() != install_data_dir().resolve():
            return None
    except OSError:
        return None
    return default_mirror_dir()


def mirror_backup(data_dir, backup_file):
    target = mirror_dir(data_dir)
    if not target:
        return None
    target.mkdir(parents=True, exist_ok=True)
    dest = target / Path(backup_file).name
    shutil.copy2(backup_file, dest)
    files = sorted(target.glob('zaabos_*.db'), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[MIRROR_KEEP:]:
        old.unlink(missing_ok=True)
    return dest


# -------------------------------------------------------------- restore ---
def validate_backup(path):
    """A restore must be a healthy ZaabOS database, never an arbitrary file."""
    try:
        with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True)) as c:
            if c.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('ไฟล์สำรองเสียหาย')
            tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'orders', 'payments', 'menu_items', 'users'} <= tables:
                raise ValueError('ไม่ใช่ไฟล์สำรองของ ZaabOS')
            n = c.execute('SELECT COUNT(*) FROM orders').fetchone()[0]
        return n
    except sqlite3.Error as exc:
        raise ValueError(f'เปิดไฟล์สำรองไม่ได้: {exc}')


def stage_restore(data_dir, backup_file):
    """Copy the chosen backup next to the live DB; it replaces the DB on the next start, before
    any connection is open (swapping a live SQLite/WAL file under a running server corrupts it)."""
    orders = validate_backup(backup_file)
    shutil.copy2(backup_file, Path(data_dir) / 'restore-pending.db')
    return orders


def apply_pending_restore(data_dir):
    data_dir = Path(data_dir)
    pending = data_dir / 'restore-pending.db'
    if not pending.exists():
        return None
    db = data_dir / 'zaabos.db'
    try:
        validate_backup(pending)
    except ValueError as exc:
        pending.unlink(missing_ok=True)
        _log(f'restore skipped: {exc}')
        return None
    if db.exists():
        keep = data_dir / 'backups' / f"zaabos_before-restore_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.db"
        keep.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(db)) as src, closing(sqlite3.connect(keep)) as out:
            src.backup(out)
    for suffix in ('-wal', '-shm'):
        Path(str(db) + suffix).unlink(missing_ok=True)
    os.replace(pending, db)
    _log('restore applied')
    return db


# -------------------------------------------------------------- restart ---
def relaunch_after_exit():
    """Start a fresh copy once this process has exited (used after restore/update)."""
    pid = os.getpid()
    bundle = app_bundle()
    if sys.platform == 'darwin':
        target = f'open "{bundle}"' if bundle else f'"{sys.executable}" "{app_executable()}"'
        subprocess.Popen(['/bin/sh', '-c', f'while kill -0 {pid} 2>/dev/null; do sleep 0.3; done; sleep 1; {target}'],
                         start_new_session=True)
    elif sys.platform.startswith('win'):
        exe = str(app_executable())
        ps = f'Wait-Process -Id {_wait_pids(pid)} -ErrorAction SilentlyContinue; Start-Sleep 1; Start-Process "{exe}"'
        subprocess.Popen(['powershell', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
                         creationflags=0x00000008)  # DETACHED_PROCESS


def _wait_pids(pid):
    """Windows: the supervisor holds ZaabOS.exe open too; wait for both before replacing files."""
    sup = os.getenv('ZAABOS_SUPERVISOR_PID')
    return f'{pid},{int(sup)}' if sup and sup.isdigit() else str(pid)


# --------------------------------------------------------------- update ---
def _ver(tag):
    try:
        return tuple(int(x) for x in tag[len(RELEASE_TAG_PREFIX):].split('.'))
    except ValueError:
        return (0,)


def asset_name():
    return 'ZaabOS-Local-macOS.zip' if sys.platform == 'darwin' else 'ZaabOS-Local-Windows.zip'


def check_update(timeout=8):
    """Newest published local-v* release newer than this app, or None."""
    req = urllib.request.Request(RELEASES_API, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'ZaabOS'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        releases = json.loads(r.read())
    best = None
    for rel in releases:
        tag = rel.get('tag_name') or ''
        if rel.get('draft') or rel.get('prerelease') or not tag.startswith(RELEASE_TAG_PREFIX):
            continue
        asset = next((a for a in rel.get('assets') or [] if a.get('name') == asset_name()), None)
        if asset and _ver(tag) > _ver(RELEASE_TAG_PREFIX + APP_VERSION) and (not best or _ver(tag) > _ver(best['tag'])):
            best = {'tag': tag, 'version': tag[len(RELEASE_TAG_PREFIX):], 'url': asset['browser_download_url'],
                    'size': asset.get('size'), 'notes': (rel.get('body') or '')[:500]}
    return best


def mac_swap_script(pid, bundle, new_app, relaunch='open'):
    """After `pid` exits: move the new .app into place; if that fails, put the old one back.
    Either way start the app again so the shop is never left without a POS."""
    installed = shlex.quote(str(bundle))
    recovery = shlex.quote(str(bundle) + '.old')
    incoming = shlex.quote(str(new_app))
    # Do not touch the installed app unless moving it aside succeeded. A failed
    # first move used to enter rollback and delete the only working application.
    # An existing recovery copy may be needed after an interrupted earlier swap.
    return (f'while kill -0 {int(pid)} 2>/dev/null; do sleep 0.3; done; '
            f'if [ ! -e {recovery} ] && [ ! -L {recovery} ] && mv {installed} {recovery}; then '
            f'if mv {incoming} {installed}; then rm -rf {recovery}; '
            f'else rm -rf {installed}; mv {recovery} {installed}; fi; fi; '
            f'sleep 1; {relaunch} {installed}')


def update_outcome(data_dir):
    """After a restart: '' when no update was pending, else a message saying whether it worked."""
    cfg = load_config(data_dir)
    pending = cfg.pop('pending_update', None)
    if not pending:
        return ''
    save_config(data_dir, cfg)
    if pending == APP_VERSION:
        return f'อัปเดตเป็นเวอร์ชัน {APP_VERSION} เรียบร้อย'
    return f'อัปเดตเป็นเวอร์ชัน {pending} ไม่สำเร็จ — ยังใช้ {APP_VERSION} อยู่ ลองอัปเดตใหม่อีกครั้ง'


def install_update(info, core=None, data_dir=None):
    """Download, unpack and verify the new app, back up the data, then swap the app in after
    this process exits and start it again. Shop data lives outside the app and is untouched."""
    if not getattr(sys, 'frozen', False):
        raise RuntimeError('อัปเดตอัตโนมัติใช้ได้กับแอปที่ติดตั้งแล้วเท่านั้น')
    bundle = app_bundle()
    if sys.platform == 'darwin' and bundle is not None:
        # We are running from the installed app, so a leftover recovery copy is stale. Left in
        # place, the swap script would skip the update silently.
        shutil.rmtree(str(bundle) + '.old', ignore_errors=True)
    if data_dir is not None:
        cfg = load_config(data_dir)
        cfg['pending_update'] = info['version']
        save_config(data_dir, cfg)
    work = Path(tempfile.mkdtemp(prefix='zaabos-update-'))
    zip_path = work / asset_name()
    req = urllib.request.Request(info['url'], headers={'User-Agent': 'ZaabOS'})
    with urllib.request.urlopen(req, timeout=120) as r, open(zip_path, 'wb') as f:
        shutil.copyfileobj(r, f)
    if info.get('size') and zip_path.stat().st_size != info['size']:
        raise RuntimeError('ดาวน์โหลดไม่ครบ')
    if core is not None:
        core.backup_db('before-update')
    pid = os.getpid()
    if sys.platform == 'darwin':
        subprocess.run(['ditto', '-x', '-k', str(zip_path), str(work / 'new')], check=True)
        new_app = work / 'new' / 'ZaabOS.app'
        if not (new_app / 'Contents' / 'MacOS' / 'ZaabOS').exists():
            raise RuntimeError('ไฟล์อัปเดตไม่สมบูรณ์')
        bundle = app_bundle()
        subprocess.Popen(['/bin/sh', '-c', mac_swap_script(pid, bundle, new_app)], start_new_session=True)
    elif sys.platform.startswith('win'):
        import zipfile
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(work / 'new')
        new_dir = work / 'new' / 'ZaabOS'
        if not (new_dir / 'ZaabOS.exe').exists():
            raise RuntimeError('ไฟล์อัปเดตไม่สมบูรณ์')
        cur = app_executable().parent
        ps = (f'Wait-Process -Id {_wait_pids(pid)} -ErrorAction SilentlyContinue; Start-Sleep 1; '
              f'robocopy "{new_dir}" "{cur}" /MIR /NFL /NDL /NJH /NJS | Out-Null; Start-Process "{cur / "ZaabOS.exe"}"')
        subprocess.Popen(['powershell', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], creationflags=0x00000008)
    return True


def check_update_async(callback):
    def run():
        try:
            info = check_update()
        except Exception as exc:
            _log(f'update check failed: {exc}')
            return
        if info:
            callback(info)
    threading.Thread(target=run, daemon=True).start()
