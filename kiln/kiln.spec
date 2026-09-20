# PyInstaller recipe. One file, no Python needed on the machine it runs on.
#
#   pip install pyinstaller && pyinstaller kiln.spec
#
# build.py ships as data, not as code: Blender runs it, this program never
# imports it.

block_cipher = None

a = Analysis(
    ["app.py"],
    pathex=["."],
    binaries=[],
    datas=[("web", "web"), ("build.py", ".")],
    hiddenimports=["anthropic"],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "numpy", "PIL", "pytest"],
    cipher=block_cipher,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    name="kiln",
    console=True,            # shows the address, and closing it quits
    debug=False,
    strip=False,
    upx=False,
    bootloader_ignore_signals=False,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
