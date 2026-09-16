"""Mesh value type and geometric measurements.

Deliberately minimal: float32 vertices, int32 triangles, and an int32 part id
per face that records provenance (which petal, which layer, base, centre). The
part ids survive splitting, which is what lets validation prove that no single
petal ended up bridging the two pieces.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

# Part id encoding. Keeps provenance in a single int32.
PART_BASE = 1_000_000
PART_CENTER = 2_000_000
PART_PETAL = 3_000_000  # + layer*10_000 + index
PART_BOUNDARY = 4_000_000  # generated cut wall


def petal_part_id(layer: int, index: int) -> int:
    return PART_PETAL + layer * 10_000 + index


def part_kind(pid: int) -> str:
    if pid >= PART_BOUNDARY:
        return "boundary"
    if pid >= PART_PETAL:
        return "petal"
    if pid >= PART_CENTER:
        return "center"
    return "base"


@dataclass
class Mesh:
    verts: np.ndarray                      # (V,3) float32
    faces: np.ndarray                      # (F,3) int32
    parts: np.ndarray = field(default=None)  # (F,) int32
    name: str = "mesh"

    def __post_init__(self):
        self.verts = np.ascontiguousarray(self.verts, dtype=np.float32).reshape(-1, 3)
        self.faces = np.ascontiguousarray(self.faces, dtype=np.int32).reshape(-1, 3)
        if self.parts is None:
            self.parts = np.zeros(len(self.faces), dtype=np.int32)
        self.parts = np.ascontiguousarray(self.parts, dtype=np.int32).reshape(-1)
        if len(self.parts) != len(self.faces):
            raise ValueError(f"parts/faces length mismatch: {len(self.parts)} vs {len(self.faces)}")

    # ---------------- basic properties ----------------
    @property
    def n_verts(self) -> int:
        return len(self.verts)

    @property
    def n_faces(self) -> int:
        return len(self.faces)

    @property
    def is_empty(self) -> bool:
        return self.n_verts == 0 or self.n_faces == 0

    def bounds(self) -> np.ndarray:
        if self.n_verts == 0:
            return np.zeros((2, 3), dtype=np.float32)
        return np.stack([self.verts.min(0), self.verts.max(0)]).astype(np.float32)

    def tri_coords(self) -> np.ndarray:
        """(F,3,3) array of triangle corner coordinates."""
        return self.verts[self.faces]

    def face_areas(self) -> np.ndarray:
        t = self.tri_coords().astype(np.float64)
        return 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)

    def area(self) -> float:
        return float(self.face_areas().sum()) if self.n_faces else 0.0

    def volume(self) -> float:
        """Signed volume via the divergence theorem. Meaningful for closed meshes."""
        if self.n_faces == 0:
            return 0.0
        t = self.tri_coords().astype(np.float64)
        return float(np.einsum("ij,ij->i", t[:, 0], np.cross(t[:, 1], t[:, 2])).sum() / 6.0)

    def face_normals(self) -> np.ndarray:
        t = self.tri_coords().astype(np.float64)
        n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
        ln = np.linalg.norm(n, axis=1, keepdims=True)
        return np.divide(n, np.where(ln == 0, 1.0, ln))

    # ---------------- transforms ----------------
    def transformed(self, matrix: np.ndarray) -> "Mesh":
        m = np.asarray(matrix, dtype=np.float64)
        if m.shape == (3, 3):
            v = self.verts.astype(np.float64) @ m.T
        elif m.shape == (4, 4):
            v = self.verts.astype(np.float64) @ m[:3, :3].T + m[:3, 3]
        else:
            raise ValueError("matrix must be 3x3 or 4x4")
        return replace(self, verts=v.astype(np.float32))

    def translated(self, vec) -> "Mesh":
        return replace(self, verts=(self.verts + np.asarray(vec, dtype=np.float32)).astype(np.float32))

    def rotated_z(self, radians: float) -> "Mesh":
        c, s = np.cos(radians), np.sin(radians)
        return self.transformed(np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]]))

    def scaled(self, factor) -> "Mesh":
        f = np.asarray(factor, dtype=np.float32)
        return replace(self, verts=(self.verts * f).astype(np.float32))

    # ---------------- combination ----------------
    @staticmethod
    def concat(meshes: list["Mesh"], name: str = "mesh") -> "Mesh":
        meshes = [m for m in meshes if m is not None and m.n_faces > 0]
        if not meshes:
            return Mesh(np.zeros((0, 3), np.float32), np.zeros((0, 3), np.int32), name=name)
        vs, fs, ps, off = [], [], [], 0
        for m in meshes:
            vs.append(m.verts)
            fs.append(m.faces + off)
            ps.append(m.parts)
            off += m.n_verts
        return Mesh(np.concatenate(vs), np.concatenate(fs), np.concatenate(ps), name=name)

    # ---------------- cleanup ----------------
    def drop_degenerate(self, eps: float = 1e-10) -> "Mesh":
        if self.n_faces == 0:
            return self
        keep = self.face_areas() > eps
        return replace(self, faces=self.faces[keep], parts=self.parts[keep])

    def welded(self, tol: float = 1e-5) -> "Mesh":
        """Merge vertices within tol by quantised hashing, then drop degenerates."""
        if self.n_verts == 0:
            return self
        q = np.round(self.verts.astype(np.float64) / tol).astype(np.int64)
        _, first, inverse = np.unique(q, axis=0, return_index=True, return_inverse=True)
        new_verts = self.verts[first]
        # np.unique returns sorted uniques; remap inverse accordingly
        new_faces = inverse.reshape(-1)[self.faces]
        out = Mesh(new_verts, new_faces.astype(np.int32), self.parts.copy(), self.name)
        return out.drop_degenerate()

    def oriented(self) -> "Mesh":
        """Make face winding globally consistent, with outward-facing normals.

        Breadth-first propagation across shared edges: two faces sharing an
        edge are consistently wound when they traverse that edge in opposite
        directions. Runs per connected component, then flips any component
        whose enclosed volume came out negative.
        """
        if self.n_faces == 0:
            return self
        F = self.faces.copy()
        nf = len(F)

        # edge key -> list of (face, slot)
        edges: dict[tuple[int, int], list[tuple[int, int]]] = {}
        for fi in range(nf):
            a, b, c = F[fi]
            for slot, (x, y) in enumerate(((a, b), (b, c), (c, a))):
                edges.setdefault((int(min(x, y)), int(max(x, y))), []).append((fi, slot))

        visited = np.zeros(nf, dtype=bool)
        comps: list[list[int]] = []
        for start in range(nf):
            if visited[start]:
                continue
            visited[start] = True
            stack = [start]
            comp = [start]
            while stack:
                fi = stack.pop()
                a, b, c = F[fi]
                for (x, y) in ((a, b), (b, c), (c, a)):
                    key = (int(min(x, y)), int(max(x, y)))
                    for (fj, slot) in edges.get(key, ()):
                        if fj == fi or visited[fj]:
                            continue
                        p2, q2 = F[fj][slot], F[fj][(slot + 1) % 3]
                        # same direction as (x, y) means fj is wound the wrong way
                        if (int(p2), int(q2)) == (int(x), int(y)):
                            F[fj] = F[fj][::-1]
                        visited[fj] = True
                        stack.append(fj)
                        comp.append(fj)
            comps.append(comp)

        out = Mesh(self.verts.copy(), F, self.parts.copy(), self.name)
        for comp in comps:
            idx = np.array(comp, dtype=np.int64)
            sub = Mesh(out.verts, out.faces[idx])
            if sub.volume() < 0:
                out.faces[idx] = out.faces[idx][:, ::-1]
        return out

    def component_labels(self) -> np.ndarray:
        """Connected-component label per face, via union-find over shared vertices."""
        if self.n_faces == 0:
            return np.zeros(0, dtype=np.int32)
        parent = np.arange(self.n_verts, dtype=np.int64)

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a, b, c in self.faces:
            ra, rb, rc = find(a), find(b), find(c)
            if ra != rb:
                parent[rb] = ra
            if ra != rc:
                parent[rc] = ra
        roots = np.array([find(i) for i in range(self.n_verts)], dtype=np.int64)
        return roots[self.faces[:, 0]].astype(np.int64)

    # ---------------- serialisation ----------------
    def to_npz_dict(self, prefix: str) -> dict:
        return {f"{prefix}_verts": self.verts, f"{prefix}_faces": self.faces,
                f"{prefix}_parts": self.parts}

    @staticmethod
    def from_npz(data, prefix: str) -> "Mesh":
        return Mesh(data[f"{prefix}_verts"], data[f"{prefix}_faces"],
                    data[f"{prefix}_parts"], name=prefix)

    def stats(self) -> dict:
        b = self.bounds()
        return {
            "verts": int(self.n_verts), "faces": int(self.n_faces),
            "area": round(self.area(), 6), "volume": round(self.volume(), 6),
            "bounds_min": [round(float(x), 4) for x in b[0]],
            "bounds_max": [round(float(x), 4) for x in b[1]],
        }


def grid_faces(nu: int, nv: int, flip: bool = False, offset: int = 0) -> np.ndarray:
    """Triangulate a (nu x nv) vertex grid indexed as i*nv + j."""
    i, j = np.meshgrid(np.arange(nu - 1), np.arange(nv - 1), indexing="ij")
    a = (i * nv + j).ravel() + offset
    b = (i * nv + j + 1).ravel() + offset
    c = ((i + 1) * nv + j + 1).ravel() + offset
    d = ((i + 1) * nv + j).ravel() + offset
    if flip:
        return np.concatenate([np.stack([a, c, b], 1), np.stack([a, d, c], 1)]).astype(np.int32)
    return np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)]).astype(np.int32)
