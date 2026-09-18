"""How the accessory is actually held on the hat.

The stage-two plan listed five candidate fixings and said the choice was the
client's. This implements the one that can be made as part of the piece itself
-- a pin and clutch -- because it is the only option that is *geometry* rather
than a bought component, and because it is the one that tests whether the
design can carry a fixing at all.

Where the pins go is not a styling decision. A pin needs material around it, so
each one is sited at a local maximum of the distance to the edge of that
piece's flat footprint: put one near a rim and it tears out, put both close
together and the piece pivots around them. The clearance at each site is
measured and reported, so a pin that is too close to an edge is visible as a
number rather than discovered by a maker.

Two pins per piece is the default because one pin is a hinge.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

from design_engine.geometry.mesh import PART_MOUNT, Mesh

MM = 0.1


def _cylinder(radius: float, z_top: float, z_bottom: float, centre: tuple[float, float],
              segments: int = 24, part_id: int = PART_MOUNT) -> Mesh:
    """A closed cylinder, axis along z."""
    th = np.linspace(0.0, 2.0 * np.pi, segments, endpoint=False)
    cx, cy = centre
    ring_t = np.stack([cx + radius * np.cos(th), cy + radius * np.sin(th),
                       np.full(segments, z_top)], axis=1)
    ring_b = np.stack([cx + radius * np.cos(th), cy + radius * np.sin(th),
                       np.full(segments, z_bottom)], axis=1)
    cap_t = np.array([[cx, cy, z_top]])
    cap_b = np.array([[cx, cy, z_bottom]])
    verts = np.concatenate([ring_t, ring_b, cap_t, cap_b])
    it, ib = 0, segments
    ct, cb = 2 * segments, 2 * segments + 1

    faces = []
    for j in range(segments):
        jn = (j + 1) % segments
        faces.append([ct, it + j, it + jn])                 # top cap
        faces.append([cb, ib + jn, ib + j])                 # bottom cap
        faces.append([it + j, ib + j, ib + jn])              # wall
        faces.append([it + j, ib + jn, it + jn])
    m = Mesh(verts.astype(np.float32), np.array(faces, dtype=np.int32),
             np.full(len(faces), part_id, dtype=np.int32), name="pin")
    return m.welded(1e-6).oriented()


def footprint_sites(piece: Mesh, count: int, pin_radius: float,
                    wall_mm: float = 1.2, band_mm: float = 0.35,
                    cell_mm: float = 0.6) -> list[dict]:
    """Choose pin positions inside a piece's flat underside.

    The footprint is rasterised and distance-transformed, so each site is as
    far from an edge as the shape allows. Sites are then taken greedily,
    strongest first, each required to stand clear of the ones already chosen --
    otherwise both pins cluster at the single thickest point and the piece
    rotates about them.
    """
    v = piece.verts.astype(np.float64)
    in_band = v[:, 2] <= band_mm * MM
    under = v[in_band]
    if len(under) < 8:
        return []

    cell = cell_mm * MM
    lo = under[:, :2].min(axis=0) - cell * 2
    hi = under[:, :2].max(axis=0) + cell * 2
    nx = max(8, int(np.ceil((hi[0] - lo[0]) / cell)))
    ny = max(8, int(np.ceil((hi[1] - lo[1]) / cell)))
    grid = np.zeros((nx, ny), dtype=bool)

    # Rasterise the underside TRIANGLES, not their vertices. Marking vertices
    # only works while the mesh happens to be finely tessellated; on a coarse
    # piece it leaves a dotted outline with holes between the samples, and the
    # distance transform then reports its maxima on the rim -- which is exactly
    # where a pin must not go.
    faces = piece.faces[in_band[piece.faces].all(axis=1)]
    for tri in v[faces][:, :, :2]:
        t0 = ((tri - lo) / cell)
        x0, y0 = np.floor(t0.min(axis=0)).astype(int)
        x1, y1 = np.ceil(t0.max(axis=0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1 + 1, nx), min(y1 + 1, ny)
        if x1 <= x0 or y1 <= y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1), np.arange(y0, y1), indexing="ij")
        px = lo[0] + (gx + 0.5) * cell
        py = lo[1] + (gy + 0.5) * cell
        (ax, ay), (bx, by), (cx_, cy_) = tri
        det = (by - cy_) * (ax - cx_) + (cx_ - bx) * (ay - cy_)
        if abs(det) < 1e-18:
            continue
        w0 = ((by - cy_) * (px - cx_) + (cx_ - bx) * (py - cy_)) / det
        w1 = ((cy_ - ay) * (px - cx_) + (ax - cx_) * (py - cy_)) / det
        inside = (w0 >= -1e-9) & (w1 >= -1e-9) & (w0 + w1 <= 1 + 1e-9)
        if inside.any():
            grid[gx[inside], gy[inside]] = True
    # A thin triangle can still slip between cell centres; close and fill so
    # the transform sees one solid region.
    grid = ndimage.binary_closing(grid, structure=np.ones((3, 3)))
    grid = ndimage.binary_fill_holes(grid)
    if not grid.any():
        return []

    dist = ndimage.distance_transform_edt(grid) * cell
    need = pin_radius + wall_mm * MM
    sites: list[dict] = []
    work = dist.copy()
    # Spacing has to scale with the piece, not with the pin. A fixed 6 mm
    # minimum put both pins of a 90 mm flower 6.5 mm apart -- clear of each
    # other, and still a hinge. A third of the footprint's longer side gives a
    # pair far enough apart to actually hold the piece against rotation.
    extent = float(max(hi[0] - lo[0], hi[1] - lo[1]))
    spacing = max(pin_radius * 4.0, extent * 0.34)

    for _ in range(max(1, count)):
        flat = int(np.argmax(work))
        gx, gy = np.unravel_index(flat, work.shape)
        clearance = float(dist[gx, gy])
        if clearance <= 0:
            break
        x = lo[0] + (gx + 0.5) * cell
        y = lo[1] + (gy + 0.5) * cell
        sites.append({
            "x_mm": round(float(x) / MM, 3),
            "y_mm": round(float(y) / MM, 3),
            "clearance_mm": round(clearance / MM, 3),
            "ok": bool(clearance >= need),
        })
        gxs, gys = np.ogrid[:work.shape[0], :work.shape[1]]
        mask = ((gxs - gx) * cell) ** 2 + ((gys - gy) * cell) ** 2 < spacing ** 2
        work[mask] = 0.0
    return sites


def build_pins(piece: Mesh, placement_cfg, name: str = "pins"
               ) -> tuple[Mesh | None, dict]:
    """Generate the pins for one piece, and report where they ended up."""
    radius = placement_cfg.pin_diameter_mm * MM * 0.5
    length = placement_cfg.pin_length_mm * MM
    sites = footprint_sites(piece, placement_cfg.pin_count, radius)

    report = {
        "requested": int(placement_cfg.pin_count),
        "placed": len(sites),
        "diameter_mm": placement_cfg.pin_diameter_mm,
        "length_mm": placement_cfg.pin_length_mm,
        "sites": sites,
        "min_clearance_mm": round(min((s["clearance_mm"] for s in sites), default=0.0), 3),
        "all_sites_have_material": all(s["ok"] for s in sites) if sites else False,
    }
    if not sites:
        return None, report

    # The head is sunk a little into the base disc so the union fuses it to the
    # piece rather than leaving it balanced on the surface.
    parts = [_cylinder(radius, z_top=1.2 * MM, z_bottom=-length,
                       centre=(s["x_mm"] * MM, s["y_mm"] * MM))
             for s in sites]
    return Mesh.concat(parts, name=name), report


def check_pins_clear_the_hat(report: dict, hat_cfg, placement_cfg) -> dict:
    """A pin has to reach through the hat to take a clutch on the far side."""
    through = placement_cfg.pin_length_mm - (
        hat_cfg.thickness_mm + placement_cfg.surface_offset_mm)
    report = dict(report)
    report["hat_thickness_mm"] = hat_cfg.thickness_mm
    report["standoff_mm"] = placement_cfg.surface_offset_mm
    report["protrusion_mm"] = round(through, 3)
    # A clutch needs a few millimetres of shank to grip.
    report["takes_a_clutch"] = bool(through >= 2.5)
    return report
