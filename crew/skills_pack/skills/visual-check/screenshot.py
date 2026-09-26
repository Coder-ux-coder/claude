#!/usr/bin/env python3
"""Screenshot a URL with Playwright (preferred) or headless Chrome/Chromium.

Prints console errors seen while loading. Exit code 0 on success.
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys


def with_playwright(args) -> bool:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False
    errors = []
    with sync_playwright() as p:
        exe = os.environ.get("CREW_CHROMIUM") or next(iter(glob.glob("/opt/pw-browsers/chromium*/chrome-linux/chrome")), None)
        browser = p.chromium.launch(executable_path=exe) if exe and os.path.exists(exe) else p.chromium.launch()
        page = browser.new_page(viewport={"width": args.width, "height": args.height})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(args.url, wait_until="networkidle", timeout=args.timeout * 1000)
        for target in args.click or []:
            page.click(target, timeout=10000)
            page.wait_for_timeout(500)
        if args.wait:
            page.wait_for_timeout(args.wait)
        page.screenshot(path=args.out, full_page=not args.viewport_only)
        browser.close()
    print(f"saved {args.out}")
    for e in errors:
        print(f"console error: {e}")
    return True


CHROME_GLOBS = [
    os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"),
    "/opt/pw-browsers/chromium-*/chrome-linux*/chrome",
    os.path.expanduser("~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]


def find_chrome() -> str | None:
    if os.environ.get("CREW_CHROMIUM") and os.path.exists(os.environ["CREW_CHROMIUM"]):
        return os.environ["CREW_CHROMIUM"]
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "msedge"):
        if shutil.which(name):
            return shutil.which(name)
    for pattern in CHROME_GLOBS:
        found = sorted(glob.glob(pattern))
        if found:
            return found[-1]
    return None


def with_chrome(args) -> bool:
    exe = find_chrome()
    if not exe:
        return False
    subprocess.run([exe, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
                    f"--virtual-time-budget={max(args.wait, 1500)}",
                    f"--window-size={args.width},{args.height}", f"--screenshot={args.out}", args.url],
                   check=True, capture_output=True, timeout=args.timeout)
    print(f"saved {args.out} (headless Chrome: console errors not captured)")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("url")
    ap.add_argument("--out", default="/tmp/screenshot.png")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--click", action="append", help="selector to click before the shot (repeatable)")
    ap.add_argument("--wait", type=int, default=0, help="extra milliseconds to wait before the shot")
    ap.add_argument("--viewport-only", action="store_true")
    ap.add_argument("--timeout", type=int, default=45)
    args = ap.parse_args()
    if with_playwright(args) or with_chrome(args):
        return 0
    print("No browser available: install Playwright (pip install playwright && playwright install chromium) or Chrome.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
