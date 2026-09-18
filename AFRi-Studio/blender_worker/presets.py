"""Material, lighting, camera and render presets.

Imported inside Blender's own Python, so this module must not depend on
anything outside Blender's bundled environment (bpy, numpy, stdlib).
"""
from __future__ import annotations

import math


def hex_to_rgb(h: str, gamma: float = 2.2):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    # Blender wants linear values; the UI shows sRGB.
    return tuple(c ** gamma for c in (r, g, b)) + (1.0,)


MATERIALS = {
    "matte_felt":     dict(roughness=0.92, metallic=0.0, sheen=0.55, spec=0.18, clearcoat=0.0),
    "satin_silk":     dict(roughness=0.34, metallic=0.0, sheen=0.70, spec=0.55, clearcoat=0.10),
    "brushed_metal":  dict(roughness=0.38, metallic=1.0, sheen=0.0,  spec=0.60, clearcoat=0.0),
    "enamel":         dict(roughness=0.14, metallic=0.0, sheen=0.0,  spec=0.85, clearcoat=0.60),
    "velvet":         dict(roughness=0.98, metallic=0.0, sheen=1.0,  spec=0.10, clearcoat=0.0),
}

RENDER_PRESETS = {
    "preview":  dict(samples=24,  resolution=640,  denoise=True,  max_bounces=4),
    "standard": dict(samples=96,  resolution=1200, denoise=True,  max_bounces=8),
    "high":     dict(samples=320, resolution=1800, denoise=True,  max_bounces=12),
}

# (azimuth_deg, elevation_deg, framing_margin, focal_mm)
# The margin is how much bigger than the subject the frame should be; the actual
# camera distance is derived from the focal length below, not guessed.
# Margins leave real breathing room around the subject. Framing the bounding
# sphere exactly puts the outermost petals on the frame edge, which reads as a
# crop rather than a composition.
CAMERAS = {
    "top":           (0.0,   89.0, 1.22, 85.0),
    "front":         (0.0,    6.0, 1.30, 85.0),
    "side":          (90.0,   8.0, 1.30, 85.0),
    "three_quarter": (38.0,  30.0, 1.32, 85.0),
    # High angle, tighter framing: the dividing line runs across the flower in
    # plan, so a low three-quarter view cannot show it.
    "closeup":       (22.0,  62.0, 0.84, 100.0),
    "hero":          (-32.0, 24.0, 1.24, 100.0),
    # Stage two. A hat is three times the flower's size and is read from nearer
    # eye level, so these sit lower and frame tighter than the flower cameras.
    "hat_three_quarter": (38.0,  24.0, 1.14, 85.0),
    "hat_front":         (0.0,    9.0, 1.20, 85.0),
    "hat_side":          (90.0,   7.0, 1.20, 85.0),
    "hat_top":           (0.0,   78.0, 1.08, 85.0),
    "hat_worn":          (26.0,   5.0, 1.16, 100.0),
    # Used with an explicit target on the flower and a matching frame radius,
    # so it reads as a detail of the accessory rather than of the hat.
    "hat_detail":        (24.0,  30.0, 1.05, 100.0),
    # From below, for the fixing: the pins point down into the brim, so no
    # camera above the hat can show them.
    "hat_underside":     (24.0, -38.0, 1.15, 100.0),
}

SENSOR_MM = 36.0

LIGHTING = {
    # (key_energy, fill_energy, rim_energy, key_size, world_strength)
    "studio_soft":  (2600.0, 900.0, 1400.0, 9.0, 0.28),
    "dramatic":     (4200.0, 260.0, 2400.0, 5.0, 0.10),
    "flat_catalog": (1700.0, 1500.0, 900.0, 14.0, 0.55),
}


def camera_transform(preset: str, radius: float, target=(0.0, 0.0, 0.0)):
    """World position and rotation framing a sphere of the given radius.

    Distance is derived from the focal length and sensor size rather than being
    a hand-tuned multiplier, so changing the lens reframes correctly instead of
    cropping the subject.
    """
    az, el, margin, focal = CAMERAS.get(preset, CAMERAS["three_quarter"])
    a, e = math.radians(az), math.radians(el)
    half_angle = math.atan((SENSOR_MM * 0.5) / focal)
    d = (radius * margin) / math.tan(half_angle)
    x = d * math.cos(e) * math.sin(a)
    y = -d * math.cos(e) * math.cos(a)
    z = d * math.sin(e)
    rot_x = math.radians(90.0) - e
    rot_z = a
    # Translating both the orbit centre and the eye leaves the viewing
    # direction unchanged, so a detail shot can frame a flower sitting out on a
    # brim with no look-at maths.
    return (target[0] + x, target[1] + y, target[2] + z), (rot_x, 0.0, rot_z), focal


# Hat materials. Felt is matte and slightly fuzzy, straw coarser and brighter,
# canvas between them. Roughness and sheen only -- no textures, because at this
# scale the silhouette and the band carry the read, not surface detail.
HAT_MATERIALS = {
    "felt":   dict(roughness=0.88, sheen=0.42, metallic=0.0),
    "straw":  dict(roughness=0.74, sheen=0.18, metallic=0.0),
    "wool":   dict(roughness=0.92, sheen=0.55, metallic=0.0),
    "canvas": dict(roughness=0.82, sheen=0.12, metallic=0.0),
}
