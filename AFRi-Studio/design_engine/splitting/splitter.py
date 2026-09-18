"""The split kernel.

Divides the master flower into two genuinely independent meshes by exact
per-triangle clipping against the vertical surface swept by the split path.

No CSG, no Blender booleans. Triangles that straddle the path are subdivided at
the exact crossing points, and those crossing vertices are computed once per
edge and shared, which makes the two cut boundaries complementary by
construction rather than by luck.

The master is a collection of disjoint closed solids -- one per petal, plus the
base disc and the centre boss -- and the kernel exploits that: it splits **one
body at a time**. Most bodies lie wholly on one side and are simply moved
there. Only the handful the path actually crosses are clipped, and a cut
through a single petal yields simple, unambiguous boundary loops that cap
reliably. Splitting the whole soup at once instead makes those loops meet at
shared vertices and become guesswork.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from design_engine.configurations.schema import SplitConfig
from design_engine.geometry.mesh import PART_BOUNDARY, Mesh
from design_engine.splitting.paths import SplitPath, build_split_path


@dataclass
class SplitResult:
    piece_a: Mesh
    piece_b: Mesh
    split_path: SplitPath
    master: Mesh
    metadata: dict = field(default_factory=dict)
    validation: dict = field(default_factory=dict)

    def separated(self, distance: float) -> tuple[Mesh, Mesh]:
        """The two pieces moved apart for the exploded view."""
        n = self.split_path.mean_normal()
        t = np.deg2rad(self.split_path.orientation_deg)
        c, s = np.cos(t), np.sin(t)
        nx, ny = n[0] * c - n[1] * s, n[0] * s + n[1] * c
        off = np.array([nx, ny, 0.0], dtype=np.float32) * (distance * 0.5)
        return self.piece_a.translated(off), self.piece_b.translated(-off)


# ---------------------------------------------------------------------------
# Triangle clipping
# ---------------------------------------------------------------------------
def _clip_polygon(idx, s, keep_positive, crossings, verts, eps):
    """Sutherland-Hodgman clip of a triangle against the half-space s >= 0.

    New vertices are memoised per undirected edge and interpolated in a
    canonical direction, so clipping the same edge from the other side returns a
    bitwise-identical point. That is what makes the two cut boundaries coincide
    exactly.
    """
    sign = 1.0 if keep_positive else -1.0
    out = []
    n = len(idx)
    for i in range(n):
        j = (i + 1) % n
        si, sj = s[i] * sign, s[j] * sign
        vi, vj = idx[i], idx[j]
        if si >= -eps:
            out.append(vi)
        if (si > eps and sj < -eps) or (si < -eps and sj > eps):
            key = (vi, vj) if vi < vj else (vj, vi)
            hit = crossings.get(key)
            if hit is None:
                a, b = key
                sa = s[i] if vi == a else s[j]
                sb = s[j] if vi == a else s[i]
                denom = sa - sb
                t = 0.0 if abs(denom) < 1e-30 else min(max(sa / denom, 0.0), 1.0)
                pa, pb = verts[a], verts[b]
                hit = len(verts)
                verts.append(pa + (pb - pa) * t)
                crossings[key] = hit
            out.append(hit)
    # Drop consecutive duplicates, which a vertex sitting on the cut can create.
    dedup = [v for k, v in enumerate(out) if v != out[k - 1]]
    return dedup if len(dedup) >= 3 else []


def _clip_body(verts: np.ndarray, faces: np.ndarray, s_vert: np.ndarray,
               eps: float):
    """Clip one closed body. Returns (verts, faces_a, faces_b)."""
    tri_s = s_vert[faces]
    pos = tri_s > eps
    neg = tri_s < -eps
    all_pos = ~neg.any(axis=1)
    all_neg = ~pos.any(axis=1) & ~all_pos      # keep the two sets disjoint
    mixed = ~(all_pos | all_neg)

    pool = list(verts)
    crossings: dict = {}
    faces_a = [list(map(int, f)) for f in faces[all_pos]]
    faces_b = [list(map(int, f)) for f in faces[all_neg]]

    for fi in np.nonzero(mixed)[0]:
        tri = [int(x) for x in faces[fi]]
        ss = [float(tri_s[fi, k]) for k in range(3)]
        for keep_positive, bucket in ((True, faces_a), (False, faces_b)):
            poly = _clip_polygon(tri, ss, keep_positive, crossings, pool, eps)
            for k in range(1, len(poly) - 1):
                bucket.append([poly[0], poly[k], poly[k + 1]])

    return np.asarray(pool, dtype=np.float64), faces_a, faces_b, int(mixed.sum())


# ---------------------------------------------------------------------------
# Boundary capping
# ---------------------------------------------------------------------------
def boundary_edges(faces: np.ndarray) -> list[tuple[int, int]]:
    """Edges used by exactly one face -- the open boundary."""
    if len(faces) == 0:
        return []
    F = np.asarray(faces, dtype=np.int64)
    e = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    uniq, counts = np.unique(e, axis=0, return_counts=True)
    return [(int(a), int(b)) for a, b in uniq[counts == 1]]


def _split_self_touching(chain: list[int]) -> list[list[int]]:
    """Break a chain that revisits a vertex into simple cycles.

    Petal tips and the centre dome apex are cone points: many grid vertices
    weld to one. A cut passing through such a point makes two cut loops meet
    there, and the walk traces them as a single figure-eight. Ear clipping a
    figure-eight produces a cap whose outline is not the hole's outline, which
    leaves the piece open. Splitting at the repeated vertex restores two simple
    loops that each cap correctly.
    """
    out: list[list[int]] = []
    stack: list[int] = []
    seen: dict[int, int] = {}
    for v in chain:
        if v in seen:
            start = seen[v]
            cycle = stack[start:]
            if len(cycle) >= 3:
                out.append(cycle)
            for w in stack[start:]:
                seen.pop(w, None)
            del stack[start:]
        seen[v] = len(stack)
        stack.append(v)
    if len(stack) >= 3:
        out.append(stack)
    return out


def chain_loops(edges) -> list[tuple[list[int], bool]]:
    """Chain undirected boundary edges into simple closed loops."""
    adj: dict[int, list[int]] = {}
    unused = set()
    for a, b in edges:
        if a == b:
            continue
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
        unused.add((a, b) if a < b else (b, a))

    def step(cur, prev):
        for cand in adj.get(cur, ()):
            if cand == prev:
                continue
            key = (cur, cand) if cur < cand else (cand, cur)
            if key in unused:
                unused.discard(key)
                return cand
        return None

    loops = []
    while unused:
        a, b = next(iter(unused))
        unused.discard((a, b))
        chain, closed = [a, b], False
        while True:
            nxt = step(chain[-1], chain[-2])
            if nxt is None:
                break
            if nxt == chain[0]:
                closed = True
                break
            chain.append(nxt)
        if not closed:
            while True:
                nxt = step(chain[0], chain[1] if len(chain) > 1 else None)
                if nxt is None:
                    break
                if nxt == chain[-1]:
                    closed = True
                    break
                chain.insert(0, nxt)
        if len(chain) >= 3:
            for simple in _split_self_touching(chain):
                loops.append((simple, closed))
    return loops


def earclip(poly: np.ndarray) -> list[tuple[int, int, int]]:
    """Ear-clipping triangulation of a simple polygon given as (N,2).

    Tolerances scale with the polygon, and when no strictly valid ear exists the
    largest convex candidate is clipped anyway: cut cross-sections through thin
    petals are sliver-like, and a purely strict test stalls on them, leaving a
    partly triangulated cap -- which is a hole in the piece.
    """
    n = len(poly)
    if n < 3:
        return []
    scale = float(np.max(poly.max(axis=0) - poly.min(axis=0)))
    if scale <= 0:
        return []
    tol = 1e-10 * scale * scale

    area2 = 0.0
    for i in range(n):
        j = (i + 1) % n
        area2 += poly[i, 0] * poly[j, 1] - poly[j, 0] * poly[i, 1]
    idx = list(range(n)) if area2 > 0 else list(range(n))[::-1]

    def cross(o, a, b):
        return ((poly[a, 0] - poly[o, 0]) * (poly[b, 1] - poly[o, 1])
                - (poly[a, 1] - poly[o, 1]) * (poly[b, 0] - poly[o, 0]))

    def strictly_inside(a, b, c, p):
        return (cross(a, b, p) > tol and cross(b, c, p) > tol
                and cross(c, a, p) > tol)

    tris = []
    while len(idx) > 3:
        best = convex_best = any_best = None
        for k in range(len(idx)):
            a, b, c = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            conv = cross(a, b, c)
            if any_best is None or abs(conv) > any_best[0]:
                any_best = (abs(conv), k, (a, b, c))
            if conv <= tol:
                continue
            if convex_best is None or conv > convex_best[0]:
                convex_best = (conv, k, (a, b, c))
            if any(strictly_inside(a, b, c, p) for p in idx if p not in (a, b, c)):
                continue
            best = (k, (a, b, c))
            break
        if best is not None:
            k, tri = best
        elif convex_best is not None:
            _, k, tri = convex_best
        elif any_best is not None:
            # Nothing convex is left: the remainder is a near-collinear sliver.
            # Clip the least degenerate corner anyway. The triangle it emits may
            # have almost no area, but it is invisible in render and export, and
            # stopping here would instead leave a real hole in the piece.
            _, k, tri = any_best
        else:
            break
        tris.append(tri)
        idx.pop(k)
    if len(idx) == 3:
        tris.append((idx[0], idx[1], idx[2]))
    return tris


def cap_faces(verts: np.ndarray, faces: list, path: SplitPath,
              outward_sign: float) -> tuple[list, dict]:
    """Triangulate the open boundary of a clipped body on the flattened cut wall.

    The cut runs along the ruled vertical surface swept by the path. That
    surface is developable, so it flattens exactly to 2-D as (arclength, z):
    triangulate there, then map straight back to 3-D.

    ``outward_sign`` is the sign the cap normal's split-frame x component must
    carry: -1 for the piece on the +s side, +1 for the other. It has to be
    supplied rather than inferred, because :func:`chain_loops` walks the
    boundary *undirected* and so hands back loops in an arbitrary rotational
    direction. Triangulating those as they come leaves some caps wound
    backwards -- an inverted cap renders as a black hole and makes the piece's
    measured volume wrong, and it is invisible to a check that only compares
    ``volume(A) + volume(B)`` against the master, because the two pieces' caps
    are exact negatives of one another and the error cancels in the sum.
    """
    edges = boundary_edges(np.asarray(faces, dtype=np.int64)) if faces else []
    if not edges:
        return [], {"caps": 0, "cap_triangles": 0, "open_chains": 0, "loops": 0}

    loops = chain_loops(edges)
    new_faces, capped, open_chains = [], 0, 0
    for loop, closed in loops:
        if not closed:
            open_chains += 1
            continue
        pts = verts[loop]
        poly2 = np.stack([path.t_of_y(pts[:, 1]), pts[:, 2]], axis=1)
        tris = earclip(poly2)
        if not tris:
            open_chains += 1
            continue
        # Decide the loop's facing once, from the area-weighted normal of the
        # whole cap: individual slivers are too noisy to trust one at a time.
        nx = 0.0
        for (a, b, c) in tris:
            pa, pb, pc = pts[a], pts[b], pts[c]
            nx += float(np.cross(pb - pa, pc - pa)[0])
        if nx * outward_sign < 0:
            tris = [(c, b, a) for (a, b, c) in tris]
        for (a, b, c) in tris:
            new_faces.append([loop[a], loop[b], loop[c]])
        capped += 1
    return new_faces, {"caps": capped, "cap_triangles": len(new_faces),
                       "open_chains": open_chains, "loops": len(loops)}


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def split_flower(master: Mesh, cfg: SplitConfig, radius: float,
                 progress=None, eps: float = 1e-9,
                 body_labels: np.ndarray | None = None) -> SplitResult:
    """Divide the master flower into two independent, complementary pieces.

    ``body_labels`` gives the per-face grouping into closed bodies. It defaults
    to the part-provenance channel, which is exactly right for the as-built
    flower: one petal, one part id, one closed solid. A *consolidated* flower
    is a single manifold whose faces still carry per-petal ids, and grouping
    that by part id would hand the kernel 159 open patches instead of one
    closed body -- measured, that produces 6,475 open edges and a 15% volume
    error. Pass connected-component labels in that case.
    """
    t0 = time.perf_counter()

    # An angled split is handled by rotating into the split's own frame, cutting
    # there, and rotating back -- so no special-casing is needed.
    theta = np.deg2rad(cfg.orientation_deg)
    work = master.rotated_z(-theta) if abs(theta) > 1e-9 else master

    if progress:
        progress("building split path", 1, 5)
    path = build_split_path(cfg, radius)

    V = work.verts.astype(np.float64)
    s_all = V[:, 0] - path.f(V[:, 1])

    # Symbolic perturbation: if the path runs exactly through a mesh vertex,
    # several cut segments meet at one point and the boundary loops stop being
    # simple. A sub-micron nudge removes the coincidence. It is far below any
    # manufacturing tolerance and does not move the visible boundary.
    nudge = 0.0
    for attempt in range(8):
        if not (np.abs(s_all - nudge) < 1e-7).any():
            break
        nudge = 1.3e-5 * (attempt + 1)
    s_all = s_all - nudge

    parts = work.parts if body_labels is None else np.asarray(body_labels)
    unique_parts = np.unique(parts)
    if progress:
        progress(f"clipping {work.n_faces} triangles across "
                 f"{len(unique_parts)} bodies", 2, 5)

    meshes_a: list[Mesh] = []
    meshes_b: list[Mesh] = []
    n_clipped_bodies = n_clipped_tris = 0
    cap_stats = {"caps": 0, "cap_triangles": 0, "open_chains": 0, "loops": 0}

    for pid in unique_parts:
        sel = parts == pid
        bfaces = work.faces[sel]
        used = np.unique(bfaces)
        remap = np.full(work.n_verts, -1, dtype=np.int64)
        remap[used] = np.arange(len(used))
        bverts = V[used]
        bs = s_all[used]
        bf = remap[bfaces]

        # A body that is not cut keeps its faces' own provenance exactly.
        own_parts = work.parts[sel].astype(np.int32)
        if (bs > eps).all():
            meshes_a.append(Mesh(bverts.astype(np.float32), bf.astype(np.int32), own_parts))
            continue
        if (bs < -eps).all():
            meshes_b.append(Mesh(bverts.astype(np.float32), bf.astype(np.int32), own_parts))
            continue

        n_clipped_bodies += 1
        pool, fa, fb, ntri = _clip_body(bverts, bf, bs, eps)
        n_clipped_tris += ntri

        # Piece A is the region s > 0, so at the cut its material faces toward
        # -x in the split frame; piece B is the mirror of that.
        for faces, bucket, outward in ((fa, meshes_a, -1.0), (fb, meshes_b, 1.0)):
            if not faces:
                continue
            pid_list = [int(own_parts[0])] * len(faces)
            if cfg.cap_boundary:
                caps, st = cap_faces(pool, faces, path, outward)
                for k in ("caps", "cap_triangles", "open_chains", "loops"):
                    cap_stats[k] += st[k]
                if caps:
                    faces = faces + caps
                    pid_list = pid_list + [PART_BOUNDARY] * len(caps)
            f = np.asarray(faces, dtype=np.int64)
            u = np.unique(f)
            rm = np.full(len(pool), -1, dtype=np.int64)
            rm[u] = np.arange(len(u))
            bucket.append(Mesh(pool[u].astype(np.float32), rm[f].astype(np.int32),
                               np.asarray(pid_list, dtype=np.int32)))

    if progress:
        progress(f"capping {n_clipped_bodies} divided bodies", 3, 5)

    piece_a = Mesh.concat(meshes_a, name="piece_a")
    piece_b = Mesh.concat(meshes_b, name="piece_b")

    # Make the winding globally consistent before handing the pieces back.
    #
    # Orienting each cap loop by its area-weighted normal gets the *net* facing
    # right, which is what the volume checks see, but it does not guarantee
    # that every cap triangle agrees with the surface it seals along their
    # shared edge. Measured on the shipped flower: 52 directed edges out of
    # roughly 690,000 were traversed the same way by both their faces. That is
    # a small defect with two real consequences -- the reported volume was out
    # by 0.04%, and an exact boolean kernel refuses the mesh outright, which is
    # what blocked fusing the attachment pins into the piece.
    piece_a = piece_a.oriented()
    piece_b = piece_b.oriented()

    if abs(theta) > 1e-9:
        piece_a = piece_a.rotated_z(theta)
        piece_b = piece_b.rotated_z(theta)
        # The path stays in the split frame; record the rotation so that anything
        # testing world-space points can get back here.
        path.orientation_deg = cfg.orientation_deg

    if progress:
        progress("split complete", 4, 5)

    meta = {
        "triangles_in": int(master.n_faces),
        "bodies_total": int(len(unique_parts)),
        "bodies_divided": n_clipped_bodies,
        "triangles_clipped": n_clipped_tris,
        "path_perturbation": float(nudge),
        "boundary_loops": cap_stats["loops"],
        "caps_built": cap_stats["caps"],
        "cap_triangles": cap_stats["cap_triangles"],
        "cap_failures": cap_stats["open_chains"],
        "residual_open_edges_a": len(boundary_edges(piece_a.faces)),
        "residual_open_edges_b": len(boundary_edges(piece_b.faces)),
        "split_seconds": round(time.perf_counter() - t0, 3),
        "path_kind": path.kind,
        "orientation_deg": cfg.orientation_deg,
    }
    return SplitResult(piece_a=piece_a, piece_b=piece_b, split_path=path,
                       master=master, metadata=meta)
