"""Turn the flower from a pile of overlapping solids into one solid.

The master flower is built as 159 separate closed bodies -- a base disc, a
centre boss and one per petal -- that overlap where they meet. That is the
right way to *build* it: each piece is simple, independently verifiable, and
the split kernel can cut one body at a time.

It is the wrong thing to *ship*. A hundred interpenetrating shells in one STL
is a soup, not a part: it has no single interior, its volume double-counts
every overlap, and a maker cannot treat it as one object. Worse, the overlaps
hide whether the petals are actually attached to anything -- geometry that
merely intersects looks identical to geometry that is joined, right up until
someone tries to make it.

So the bodies are unioned into a single manifold before anything else happens
to them. Then the flower is one solid, the split produces two solids, and the
question "is this petal attached?" has an answer.

The boolean is manifold3d (Apache-2.0) through trimesh: exact-predicate,
robust on the coincident surfaces this geometry is full of, and about a second
for the whole flower. Blender's edit-mode self-intersect was tried first and
made the mesh worse -- 88 bodies in, 176 bodies and 14,105 non-manifold edges
out -- so it is not used.
"""
from __future__ import annotations

import time

import numpy as np
import trimesh
from scipy.spatial import cKDTree

from design_engine.geometry.mesh import PART_BOUNDARY, Mesh

MM = 0.1  # 1 scene unit == 10 mm
MM3 = MM ** 3


def to_bodies(m: Mesh) -> list[trimesh.Trimesh]:
    """Split a Mesh into one trimesh per connected component."""
    lab = m.component_labels()
    out = []
    for u in np.unique(lab):
        f = m.faces[lab == u]
        used = np.unique(f)
        remap = np.full(m.n_verts, -1, dtype=np.int64)
        remap[used] = np.arange(len(used))
        out.append(trimesh.Trimesh(vertices=m.verts[used].astype(np.float64),
                                   faces=remap[f], process=False))
    return out


def drop_fragments(tm: trimesh.Trimesh, min_volume: float
                   ) -> tuple[trimesh.Trimesh, list[float]]:
    """Remove bodies below ``min_volume`` (scene units cubed).

    An exact boolean throws off specks where surfaces touch: bodies of four to
    twenty triangles with volumes around 1e-6, which is a millionth of a petal.
    They are numerical debris, they inflate the body count, and nothing can be
    made from them. Genuinely severed petal tips are larger and are kept --
    they are a real consequence of where the curve runs, and hiding them would
    misrepresent the design.
    """
    parts = tm.split(only_watertight=False)
    if len(parts) <= 1:
        return tm, []
    vols = np.array([abs(p.volume) for p in parts])
    keep = vols >= min_volume
    if not keep.any():                      # never return nothing
        keep[int(np.argmax(vols))] = True
    dropped = [float(v) for v, k in zip(vols, keep) if not k]
    kept = [p for p, k in zip(parts, keep) if k]
    out = trimesh.util.concatenate(kept) if len(kept) > 1 else kept[0]
    return out, dropped


def consolidate(m: Mesh, dust_volume_mm3: float = 0.5,
                part_id: int = 0, name: str = "solid") -> tuple[Mesh, dict]:
    """Union every body of ``m`` into one solid and strip the debris.

    Returns the consolidated mesh and a report. The report is the interesting
    part: it says how many bodies went in, how many came out, how much volume
    the union removed (that is the overlap that was being double-counted), and
    what was discarded.
    """
    t0 = time.perf_counter()
    bodies = to_bodies(m)
    vol_before = m.volume()

    if len(bodies) == 1:
        merged = bodies[0]
    else:
        merged = trimesh.boolean.union(bodies, engine="manifold")

    min_vol = dust_volume_mm3 * MM3
    cleaned, dropped = drop_fragments(merged, min_vol)

    out = Mesh(cleaned.vertices.astype(np.float32),
               cleaned.faces.astype(np.int32),
               np.full(len(cleaned.faces), part_id, dtype=np.int32), name=name)

    report = {
        "bodies_in": len(bodies),
        "bodies_out": int(cleaned.body_count),
        "triangles_in": int(m.n_faces),
        "triangles_out": int(out.n_faces),
        "volume_soup_mm3": round(vol_before / MM3, 3),
        "volume_solid_mm3": round(out.volume() / MM3, 3),
        "overlap_removed_mm3": round((vol_before - out.volume()) / MM3, 3),
        "fragments_dropped": len(dropped),
        "fragment_volume_mm3": round(sum(dropped) / MM3, 6),
        "watertight": bool(cleaned.is_watertight),
        "winding_consistent": bool(cleaned.is_winding_consistent),
        "seconds": round(time.perf_counter() - t0, 2),
    }
    return out, report


def restore_provenance(piece: Mesh, source: Mesh) -> Mesh:
    """Give a consolidated piece back its per-petal part ids.

    The boolean rebuilds the triangles, so the provenance channel that records
    which petal a face came from does not survive it. It is recovered by
    matching each new face centroid to the nearest face of the original soup.
    That is an approximation -- near an overlap the nearest original face may
    belong to either of the two bodies that met there -- so it is used for
    display and grouping, never for the split itself. Cut-wall faces already
    carry their own id and are left alone.
    """
    keep = piece.parts >= PART_BOUNDARY
    centroids = piece.verts[piece.faces].mean(axis=1)
    src_centroids = source.verts[source.faces].mean(axis=1)
    _, idx = cKDTree(src_centroids).query(centroids, k=1)
    parts = source.parts[idx].astype(np.int32)
    parts[keep] = piece.parts[keep]
    return Mesh(piece.verts, piece.faces, parts, name=piece.name)


def fragment_report(m: Mesh, min_volume_mm3: float = 0.5) -> dict:
    """Describe the bodies a piece is actually made of.

    ``coherent`` is the claim worth making or not making: one body means the
    half is a single physical object. Anything else is listed by size so the
    reader can judge whether a severed petal tip matters.
    """
    lab = m.component_labels()
    uniq = np.unique(lab)
    vols = []
    for u in uniq:
        sub = Mesh(m.verts, m.faces[lab == u])
        vols.append(abs(sub.volume()))
    vols = np.array(sorted(vols, reverse=True))
    thresh = min_volume_mm3 * MM3
    return {
        "bodies": int(len(uniq)),
        "coherent": bool(len(uniq) == 1),
        "main_body_volume_mm3": round(float(vols[0]) / MM3, 3) if len(vols) else 0.0,
        "main_body_fraction": round(float(vols[0] / vols.sum()), 6) if len(vols) else 0.0,
        "loose_fragments": int((vols[1:] >= thresh).sum()) if len(vols) > 1 else 0,
        "loose_fragment_volume_mm3": round(float(vols[1:][vols[1:] >= thresh].sum()) / MM3, 4)
        if len(vols) > 1 else 0.0,
        "dust_bodies": int((vols[1:] < thresh).sum()) if len(vols) > 1 else 0,
    }


def clean_piece(m: Mesh, dust_volume_mm3: float = 0.5) -> tuple[Mesh, dict]:
    """Strip boolean debris off a split piece, keeping provenance.

    The split inherits the master's debris and makes a little more of its own
    where the curve grazes a surface. Bodies below the threshold are specks
    that cannot be made and would arrive as loose grit in a bag of parts.
    Anything above it is kept: a severed petal tip is a real consequence of
    where the curve runs, and quietly deleting it would misrepresent the design.
    """
    lab = m.component_labels()
    uniq = np.unique(lab)
    if len(uniq) <= 1:
        return m, {"removed_bodies": 0, "removed_volume_mm3": 0.0}
    keep_faces = np.zeros(m.n_faces, dtype=bool)
    removed_vol = 0.0
    removed = 0
    thresh = dust_volume_mm3 * MM3
    vols = {u: abs(Mesh(m.verts, m.faces[lab == u]).volume()) for u in uniq}
    biggest = max(vols, key=vols.get)
    for u in uniq:
        if u == biggest or vols[u] >= thresh:
            keep_faces |= (lab == u)
        else:
            removed_vol += vols[u]
            removed += 1
    out = Mesh(m.verts, m.faces[keep_faces], m.parts[keep_faces], name=m.name)
    # drop now-unreferenced vertices
    used = np.unique(out.faces)
    remap = np.full(out.n_verts, -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    out = Mesh(out.verts[used], remap[out.faces].astype(np.int32), out.parts, name=m.name)
    return out, {"removed_bodies": removed,
                 "removed_volume_mm3": round(removed_vol / MM3, 6)}
