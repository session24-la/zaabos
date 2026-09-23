# PyInstaller build for ZaabOS Local (the shop-PC POS).
#   pyinstaller zaabos_local.spec      -> dist/ZaabOS/ (Windows: ZaabOS.exe) or dist/ZaabOS.app (macOS)
import sys
sys.path.insert(0, '.')
from local_ops import APP_VERSION
from PyInstaller.utils.hooks import collect_data_files
datas = [('templates', 'templates'), ('static', 'static'), ('schema.sql', '.'), ('schema_postgres.sql', '.')]
datas += collect_data_files('tzdata')   # Windows has no system timezone database
hidden = ['local_ops', 'local_api', 'wsgi', 'customer_history', 'table_open_bill', 'waitress', 'tzdata', 'printing', 'PIL.ImageDraw', 'PIL.ImageFont'] + (['rumps'] if sys.platform == 'darwin' else [])
icon = 'static/zaabos-icon-512.png'

a = Analysis(['zaabos_local.py'], pathex=['.'], datas=datas, hiddenimports=hidden,
             excludes=['psycopg2', 'gunicorn', 'tkinter'])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='ZaabOS', icon=icon,
          console=True)   # the window tells staff "keep open while selling"; closing it stops the POS
coll = COLLECT(exe, a.binaries, a.datas, name='ZaabOS')
if sys.platform == 'darwin':
    app = BUNDLE(coll, name='ZaabOS.app', icon=icon, bundle_identifier='com.zaabos.local',
                 info_plist={'CFBundleShortVersionString': APP_VERSION, 'CFBundleVersion': APP_VERSION,
                            'LSUIElement': True})   # menu-bar app: no Dock icon bouncing forever
