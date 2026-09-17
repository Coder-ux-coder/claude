"""Geometry validation.

Every check here is a measurement with a stated tolerance. There are no
invented aesthetic scores: whether a flower is beautiful is a judgement for a
person, and this module does not pretend otherwise. What it can prove, it
proves -- that two independent solids exist, that together they are exactly the
master, and that neither has leaked into the other's territory.
"""
from __future__ import annotations

import time

import numpy as np

from design_engine.geometry.mesh import PART_BOUNDARY, Mesh, part_kind
from design_engine.splitting.paths import SplitPath


def _check(name, passed, detail, value=None, tolerance=None, severity="error"):
    return {"name": name, "passed": bool(passed), "detail": detail,
            "value": value, "tolerance": tolerance,
            "severity": severity if not passed else "info"}


def _open_edges(mesh: Mesh) -> int:
    if mesh.n_faces == 0:
        return 0
    F = mesh.faces.astype(np.int64)
    e = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    _, counts = np.unique(e, axis=0, return_counts=True)
    return int((counts == 1).sum())


def _nonmanifold_edges(mesh: Mesh) -> int:
    if mesh.n_faces == 0:
        return 0
    F = mesh.faces.astype(np.int64)
    e = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    _, counts = np.unique(e, axis=0, return_counts=True)
    return int((counts > 2).sum())


def chord_tolerance(path: SplitPath, edge_length: float) -> float:
    """How far a straight cut across one triangle can sit from the curved path.

    Crossing points are found by interpolating along a triangle edge, so the cut
    surface is a chord of the split path, not the path itself. The gap between
    the two is real geometry, not error: it grows with path curvature and with
    triangle size. Measuring it gives the contamination check a tolerance
    derived from the actual design rather than a guessed constant.
    """
    if edge_length <= 0 or len(path.y) < 3:
        return 0.0
    step = float(np.median(np.diff(path.y)))
    span = max(2, int(round(edge_length / max(step, 1e-9))))
    span = min(span, len(path.y) // 2)
    if span < 2:
        return 0.0
    worst = 0.0
    for start in range(0, len(path.y) - span, max(1, span // 2)):
        end = start + span
        y0, y1 = path.y[start], path.y[end]
        x0, x1 = path.x[start], path.x[end]
        seg_y = path.y[start:end + 1]
        seg_x = path.x[start:end + 1]
        chord = x0 + (seg_y - y0) * (x1 - x0) / max(y1 - y0, 1e-12)
        worst = max(worst, float(np.abs(seg_x - chord).max()))
    return worst


def _max_edge_span_y(mesh: Mesh) -> float:
    """Largest y-extent of any triangle edge.

    The split path is a function of y, so it is an edge's *y* span that decides
    how far its chord can stray from the curve -- and the worst case is set by
    the largest such span, not a typical one.
    """
    if mesh.n_faces == 0:
        return 0.0
    t = mesh.verts[mesh.faces].astype(np.float64)
    dy = np.abs(np.concatenate([t[:, 1, 1] - t[:, 0, 1],
                                t[:, 2, 1] - t[:, 1, 1],
                                t[:, 0, 1] - t[:, 2, 1]]))
    return float(dy.max())


def _max_edge_span_split_frame(mesh: Mesh, path: SplitPath) -> float:
    """As above, but measured in the split frame where the path is defined."""
    if mesh.n_faces == 0:
        return 0.0
    v = path.to_split_frame(mesh.verts)
    t = v[mesh.faces]
    dy = np.abs(np.concatenate([t[:, 1, 1] - t[:, 0, 1],
                                t[:, 2, 1] - t[:, 1, 1],
                                t[:, 0, 1] - t[:, 2, 1]]))
    return float(dy.max())


def validate_split(master: Mesh, piece_a: Mesh, piece_b: Mesh,
                   path: SplitPath, tolerance_mm: float = 0.05,
                   mm_per_unit: float = 10.0) -> dict:
    """Run the full validation suite over a split result."""
    t0 = time.perf_counter()
    checks: list[dict] = []
    tol = tolerance_mm / mm_per_unit
    edge = _max_edge_span_split_frame(master, path)
    chord = chord_tolerance(path, edge)
    # The boundary can legitimately sit a chord-width off the analytic path, so
    # contamination is judged against that, never against a fixed epsilon. A
    # genuinely misassigned petal is orders of magnitude beyond this bound, so
    # the check still catches what it exists to catch.
    # The kernel nudges the path by up to ~1e-4 units to avoid running exactly
    # through a vertex, so the floor has to clear that.
    bleed_tol = max(tol, chord, 3e-4)

    # ---- existence -------------------------------------------------------
    checks.append(_check("master_nonempty", not master.is_empty,
                         f"master has {master.n_verts} vertices, {master.n_faces} triangles",
                         value=master.n_faces))
    checks.append(_check("pieces_nonempty",
                         not piece_a.is_empty and not piece_b.is_empty,
                         f"piece A {piece_a.n_faces} tris, piece B {piece_b.n_faces} tris",
                         value=[piece_a.n_faces, piece_b.n_faces]))

    # ---- the split is real, not cosmetic ---------------------------------
    pa = set(np.unique(piece_a.parts).tolist())
    pb = set(np.unique(piece_b.parts).tolist())
    shared_parts = (pa & pb) - {PART_BOUNDARY}
    checks.append(_check(
        "split_is_geometric",
        piece_a.n_faces > 0 and piece_b.n_faces > 0 and piece_a is not piece_b,
        f"two independent meshes; {len(shared_parts)} bodies were physically divided "
        f"between them", value=len(shared_parts)))

    # ---- every body faces outward ---------------------------------------
    # This check exists because its absence hid a real bug. Cut caps were being
    # triangulated in whatever rotational direction the undirected boundary
    # walk happened to produce, leaving 9 bodies in piece A and 10 in piece B
    # wound inside-out. Volume conservation could not see it: the two pieces'
    # caps are exact negatives of each other, so an inverted cap cancels in the
    # A + B sum and the total still matched the master to eight decimals.
    # Judged only on bodies that carry meaningful volume. A clipped petal tip
    # can leave a sliver of a few triangles enclosing ~1e-6 of a cubic unit,
    # and the sign of a volume that small is numerical noise, not a defect.
    inverted, specks = [], 0
    for nm, piece in (("A", piece_a), ("B", piece_b)):
        lab = piece.component_labels()
        floor = abs(piece.volume()) * 1e-5
        for u in np.unique(lab):
            sub = Mesh(piece.verts, piece.faces[lab == u])
            v = sub.volume()
            if v >= 0:
                continue
            if abs(v) < floor:
                specks += 1
            else:
                inverted.append((nm, float(v)))
    detail = ("every body that carries volume encloses it outward"
              if not inverted else
              f"{len(inverted)} bodies are wound inside-out "
              f"(worst {min(v for _, v in inverted):.3e})")
    if specks:
        detail += f"; {specks} sub-threshold slivers ignored"
    checks.append(_check("outward_normals", not inverted, detail, value=len(inverted)))

    # ---- exact reconstruction -------------------------------------------
    vm, va, vb = master.volume(), piece_a.volume(), piece_b.volume()
    rel = abs(va + vb - vm) / max(abs(vm), 1e-12)
    checks.append(_check("volume_conservation", rel < 0.01,
                         f"|V(A)+V(B) - V(master)| / V(master) = {rel * 100:.6f}%",
                         value=round(rel, 10), tolerance=0.01))

    area_new = sum(m.face_areas()[m.parts == PART_BOUNDARY].sum()
                   for m in (piece_a, piece_b))
    area_rel = abs((piece_a.area() + piece_b.area() - area_new) - master.area()) / max(master.area(), 1e-12)
    checks.append(_check("area_conservation", area_rel < 0.02,
                         f"surface area matches to {area_rel * 100:.4f}% once the two "
                         f"new cut walls ({area_new:.3f} sq units) are discounted",
                         value=round(area_rel, 8), tolerance=0.02))

    # ---- no leakage across the boundary ----------------------------------
    sa = path.signed(piece_a.verts)
    sb = path.signed(piece_b.verts)
    bleed_a = int((sa < -bleed_tol).sum())
    bleed_b = int((sb > bleed_tol).sum())
    worst = max(float(-sa.min()) if len(sa) else 0.0,
                float(sb.max()) if len(sb) else 0.0)
    checks.append(_check(
        "no_cross_contamination", bleed_a == 0 and bleed_b == 0,
        f"{bleed_a} vertices of A past the boundary into B's side, {bleed_b} the "
        f"other way. Worst excursion {worst * mm_per_unit:.4f} mm against a "
        f"{bleed_tol * mm_per_unit:.4f} mm allowance "
        f"(chord of the curved cut across the widest {edge * mm_per_unit:.3f} mm edge span).",
        value=[bleed_a, bleed_b], tolerance=round(bleed_tol, 8)))

    # ---- no bridging -----------------------------------------------------
    # Every connected component must sit on one side. A component spanning both
    # would mean the two pieces are still joined -- the failure this whole
    # subsystem exists to prevent.
    bridging = 0
    for piece, sign in ((piece_a, 1.0), (piece_b, -1.0)):
        if piece.n_faces == 0:
            continue
        s = path.signed(piece.verts)
        labels = piece.component_labels()
        for lab in np.unique(labels):
            fmask = labels == lab
            vids = np.unique(piece.faces[fmask])
            sv = s[vids] * sign
            if sv.min() < -bleed_tol:
                bridging += 1
    checks.append(_check("no_bridging_geometry", bridging == 0,
                         f"{bridging} connected components straddle the split line",
                         value=bridging))

    # ---- closure ---------------------------------------------------------
    for nm, piece in (("a", piece_a), ("b", piece_b)):
        oe, nm_e = _open_edges(piece), _nonmanifold_edges(piece)
        checks.append(_check(
            f"piece_{nm}_closed", oe == 0,
            f"piece {nm.upper()} has {oe} open edges" if oe else
            f"piece {nm.upper()} is a closed solid",
            value=oe, severity="warning"))
        checks.append(_check(
            f"piece_{nm}_manifold", nm_e == 0,
            f"piece {nm.upper()} has {nm_e} non-manifold edges" if nm_e else
            f"piece {nm.upper()} is edge-manifold", value=nm_e))

    # ---- boundary surface exists ----------------------------------------
    for nm, piece in (("a", piece_a), ("b", piece_b)):
        nb = int((piece.parts == PART_BOUNDARY).sum())
        checks.append(_check(
            f"piece_{nm}_has_boundary_surface", nb > 0,
            f"piece {nm.upper()} carries {nb} intentional boundary-wall triangles",
            value=nb, severity="warning"))

    # ---- independently addressable --------------------------------------
    ok_a = piece_a.n_faces > 0 and np.isfinite(piece_a.verts).all()
    ok_b = piece_b.n_faces > 0 and np.isfinite(piece_b.verts).all()
    checks.append(_check("components_addressable", ok_a and ok_b,
                         "both pieces have finite coordinates and can be exported "
                         "independently"))

    # ---- footprint reconstruction ---------------------------------------
    fp = _footprint_check(master, piece_a, piece_b)
    checks.append(fp)

    # ---- degenerate faces (reported, not fatal) --------------------------
    for nm, piece in (("a", piece_a), ("b", piece_b)):
        nd = int((piece.face_areas() <= 1e-12).sum()) if piece.n_faces else 0
        checks.append(_check(
            f"piece_{nm}_degenerate_faces", True,
            f"{nd} zero-area triangles (retained deliberately: removing one "
            f"would re-open the surface it belongs to)",
            value=nd, severity="info"))

    passed = sum(1 for c in checks if c["passed"])
    errors = [c for c in checks if not c["passed"] and c["severity"] == "error"]
    warnings = [c for c in checks if not c["passed"] and c["severity"] == "warning"]

    return {
        "checks": checks,
        "passed": passed,
        "total": len(checks),
        "errors": len(errors),
        "warnings": len(warnings),
        "ok": len(errors) == 0,
        "seconds": round(time.perf_counter() - t0, 3),
        "measurements": {
            "boundary_chord_mm": round(chord * mm_per_unit, 5),
            "max_edge_span_mm": round(edge * mm_per_unit, 4),
            "worst_excursion_mm": round(worst * mm_per_unit, 5),
            "master_volume": round(vm, 6),
            "piece_a_volume": round(va, 6),
            "piece_b_volume": round(vb, 6),
            "volume_balance": round(va / max(va + vb, 1e-12), 4),
            "master_faces": master.n_faces,
            "piece_a_faces": piece_a.n_faces,
            "piece_b_faces": piece_b.n_faces,
            "boundary_area": round(float(area_new), 6),
        },
    }


def _footprint_check(master: Mesh, piece_a: Mesh, piece_b: Mesh,
                     grid: int = 384) -> dict:
    """Do the two footprints, unioned, reconstruct the master footprint?

    Rasterised rather than done with polygon booleans, which would be far too
    slow over this many triangles. Samples are drawn in proportion to triangle
    *area*, not per triangle: splitting roughly doubles the triangle count for
    the same surface, so a fixed per-triangle budget would hand the two pieces
    twice the coverage of the master and invent a discrepancy that is not there.
    """
    if master.n_faces == 0 or piece_a.n_faces == 0 or piece_b.n_faces == 0:
        return _check("footprint_reconstruction", False,
                      "a mesh was empty", severity="warning")

    b = master.bounds()
    lo, hi = b[0, :2].astype(np.float64), b[1, :2].astype(np.float64)
    span = np.maximum(hi - lo, 1e-9)
    cell_area = float((span[0] / grid) * (span[1] / grid))

    def mask(meshes: list[Mesh]) -> np.ndarray:
        m = np.zeros((grid, grid), dtype=bool)
        for mesh in meshes:
            tri = mesh.tri_coords().astype(np.float64)
            # Projected (2-D) area decides the sample budget: a triangle seen
            # edge-on covers no footprint and needs no samples.
            a2 = np.abs((tri[:, 1, 0] - tri[:, 0, 0]) * (tri[:, 2, 1] - tri[:, 0, 1])
                        - (tri[:, 2, 0] - tri[:, 0, 0]) * (tri[:, 1, 1] - tri[:, 0, 1])) * 0.5
            n = np.maximum(1, np.ceil(a2 / max(cell_area, 1e-12) * 3.0)).astype(np.int64)
            n = np.minimum(n, 400)
            idx = np.repeat(np.arange(len(tri)), n)
            rng = np.random.default_rng(12345)
            u = rng.random(len(idx))
            v = rng.random(len(idx))
            flip = u + v > 1.0
            u[flip], v[flip] = 1.0 - u[flip], 1.0 - v[flip]
            t = tri[idx][:, :, :2]
            pts = t[:, 0] + (t[:, 1] - t[:, 0]) * u[:, None] + (t[:, 2] - t[:, 0]) * v[:, None]
            pts = np.vstack([pts, mesh.verts[:, :2].astype(np.float64)])
            ij = np.floor((pts - lo) / span * (grid - 1)).astype(np.int64)
            np.clip(ij, 0, grid - 1, out=ij)
            m[ij[:, 0], ij[:, 1]] = True
        return m

    mm = mask([master])
    mu = mask([piece_a, piece_b])
    inter = int((mm & mu).sum())
    union = int((mm | mu).sum())
    rel = (union - inter) / max(union, 1)
    return _check("footprint_reconstruction", rel < 0.02,
                  f"A union B covers the master footprint to within "
                  f"{rel * 100:.3f}% of cells on a {grid}x{grid} grid "
                  f"({union - inter} differing of {union})",
                  value=round(rel, 6), tolerance=0.02, severity="warning")
