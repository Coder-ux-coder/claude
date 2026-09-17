"""Build the Concept C v1 / v2 comparison sheet.

Both versions are photographed under identical light, from identical cameras,
at identical resolution. That is the only way the comparison says anything: a
difference you can see is then a difference in the design, not in the setup.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
GROUND = (20, 17, 12)
PANEL = (27, 23, 15)
LINE = (49, 41, 24)
INK = (244, 237, 223)
MUTED = (156, 143, 121)
MARIGOLD = (242, 160, 7)
PASS = (114, 169, 107)
FAIL = (207, 102, 80)

F = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FM = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

SHOTS = [("01_assembled_three_quarter", "Assembled, three quarter"),
         ("02_exploded", "Exploded"),
         ("03_top", "Top"),
         ("04_side", "Side"),
         ("05_three_quarter_hero", "Three quarter, hero")]


def font(path, size):
    return ImageFont.truetype(path, size)


def main():
    report = json.loads((ROOT / "deliverables" / "concept_c_refinement.json").read_text())
    v1, v2 = report["v1"], report["v2"]

    CELL = 620
    PAD = 26
    HEAD = 300
    ROW_LABEL = 34
    W = PAD * 3 + CELL * 2
    H = HEAD + len(SHOTS) * (CELL + ROW_LABEL) + PAD

    img = Image.new("RGB", (W, H), GROUND)
    d = ImageDraw.Draw(img)

    f_title = font(FB, 34)
    f_sub = font(F, 15)
    f_col = font(FB, 19)
    f_lab = font(FM, 13)
    f_num = font(FM, 14)
    f_small = font(F, 13)

    d.text((PAD, 26), "AFRi marigold — Concept C refinement", font=f_title, fill=INK)
    d.text((PAD, 70), "Organic asymmetric division. Both versions rendered from the same "
                      "cameras, lighting and resolution.", font=f_sub, fill=MUTED)

    # ---- the measured difference ----------------------------------------
    def stat(a, b, key, label, fmt="{:.0f}", better=None):
        va, vb = a["stats"].get(key), b["stats"].get(key)
        return (label, fmt.format(va) if va is not None else "-",
                fmt.format(vb) if vb is not None else "-", better)

    ca = v1["validation"].get("coherence", {})
    cb = v2["validation"].get("coherence", {})
    rows = [
        stat(v1, v2, "petal_count", "Ray florets", "{:.0f}"),
        stat(v1, v2, "layer_count", "Rows", "{:.0f}"),
        ("Height : diameter",
         f"{v1['stats']['height_mm'] / v1['stats']['diameter_mm']:.3f}",
         f"{v2['stats']['height_mm'] / v2['stats']['diameter_mm']:.3f}", None),
        ("Bodies per half",
         f"{ca.get('piece_a', {}).get('bodies', '-')} / {ca.get('piece_b', {}).get('bodies', '-')}",
         f"{cb.get('piece_a', {}).get('bodies', '-')} / {cb.get('piece_b', {}).get('bodies', '-')}",
         "b"),
        ("One coherent solid per half",
         "no" if not ca.get("piece_a", {}).get("coherent") else "yes",
         "yes" if cb.get("piece_a", {}).get("coherent") else "no", "b"),
        ("Checks passed",
         f"{v1['validation']['passed']}/{v1['validation']['total']}",
         f"{v2['validation']['passed']}/{v2['validation']['total']}", None),
    ]

    y = 112
    col_x = [PAD, PAD + 300, PAD + 470]
    d.line([(PAD, y - 8), (W - PAD, y - 8)], fill=LINE, width=1)
    d.text((col_x[0], y), "MEASURED", font=f_lab, fill=(107, 97, 82))
    d.text((col_x[1], y), "v1", font=f_lab, fill=(107, 97, 82))
    d.text((col_x[2], y), "v2", font=f_lab, fill=MARIGOLD)
    y += 24
    for label, a, b, better in rows:
        d.text((col_x[0], y), label, font=f_small, fill=MUTED)
        d.text((col_x[1], y), str(a), font=f_num, fill=INK)
        colour = PASS if better == "b" else INK
        d.text((col_x[2], y), str(b), font=f_num, fill=colour)
        y += 23

    d.text((PAD + 700, 112), "WHAT CHANGED", font=f_lab, fill=(107, 97, 82))
    notes = [
        "Petals shorter (0.46 → 0.33 of radius) and broader,",
        "denser (7 → 9 rows, 157 → 315 florets), edge",
        "crenulation deeper and finer.",
        "",
        "Rows lifted into a pompon rather than a flat rosette.",
        "",
        "Organic curve recomposed: one dominant sweep and a",
        "counter-curve, wander subordinate and enveloped to",
        "nothing at the rim.",
        "",
        "Petals, base and centre boolean-unioned, so each half",
        "is one solid instead of ~90 overlapping shells.",
        "",
        "Cut-wall winding fixed: 19 inside-out bodies → 0.",
    ]
    ny = 136
    for n in notes:
        d.text((PAD + 700, ny), n, font=f_small, fill=MUTED if n else MUTED)
        ny += 19

    # ---- the shots -------------------------------------------------------
    y = HEAD
    for key, label in SHOTS:
        d.text((PAD, y - 22), label.upper(), font=f_lab, fill=(107, 97, 82))
        for i, (ver, data) in enumerate((("v1", v1), ("v2", v2))):
            x = PAD + i * (CELL + PAD)
            path = data["assets"].get(key)
            box = (x, y, x + CELL, y + CELL)
            d.rectangle(box, fill=PANEL, outline=LINE)
            if path and Path(ROOT / path).exists():
                im = Image.open(ROOT / path).convert("RGB")
                im.thumbnail((CELL - 2, CELL - 2), Image.LANCZOS)
                img.paste(im, (x + (CELL - im.width) // 2, y + (CELL - im.height) // 2))
            tag = f"{ver}"
            tw = d.textlength(tag, font=f_lab)
            d.rectangle((x + 8, y + 8, x + 18 + tw, y + 30), fill=(20, 17, 12))
            d.text((x + 13, y + 12), tag, font=f_lab,
                   fill=MARIGOLD if ver == "v2" else MUTED)
        y += CELL + ROW_LABEL

    out = ROOT / "deliverables" / "concept_c_v1_vs_v2.png"
    img.save(out, quality=94)
    print(f"wrote {out} ({out.stat().st_size // 1024} KiB, {W}x{H})")


if __name__ == "__main__":
    main()
