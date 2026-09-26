#!/usr/bin/env python3
"""A stand-in for Android's `adb`, for testing Crew's phone control without a phone.

It keeps a tiny "phone" state in CREW_FAKE_STATE (connected?, which screen is showing),
answers the commands Crew uses, and draws the screen as a real PNG picture.
"""

from __future__ import annotations

import json
import os
import struct
import sys
import zlib
from pathlib import Path

STATE = Path(os.environ.get("CREW_FAKE_STATE") or "/tmp/crew-fake-state") / "phone.json"
SERIAL = "R5CT20ABCDE"
W, H = 270, 585  # the picture (a quarter of 1080x2340)
SCREENS = {"home": (24, 64, 120), "app": (236, 240, 243), "whatsapp": (7, 94, 84), "settings": (245, 245, 250)}


def load() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {"connected": os.environ.get("CREW_FAKE_PHONE_CONNECTED") == "1", "screen": "home", "log": []}


def save(st: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    st["log"] = st.get("log", [])[-200:]
    STATE.write_text(json.dumps(st))


def png(screen: str) -> bytes:
    bg = SCREENS.get(screen, SCREENS["app"])
    rows = []
    for y in range(H):
        row = bytearray()
        for x in range(W):
            c = bg
            if y < 18:
                c = tuple(max(0, v - 30) for v in bg)  # status bar
            elif screen == "home":
                gx, gy = (x - 22) % 62, (y - 90) % 78
                if 90 <= y < 90 + 4 * 78 and 22 <= x < 22 + 4 * 62 and gx < 42 and gy < 42:
                    c = [(242, 101, 34), (37, 211, 102), (66, 133, 244), (251, 188, 5)][((x - 22) // 62 + (y - 90) // 78) % 4]
                elif y > H - 70 and 30 < x < W - 30 and (x - 30) % 54 < 42 and H - 60 < y < H - 18:
                    c = (230, 230, 235)  # dock
            else:
                if 18 <= y < 62:
                    c = tuple(max(0, v - 60) for v in bg)  # app header
                elif 80 <= y < H - 40 and 16 <= x < W - 16 and (y - 80) % 56 < 44:
                    c = (255, 255, 255) if screen != "whatsapp" else (220, 248, 198)
            row += bytes(c)
        rows.append(b"\x00" + bytes(row))
    raw = zlib.compress(b"".join(rows), 6)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


UI_XML = """<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" clickable="false" bounds="[0,0][1080,2340]">
<node index="1" text="WhatsApp" resource-id="com.sec.android.app.launcher:id/icon" class="android.widget.TextView" content-desc="WhatsApp" clickable="true" bounds="[88,360][256,560]" />
<node index="2" text="Chrome" resource-id="com.sec.android.app.launcher:id/icon" class="android.widget.TextView" content-desc="Chrome" clickable="true" bounds="[336,360][504,560]" />
<node index="3" text="Settings" resource-id="com.sec.android.app.launcher:id/icon" class="android.widget.TextView" content-desc="Settings" clickable="true" bounds="[584,360][752,560]" />
</node></hierarchy>"""


def main(argv: list[str]) -> int:
    st = load()
    if argv[:1] == ["-s"]:
        argv = argv[2:]
        if not st["connected"]:
            sys.stderr.write(f"adb: device '{SERIAL}' not found\n")
            return 1
    if not argv:
        return 1
    cmd = argv[0]
    out = sys.stdout
    if cmd == "devices":
        out.write("List of devices attached\n")
        if st["connected"]:
            out.write(f"{SERIAL}               device product:e3qxxx model:SM_S928B device:e3q transport_id:1\n")
        return 0
    if cmd == "pair":
        out.write(f"Successfully paired to {argv[1]} [guid=adb-{SERIAL}-abc]\n")
        return 0
    if cmd == "connect":
        st["connected"] = True
        save(st)
        out.write(f"connected to {argv[1]}\n")
        return 0
    if cmd == "reverse":
        return 0
    if cmd == "exec-out" and argv[1:3] == ["screencap", "-p"]:
        sys.stdout.buffer.write(png(st.get("screen", "home")))
        return 0
    if cmd == "shell":
        words = " ".join(argv[1:]).split()
        st["log"].append(" ".join(words))
        if words[:2] == ["wm", "size"]:
            out.write("Physical size: 1080x2340\n")
        elif words[:2] == ["input", "keyevent"]:
            if words[2] == "3":
                st["screen"] = "home"
            elif words[2] == "4":
                st["screen"] = "home" if st.get("screen") != "home" else "home"
        elif words[:2] == ["input", "tap"]:
            if st.get("screen") == "home":
                st["screen"] = "app"
        elif words[:1] == ["monkey"]:
            pkg = words[words.index("-p") + 1]
            st["screen"] = "whatsapp" if "whatsapp" in pkg else "settings" if "settings" in pkg else "app"
            out.write("Events injected: 1\n")
        elif words[:1] == ["uiautomator"]:
            out.write("UI hierchary dumped to: /sdcard/crew-ui.xml\n")
        elif words[:1] == ["cat"]:
            out.write(UI_XML)
        elif words[:3] == ["pm", "list", "packages"]:
            out.write("package:com.whatsapp\npackage:com.google.android.youtube\npackage:com.example.notes\n")
        save(st)
        return 0
    sys.stderr.write(f"fake adb: unknown command {argv}\n")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
