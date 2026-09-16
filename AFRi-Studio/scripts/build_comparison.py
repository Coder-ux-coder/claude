"""Build the side-by-side comparison image from real renders."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageDraw, ImageFont

from backend.app.core.config import DELIVERABLES, ROOT
from backend.app.database.db import init_db
from backend.app.versions import store

ORDER = ["Concept A Balanced Split", "Concept B S River Split",
         "Concept C Organic Asymmetric"]
BG = (11, 13, 16)
FG = (184, 195, 206)
ACCENT = (242, 160, 7)


def font(size: int):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def build(rows=("01_complete_flower", "02_separated_components", "03_top_view"),
          cell=520, pad=22, header=76, label=40) -> dict:
    init_db()
    project = store.ensure_default_project()
    entries = []
    for c in store.list_concepts(project["id"]):
        if c["name"] not in ORDER or not c.get("head"):
            continue
        assets = c["head"].get("assets") or {}
        shots = {k: ROOT / v for k, v in assets.items() if (ROOT / v).is_file()}
        if any(r in shots for r in rows):
            entries.append((c["name"], shots))
    entries.sort(key=lambda e: ORDER.index(e[0]))
    if not entries:
        return {"ok": False, "error": "no rendered concepts found"}

    cols = len(entries)
    W = pad + cols * (cell + pad)
    H = header + len(rows) * (cell + label) + pad
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.text((pad, 22), "AFRi Marigold — concept comparison", fill=FG, font=font(30))
    d.text((pad, 56), "One master flower, three ways of dividing it. "
                      "Matched scale, framing and lighting.",
           fill=(124, 138, 153), font=font(15))

    missing = []
    for ci, (name, shots) in enumerate(entries):
        x = pad + ci * (cell + pad)
        d.text((x, header - 4), name, fill=ACCENT, font=font(17))
        for ri, key in enumerate(rows):
            y = header + 24 + ri * (cell + label)
            if key in shots:
                with Image.open(shots[key]) as im:
                    img.paste(im.convert("RGB").resize((cell, cell),
                                                       Image.LANCZOS), (x, y))
            else:
                missing.append(f"{name}:{key}")
                d.rectangle([x, y, x + cell, y + cell], outline=(42, 50, 59))
                d.text((x + 14, y + cell // 2), "(not rendered)",
                       fill=(90, 102, 114), font=font(15))
            d.text((x, y + cell + 8), key.replace("_", " ").lstrip("0123456789 "),
                   fill=(124, 138, 153), font=font(13))

    DELIVERABLES.mkdir(parents=True, exist_ok=True)
    out = DELIVERABLES / "comparison_all_concepts.png"
    img.save(out, optimize=True)
    return {"ok": True, "path": str(out.relative_to(ROOT)),
            "bytes": out.stat().st_size, "size": img.size,
            "concepts": [e[0] for e in entries], "missing": missing}


if __name__ == "__main__":
    r = build()
    print(json.dumps(r, indent=1))
    raise SystemExit(0 if r.get("ok") else 1)
