"""Where Shape keeps things on your machine.

Nothing leaves it. The key sits in a file only your account can read, the
objects you make sit beside it, and both live in the usual place for your
operating system so a backup or an uninstall finds them.
"""

import glob
import json
import os
import platform
import shutil
import stat
from pathlib import Path

APP = "Shape"


def _base(kind: str) -> Path:
    system = platform.system()
    if system == "Windows":
        root = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        return root / APP
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / APP
    var = "XDG_CONFIG_HOME" if kind == "config" else "XDG_DATA_HOME"
    default = ".config" if kind == "config" else ".local/share"
    return Path(os.environ.get(var, Path.home() / default)) / "shape"


CONFIG_DIR = _base("config")
DATA_DIR = _base("data")
KEY_FILE = CONFIG_DIR / "key"
SETTINGS_FILE = CONFIG_DIR / "settings.json"
JOBS_DIR = DATA_DIR / "objects"

MODELS = [
    ("claude-opus-5", "Best", 5.00, 25.00),
    ("claude-sonnet-5", "Balanced", 2.00, 10.00),
    ("claude-haiku-4-5", "Cheapest", 1.00, 5.00),
]
DEFAULT_MODEL = MODELS[0][0]


def ensure_dirs():
    for d in (CONFIG_DIR, JOBS_DIR):
        d.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------- the key

def get_key() -> str:
    """The key from the environment if one is set there, else the saved one."""
    from_env = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if from_env:
        return from_env
    try:
        return KEY_FILE.read_text().strip()
    except OSError:
        return ""


def set_key(key: str):
    ensure_dirs()
    KEY_FILE.write_text(key.strip())
    # Readable and writable by this account only. On Windows this is a no-op,
    # which the setup screen says out loud.
    try:
        KEY_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def clear_key():
    try:
        KEY_FILE.unlink()
    except OSError:
        pass


def key_hint() -> str:
    """Enough of the key to recognise it, never enough to use it."""
    key = get_key()
    return f"…{key[-4:]}" if len(key) > 8 else ""


# ------------------------------------------------------------- everything else

def load() -> dict:
    try:
        data = json.loads(SETTINGS_FILE.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(**fields):
    ensure_dirs()
    data = load()
    data.update({k: v for k, v in fields.items() if v is not None})
    SETTINGS_FILE.write_text(json.dumps(data, indent=2))
    return data


def model() -> str:
    chosen = load().get("model", DEFAULT_MODEL)
    return chosen if any(chosen == m[0] for m in MODELS) else DEFAULT_MODEL


def price_of(model_id: str) -> tuple[float, float]:
    for mid, _, inp, out in MODELS:
        if mid == model_id:
            return inp, out
    return MODELS[0][2], MODELS[0][3]


# ------------------------------------------------------------------ Blender

MAC = ["/Applications/Blender.app/Contents/MacOS/Blender",
       str(Path.home() / "Applications/Blender.app/Contents/MacOS/Blender")]
WINDOWS = [r"C:\Program Files\Blender Foundation\Blender*\blender.exe",
           r"C:\Program Files (x86)\Blender Foundation\Blender*\blender.exe"]
LINUX = ["/usr/local/bin/blender", "/usr/bin/blender", "/snap/bin/blender",
         "/var/lib/flatpak/exports/bin/org.blender.Blender"]


def find_blender() -> str:
    """Where Blender is, or an empty string. Saved choice first, then the
    usual places for this operating system."""
    saved = load().get("blender", "")
    if saved and Path(saved).exists():
        return saved

    on_path = shutil.which("blender")
    if on_path:
        return on_path

    system = platform.system()
    candidates = MAC if system == "Darwin" else WINDOWS if system == "Windows" else LINUX
    for pattern in candidates:
        for hit in sorted(glob.glob(pattern), reverse=True):
            if Path(hit).exists():
                return hit
    return ""


def blender_download_url() -> str:
    return "https://www.blender.org/download/"


# ------------------------------------------------------------------ history

def history(limit: int = 24) -> list[dict]:
    """What has been made, newest first."""
    out = []
    if not JOBS_DIR.exists():
        return out
    folders = sorted(JOBS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    for folder in folders:
        card = folder / "card.json"
        if not card.exists() or not (folder / "view.png").exists():
            continue
        try:
            entry = json.loads(card.read_text())
        except (OSError, ValueError):
            continue
        entry["id"] = folder.name
        out.append(entry)
        if len(out) >= limit:
            break
    return out


def forget(job_id: str):
    target = JOBS_DIR / job_id
    if target.parent == JOBS_DIR and target.is_dir():
        shutil.rmtree(target, ignore_errors=True)
