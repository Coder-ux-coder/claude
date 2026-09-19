"""Stage two contact sheet: the same accessory on two hats that answer the
fit problem differently."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
GROUND, PANEL, LINE = (20, 17, 12), (27, 23, 15), (49, 41, 24)
INK, MUTED, FAINT = (244, 237, 223), (156, 143, 121), (107, 97, 82)
MARIGOLD, PASS, WARN = (242, 160, 7), (114, 169, 107), (217, 144, 58)
F = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FM = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

SHOTS = [("01_worn_angle", "Worn angle"), ("02_three_quarter", "Three quarter"),
         ("03_top", "Top"), ("04_side", "Side"),
         ("05_accessory_detail", "Accessory detail"),
         ("06_pieces_lifted", "Two pieces lifted")]
COLS = [("wide_brim", "Wide brim, 110 mm  /  90 mm accessory"),
        ("fedora", "Fedora, 68 mm  /  58 mm accessory")]


def main():
    d = json.loads((ROOT / "deliverables" / "stage_two_assembly.json").read_text())
    CELL, PAD, HEAD, LAB = 600, 26, 430, 34
    W = PAD * 3 + CELL * 2
    H = HEAD + len(SHOTS) * (CELL + LAB) + PAD
    img = Image.new("RGB", (W, H), GROUND)
    dr = ImageDraw.Draw(img)
    f_title, f_sub = ImageFont.truetype(FB, 34), ImageFont.truetype(F, 15)
    f_lab, f_num, f_small = (ImageFont.truetype(FM, 13), ImageFont.truetype(FM, 14),
                             ImageFont.truetype(F, 13))
    f_col = ImageFont.truetype(FB, 16)

    dr.text((PAD, 26), "AFRi marigold — Stage two, on the hat", font=f_title, fill=INK)
    dr.text((PAD, 70),
            "The 90 mm accessory has no collision-free placement on a standard fedora brim. "
            "Two answers, both built.", font=f_sub, fill=MUTED)

    def summ(k):
        return d[k]["validation"].get("assembly", {}).get("summary", {}) or {}

    rows = [
        ("Hat overall", "401 mm across", "319 mm across"),
        ("Accessory", "90 mm nominal, 96.6 mm across", "58 mm nominal, 62.4 mm across"),
        ("Radial room on the brim", "108.7 mm", "67.2 mm"),
        ("Seated at", "r = 142 mm", "r = 130 mm"),
        ("Standoff", "2.0 mm", "2.0 mm"),
        ("Interference", "0.00 mm", "0.24 mm"),
        ("Gap across the footprint", "up to 3.30 mm", "up to 2.52 mm"),
        ("Mass (cast resin)", "53 g", "22 g"),
        ("Moment about the crown foot", "2,597 g·mm", "801 g·mm"),
        ("Checks", f"{d['wide_brim']['validation']['passed']}/"
                   f"{d['wide_brim']['validation']['total']}",
         f"{d['fedora']['validation']['passed']}/{d['fedora']['validation']['total']}"),
    ]
    y = 112
    cx = [PAD, PAD + 330, PAD + 620]
    dr.line([(PAD, y - 8), (W - PAD, y - 8)], fill=LINE)
    dr.text((cx[0], y), "MEASURED", font=f_lab, fill=FAINT)
    dr.text((cx[1], y), "WIDE BRIM", font=f_lab, fill=MARIGOLD)
    dr.text((cx[2], y), "FEDORA", font=f_lab, fill=MARIGOLD)
    y += 22
    for lab, a, b in rows:
        dr.text((cx[0], y), lab, font=f_small, fill=MUTED)
        dr.text((cx[1], y), a, font=f_num, fill=PASS if lab == "Interference" else INK)
        dr.text((cx[2], y), b, font=f_num, fill=WARN if lab == "Interference" else INK)
        y += 21

    notes = ["RIGID MOUNT, NOT CONFORMING",
             "A flat back on a curved brim leaves",
             "2.91 mm of conformance error across",
             "the footprint, measured from closest",
             "approach so it is independent of",
             "standoff. A pin through felt absorbs",
             "that much without complaint.",
             "",
             "Conforming would close it, but needs",
             "the split path lifted onto a curved",
             "base. That path is a function of y in",
             "a plane, which is exactly what makes",
             "it divide the flower in two.",
             "",
             "NOT BUILT: attachment geometry,",
             "surface conforming, any review by",
             "an actual maker."]
    ny = 112
    for i, n in enumerate(notes):
        dr.text((PAD + 950, ny), n, font=f_lab if i == 0 or n.isupper() else f_small,
                fill=FAINT if (i == 0 or (n and n.isupper())) else MUTED)
        ny += 19

    y = HEAD
    for key, label in SHOTS:
        dr.text((PAD, y - 22), label.upper(), font=f_lab, fill=FAINT)
        for i, (col, title) in enumerate(COLS):
            x = PAD + i * (CELL + PAD)
            dr.rectangle((x, y, x + CELL, y + CELL), fill=PANEL, outline=LINE)
            path = d[col]["assets"].get(key)
            if path and (ROOT / path).exists():
                im = Image.open(ROOT / path).convert("RGB")
                im.thumbnail((CELL - 2, CELL - 2), Image.LANCZOS)
                img.paste(im, (x + (CELL - im.width) // 2, y + (CELL - im.height) // 2))
            if y == HEAD:
                dr.text((x, HEAD - 56), title, font=f_col, fill=INK)
        y += CELL + LAB

    out = ROOT / "deliverables" / "stage_two_on_the_hat.png"
    img.save(out, quality=94)
    print(f"wrote {out} ({out.stat().st_size // 1024} KiB, {W}x{H})")


if __name__ == "__main__":
    main()
