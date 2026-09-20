# AFRi Studio — Architecture

**A local-first, offline-capable AI product design studio for two-piece marigold
flower accessories.**

Version 1.0 · Stage One (standalone flower concepts). Hat integration is Stage Two
and is **not** implemented — see `future/HAT_INTEGRATION_PLAN.md`.

---

## 1. Product requirements

### 1.1 Confirmed client requirements

These come directly from the brief and are treated as fixed:

| # | Requirement |
|---|---|
| R1 | The accessory is a **marigold** flower. |
| R2 | It consists of **two separate physical pieces**. |
| R3 | Brought together, the two pieces reconstruct **one complete marigold**. |
| R4 | Multiple ways of dividing the flower must be explorable. |
| R5 | An **S-shaped, river-inspired split** is a priority concept. |
| R6 | The accessory will eventually sit on a **hat brim** (Stage Two). |
| R7 | Stage One delivers **standalone flower concepts** only. |

### 1.2 Design assumptions (NOT client-confirmed)

The client has not supplied the reference PowerPoint. Everything below is a
**provisional studio assumption**, is labelled as such in the UI and in the client
presentation, and is trivially overridable through configuration:

| # | Assumption | Rationale |
|---|---|---|
| A1 | Nominal flower diameter **90 mm** | Legible on a hat brim without dominating it. |
| A2 | Overall relief depth **≈ 18 mm** | Reads as three-dimensional while staying wearable. |
| A3 | Form is a **domed rosette** (relief), not a full sphere | A hat accessory is a relief object; a full pom-pom cannot lie on a brim. |
| A4 | Provisional palette: marigold orange, deep saffron, ivory | Generic marigold colours. **Not AFRi brand colours** — none are known. |
| A5 | Split plane is **vertical** through the rosette | Yields two pieces that separate laterally, the natural reading of "two pieces that come together". |
| A6 | Units: **1 Blender unit = 10 mm** | Keeps Cycles' default light falloff and clipping in a comfortable range. |

The application never claims a design matches AFRi's brand language. The
`references/` import path (Part 32) exists so the client's real references can
be loaded later and the assumptions replaced.

---

## 2. Technology stack

All components are free and open source. No paid API, cloud renderer, commercial
CAD tool, or subscription service is required at any point.

| Layer | Choice | Licence |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | MIT |
| Styling | Tailwind CSS | MIT |
| 3D viewport | Three.js via React Three Fiber + drei | MIT |
| State | Zustand | MIT |
| Backend | Python 3.11 + FastAPI + Pydantic v2 | MIT / BSD |
| Server | Uvicorn | BSD |
| Database | SQLite (stdlib `sqlite3`) | Public domain |
| Events | Server-Sent Events (SSE) | — |
| Geometry | NumPy, Shapely, trimesh | BSD / MIT |
| 3D suite | Blender 4.5 LTS + `bpy` | GPL-2.0-or-later (invoked as a separate process — see §16.3) |
| Documents | ReportLab (PDF), python-pptx (PPTX) | BSD / MIT |
| Images | Pillow | MIT-CMU |

Full manifest with licence texts: `LICENSES.md`.

### 2.1 Verified environment (this machine)

Measured at build time, not assumed:

```
OS          Ubuntu 24.04.4 LTS, kernel 6.18.44, x86_64
CPU         Intel Xeon @ 2.80GHz, 4 cores, AVX-512
RAM         15 GiB
Disk        30 GiB free
GPU         none  ->  Cycles runs CPU-only
Python      3.11.15 (system), 3.11.15 (Blender bundled, numpy 1.26.4)
Node        v22.22.2, npm 10.9.7
Blender     4.5.14 LTS at /opt/blender/blender (MD5-verified official tarball)
Claude Code 2.1.273 CLI at /opt/node22/bin/claude
```

**Critical environment finding.** `BLENDER_EEVEE_NEXT` cannot run here: it
requires `libEGL.so.1` and a GPU/EGL context, and aborts the Blender process on
this headless box. **Cycles CPU is therefore the only render engine**, and the
render presets are sample-count tiers rather than an EEVEE/Cycles switch.
Cycles' OpenImageDenoise makes low-sample CPU previews genuinely usable. This is
detected at runtime by `blender_worker/scripts/engine_probe.py`; the backend
reports the available engines through `GET /api/system` and the UI shows them.

---

## 3. Component architecture

```
                              USER (browser, localhost:5173)
                                        |
                                   REACT FRONTEND
                        viewport · parameters · chat · jobs
                                        |
                              HTTP + SSE (localhost:8000)
                                        |
                             FASTAPI APPLICATION LAYER
                                        |
        +--------------+----------------+----------------+--------------+
        |              |                |                |              |
   AI ASSISTANT   JOB MANAGER     PROJECT STORE     ASSET STORE    EVENT BUS
   (adapter)      (queue+worker)  (SQLite)          (disk)         (SSE)
        |              |
   DESIGN PLANNER  PIPELINE STAGES
   (NL -> command)     |
                       v
              +-----------------------------------+
              |     DESIGN ENGINE (pure Python)   |   no Blender, no I/O
              |  flower engine -> split engine    |   deterministic, unit-tested
              |  -> geometry kernel -> validation |
              +-----------------------------------+
                       |  mesh bundle (.npz)
                       v
              +-----------------------------------+
              |   BLENDER WORKER (subprocess)     |   scene · materials · lights
              |   cameras · render · .blend · GLB |   cameras · Cycles CPU
              +-----------------------------------+
                       |  PNG · GLB · BLEND · STL · SVG
                       v
                   ASSET STORE  ->  INTERACTIVE VIEWER
```

### 3.1 The central architectural decision

**All geometry is computed in pure Python with NumPy. Blender never generates or
splits geometry; it only presents it.**

This is the single most important choice in the system, and it is deliberate:

- **Robustness.** Blender boolean modifiers are the classic failure point of
  procedural pipelines — they fail on coplanar faces, non-manifold input, and
  near-degenerate geometry, and their failures are opaque. The split is instead
  an exact per-triangle plane-clip (§8), which cannot fail in that way.
- **Testability.** The entire flower and split engine runs under plain `pytest`
  in milliseconds, with no Blender process and no GPU. See `tests/unit/`.
- **Determinism.** Same config + same seed + same generator version = identical
  vertex buffers, byte for byte. Verified by `tests/unit/test_determinism.py`.
- **Speed.** Regenerating a flower takes ~0.4 s. Launching Blender costs ~1.5 s
  before any work happens, so keeping it off the hot path matters.
- **Licence hygiene.** `bpy` is GPL. Keeping the design engine free of `bpy`
  imports keeps the core engine cleanly separated (§16.3).

Blender's job is what Blender is uniquely good at: physically-based materials,
studio lighting, camera framing, Cycles rendering, `.blend` authoring for the
client, and glTF export.

---

## 4. Module responsibilities

### `design_engine/` — pure geometry, no side effects

| Module | Responsibility |
|---|---|
| `configurations/schema.py` | Pydantic models: `FlowerConfig`, `SplitConfig`, `MaterialConfig`, `RenderConfig`, `DesignConfig`. Validation, ranges, defaults, presets. |
| `geometry/mesh.py` | `Mesh` value type: float32 `(V,3)` verts, int32 `(F,3)` faces, per-face `part_id`. Concat, transform, volume, area, bbox, weld, degenerate filter. |
| `geometry/curves.py` | Cubic Bézier / Catmull-Rom sampling, arc-length reparameterisation, offsetting. |
| `geometry/ruffle.py` | Edge-ruffle and cupping displacement fields shared by petals and centre. |
| `petals/profile.py` | Petal outline families (`ovate`, `spoon`, `notched`) as width functions `w(u)`. |
| `petals/petal.py` | Builds one petal as a **closed solid shell** (top surface + offset bottom surface + rim), with curl, ruffle, twist, thickness. |
| `flower/marigold.py` | The canonical master flower: layer schedule, phyllotaxis placement, per-petal jitter, assembly. |
| `flower/center.py` | Domed centre of tightly-packed disc florets. |
| `flower/base.py` | Structural base disc that carries the petals (the piece that gives each half physical integrity). |
| `splitting/paths.py` | Split path families: `balanced`, `s_river` (editable Bézier), `organic`. All are `x = f(y)` functions. |
| `splitting/splitter.py` | The split kernel (§8). Exact triangle clipping + boundary-surface capping. |
| `splitting/validate.py` | Geometry validation suite (§9). |

### `blender_worker/` — presentation only

| Module | Responsibility |
|---|---|
| `scripts/build_scene.py` | Entry point run by `blender -b -P`. Reads a job spec JSON, imports the mesh bundle, builds collections, applies materials/lights/cameras, renders, exports, saves. |
| `materials/library.py` | Named material presets (matte felt, satin silk, brushed metal, enamel) as Principled BSDF node graphs. |
| `lighting/studio.py` | Three-point softbox rig + gradient world. No HDRI download required. |
| `cameras/presets.py` | `top`, `front`, `side`, `three_quarter`, `closeup`, `hero`. Consistent framing across concepts. |
| `rendering/presets.py` | `preview` (24 spp, 640²), `standard` (96 spp, 1200²), `high` (320 spp, 1800²). All Cycles CPU + OIDN. |
| `exports/exporters.py` | GLB, STL, OBJ, SVG silhouette, `.blend`. |

### `backend/app/` — orchestration

| Module | Responsibility |
|---|---|
| `core/config.py` | Paths, Blender discovery, limits. No hardcoded Blender path — resolved at runtime. |
| `core/security.py` | Path-traversal-safe asset resolution, input guards. |
| `database/` | SQLite schema, migrations, connection handling. |
| `projects/` | Projects, concepts CRUD. |
| `versions/` | Version graph, diffing, restore, approval locks. |
| `jobs/` | Persistent queue, worker process pool, cancellation, retry, stale recovery. |
| `events/` | In-process pub/sub fanned out over SSE. |
| `agents/` | AI provider adapter, command schema, NL→command translation, refinement loop. |
| `assets/` | Asset registration, verification, serving. |
| `api/` | HTTP routes. Thin — no heavy work in request handlers. |

---

## 5. Data flow

### 5.1 Parameter change → new geometry

```
UI slider (debounced, explicit "Apply")
  -> PATCH /api/concepts/{id}/config        (validated by Pydantic)
  -> version created (parent = current)
  -> POST /api/jobs {type: GENERATE}
  -> queued in SQLite, worker picks it up
  -> stage events streamed over SSE as they genuinely occur
  -> design_engine builds master flower           [CPU, ~0.4 s]
  -> split engine partitions into piece_a/piece_b [CPU, ~0.3 s]
  -> validation suite runs                        [CPU, ~0.1 s]
  -> mesh bundle written to tmp/
  -> Blender subprocess: scene + materials + GLB  [~4 s]
  -> optional render                              [preview ~20 s CPU]
  -> outputs verified on disk (exists + non-empty + parseable)
  -> assets published from tmp/ into the version directory (atomic rename)
  -> SSE "job.completed" with asset URLs
  -> viewer reloads the GLB
```

### 5.2 Staged invalidation

The pipeline is staged so that cheap changes stay cheap. Each stage declares
which config sections it depends on; changing a section invalidates that stage
and everything downstream, nothing upstream.

| Stage | Depends on | Invalidated by a camera change? |
|---|---|---|
| `MASTER_FLOWER` | `flower` | no |
| `SPLIT` | `flower`, `split` | no |
| `VALIDATE` | `flower`, `split` | no |
| `SCENE` | + `material` | no |
| `VIEWER_EXPORT` | + `material` | no |
| `RENDER` | + `render` (camera, lighting, quality) | **yes — and only this stage** |

Stage outputs are content-addressed: the cache key is a SHA-256 of the
canonicalised config subset each stage depends on, plus the engine version. A
camera change therefore re-renders without touching a single vertex, and a
material change skips the flower and split engines entirely. Implemented in
`backend/app/jobs/pipeline.py`.

---

## 6. API contracts

Base: `http://127.0.0.1:8000`. Localhost-bound by default (§16).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/system` | Environment probe: Blender path/version, engines, CPU, RAM, disk, AI provider status. |
| `GET` | `/api/projects` | List projects. |
| `GET` | `/api/projects/{id}` | Project detail + milestone state. |
| `GET` | `/api/concepts` | Concept library (thumbnails, status). |
| `POST` | `/api/concepts` | Create concept. |
| `POST` | `/api/concepts/{id}/duplicate` | Duplicate. |
| `PATCH` | `/api/concepts/{id}` | Rename / archive / unarchive. |
| `GET` | `/api/concepts/{id}/versions` | Version graph. |
| `POST` | `/api/concepts/{id}/versions` | Commit a config change as a new version. |
| `GET` | `/api/versions/{id}` | Version detail: config, assets, validation. |
| `GET` | `/api/versions/{a}/diff/{b}` | Parameter-level diff. |
| `POST` | `/api/versions/{id}/restore` | Restore into a new version (never destructive). |
| `POST` | `/api/versions/{id}/approve` | Mark approved (locks against overwrite). |
| `POST` | `/api/jobs` | Enqueue `GENERATE` / `RENDER` / `EXPORT` / `REFINE`. |
| `GET` | `/api/jobs` | Queue + history. |
| `GET` | `/api/jobs/{id}` | Job detail, stages, logs. |
| `POST` | `/api/jobs/{id}/cancel` | Cooperative cancel + process kill. |
| `POST` | `/api/jobs/{id}/retry` | Re-enqueue with same spec. |
| `GET` | `/api/events` | **SSE stream** of all job/stage/log events. |
| `POST` | `/api/assistant/message` | NL instruction → validated command plan. |
| `GET` | `/api/assistant/history` | Instruction history. |
| `POST` | `/api/refine/start` | Start a bounded refinement run. |
| `POST` | `/api/refine/{id}/stop` | Stop it. |
| `GET` | `/api/assets/{version_id}/{name}` | Serve an asset (path-guarded). |
| `POST` | `/api/exports` | Build a deliverable bundle. |
| `POST` | `/api/references/import` | Import client references (images, PPTX). |

### 6.1 SSE event envelope

```jsonc
{
  "seq": 412,                      // monotonic, lets the client detect gaps
  "ts": "2026-09-16T14:52:03.114Z",
  "type": "job.stage",             // job.queued|started|stage|log|progress|completed|failed|cancelled
  "job_id": "job_01J...",
  "payload": {
    "stage": "SPLIT",
    "status": "running",
    "message": "clipping 43120 triangles against split path",
    "index": 3, "total": 9
  }
}
```

Progress is only ever emitted from a real observed source: a completed pipeline
stage, or a parsed Cycles `Sample N/M` line from the Blender subprocess's stdout.
**There are no timer-driven progress bars anywhere in this system.** When no
numeric progress is available, the UI shows the current operation name instead.

---

## 7. Configuration schema

`DesignConfig` is the single source of truth for a design. It is the unit of
versioning, diffing, hashing, and AI mutation.

```python
DesignConfig
├── flower: FlowerConfig
│     diameter_mm, petal_count_base, layer_count, petal_density,
│     petal_length_ratio, petal_width_ratio, petal_curvature, petal_ruffle_amp,
│     petal_ruffle_freq, petal_overlap, layer_tilt_gain, center_diameter_ratio,
│     center_dome_height, thickness_mm, relief_depth_mm, organic_variation, seed
├── split: SplitConfig
│     type: balanced | s_river | organic
│     position, orientation_deg, amplitude, smoothness, control_points[],
│     separation_mm, boundary_tolerance_mm, organic_octaves, organic_roughness
├── material: MaterialConfig
│     preset, base_color, secondary_color, roughness, metallic, sheen, finish
└── render: RenderConfig
      quality: preview | standard | high
      camera: top | front | side | three_quarter | closeup | hero
      lighting: studio_soft | dramatic | flat_catalog
      resolution, background
```

Every numeric field carries min/max/step/unit/description metadata, which the
frontend reads from `GET /api/schema` to build the parameter editor
**generatively** — one schema, no duplicated UI constants, no drift.

---

## 8. Geometry strategy — the split kernel

This is the most important technical subsystem, and the requirement is strict:
**two genuinely separate meshes**, not a texture, not a painted line.

### 8.1 Split path

A split path is a planar curve in XY expressed as a **function of y**:

```
x = f(y),  y ∈ [-R_ext, +R_ext]
```

Requiring `f` to be a function of `y` (rather than an arbitrary parametric curve)
buys a guarantee that matters: the curve divides the plane into exactly two
simply-connected regions, so `sign(x - f(y))` is a well-defined two-way
classifier with no self-intersection ambiguity. Orientation is handled by
rotating the whole flower by `-orientation_deg`, splitting, then rotating back —
so an "angled" split needs no special case.

| Type | `f(y)` |
|---|---|
| `balanced` | `p + a·y` — straight or gently sheared. |
| `s_river` | Cubic Bézier through 4 control points, sampled and arc-length reparameterised, then resampled as `f(y)`. Amplitude, smoothness, and the control points are all user-editable. |
| `organic` | Bézier spine + summed value-noise octaves (seeded), giving an irregular, petal-aware wander. |

### 8.2 The kernel

```
split_flower(master: Mesh, cfg: SplitConfig) -> SplitResult
    piece_a, piece_b, split_path, metadata, validation
```

1. **Signed field.** For each vertex `v`, `s(v) = v.x − f(v.y)`. Cheap, exact,
   vectorised.
2. **Exact triangle clipping.** For each triangle, classify its 3 vertices by
   `sign(s)`:
   - all positive → whole triangle to A
   - all negative → whole triangle to B
   - mixed → compute the two edge-crossing points by linear interpolation of `s`
     (so the cut vertices lie *exactly* on `s=0`), then emit 1 triangle on one
     side and 2 on the other. This is a Sutherland–Hodgman clip specialised to
     triangles.

   Because crossing points are computed once per edge and shared, the two pieces
   have **identical, coincident cut boundaries** — complementary by construction.
3. **Boundary surface.** The cut runs along the *ruled vertical surface* swept by
   `f` in z. That surface is developable, so it can be flattened exactly to 2D
   using `(t, z)` where `t` is arclength along the path. Cut edges are chained
   into closed loops, mapped to `(t, z)`, triangulated there, and mapped back to
   3D. This produces a real, intentional boundary wall on each piece — the two
   pieces are closed solids, not open shells with a hole where the cut was.
4. **Separation.** For the exploded view, A and B are translated ±`separation/2`
   along the path's average normal. The assembled configuration keeps them
   coincident.

### 8.3 Why this beats CSG here

| | Blender boolean | This kernel |
|---|---|---|
| Coplanar/degenerate input | frequent silent failure | handled by construction |
| Determinism | build-dependent | exact, bitwise reproducible |
| Requires Blender | yes | no |
| Unit-testable | awkward | trivially |
| Complementary boundaries | not guaranteed | guaranteed (shared cut vertices) |
| Bridging geometry | possible | impossible by construction |
| Speed (43k tris) | seconds | ~0.25 s |

The petals are built as closed solid shells precisely so that clipping them
yields closed solids. Nothing "bridges" the two pieces, because every triangle is
either wholly on one side or exactly subdivided at the boundary.

---

## 9. Validation strategy

`splitting/validate.py` runs after every generation. Results are stored on the
version and shown in the UI. Checks are **measurements, not opinions** — there is
no invented "beauty score".

| Check | Method | Pass criterion |
|---|---|---|
| `master_nonempty` | vertex/face counts | > 0 |
| `pieces_nonempty` | both pieces | > 0 verts and > 0 faces each |
| `volume_conservation` | `|V(A)+V(B) − V(master)| / V(master)` | < 1 % |
| `area_conservation` | surface area minus the two new cut walls | < 2 % |
| `no_cross_contamination` | no vertex of A has `s < −tol`, none of B has `s > +tol` | 0 violations |
| `no_bridging` | no connected component spans both sides | 0 components |
| `pieces_separable` | A and B bounding prisms disjoint at separation distance | true |
| `components_addressable` | each piece exports independently and re-imports | true |
| `footprint_reconstruction` | Shapely union of A∪B footprint vs master footprint, symmetric difference | < 2 % of master area |
| `degenerate_faces` | triangle area > ε | count reported, must be 0 after filtering |
| `normals_consistent` | trimesh winding check | reported |
| `manifold` | trimesh edge-manifold check | **reported, not enforced** — decorative surfaces may legitimately be open (Part 27). |

Render checks: file exists, non-zero, opens in Pillow, matches requested
resolution, and is not a blank frame (luminance variance above a floor — catches
"camera pointing at nothing" failures, which is a real and common bug).

---

## 10. Job management

- **Persistent SQLite queue.** Jobs survive a backend restart.
- **Dedicated worker.** A background thread dequeues and runs the pipeline;
  Blender always runs as a **subprocess**, never inside a request handler.
- **Concurrency = 1 by default.** With 4 cores and CPU-only Cycles, a second
  concurrent render halves the speed of both. Configurable, deliberately low.
- **Deduplication.** A job whose `(concept, stage-hash)` matches an active job is
  coalesced rather than queued twice.
- **Cancellation.** Cooperative flag checked between stages + `SIGTERM` then
  `SIGKILL` to the Blender process group.
- **Timeouts.** Per-stage, scaled to the render preset.
- **Stale recovery.** On startup, jobs left `running` are marked `interrupted`,
  never `completed`.
- **Atomic publication.** All work happens in `tmp/job_<id>/`; assets are
  verified, then moved into the version directory with `os.replace`. A failed job
  never leaves a half-written asset where a good one used to be.

---

## 11. Version control

A concept owns a **DAG** of versions. Each version stores: id, parent id, full
config snapshot (JSON), asset manifest, validation results, change description,
author (`user` | `assistant` | `refiner`), timestamp, and flags
(`preferred`, `approved`).

- Restore creates a **new** version whose config equals the old one — history is
  append-only and nothing is ever destroyed.
- Approved versions are write-locked; a job targeting one is refused with a clear
  error unless the caller explicitly passes `force_unlock`.
- Branching is implicit: committing from a non-tip version forks the DAG.

---

## 12. AI provider abstraction

```python
class AIProvider(Protocol):
    name: str
    def available(self) -> ProviderStatus: ...
    def complete(self, system: str, user: str, *, json_schema: dict | None) -> str: ...
    def supports_vision(self) -> bool: ...
```

Implementations, tried in order:

1. **`ClaudeCodeCLIProvider`** — invokes the locally installed `claude` binary in
   non-interactive mode (`claude -p --output-format json`) as a subprocess. This
   is the officially supported headless entry point of the CLI that is already on
   this machine. **Verified at runtime**, not assumed: `GET /api/system` reports
   the actual probe result, including the failure reason if it fails.
2. **`LocalOpenAICompatProvider`** — any OpenAI-compatible local server (Ollama,
   llama.cpp, LM Studio) at a configurable base URL. Off unless configured. The
   app never downloads model weights on its own.
3. **`ManualHandoffProvider`** — always available, never fails. It renders the
   exact prompt for the user to paste into any assistant, and accepts the JSON
   command plan back through the UI. This is the honest fallback that keeps the
   feature usable with **zero** AI access.

The design engine has no dependency on any provider. Every operation the
assistant can perform is also reachable directly from the UI. **The application
is fully functional with no AI at all.**

### 12.1 Command schema

The assistant never executes code or shell commands. It emits JSON that is
validated against a closed set of command types before anything runs:

```
UPDATE_FLOWER_PARAMETER · UPDATE_SPLIT_PARAMETER · UPDATE_MATERIAL_PARAMETER
GENERATE_VARIATION · GENERATE_CONCEPT · RENDER_PREVIEW · RENDER_FINAL
COMPARE_VERSIONS · RESTORE_VERSION · RUN_VALIDATION · EXPORT_ASSETS
```

Unknown command types, unknown parameter names, and out-of-range values are all
rejected before they reach the pipeline, with the rejection reported to the user.
A model that hallucinates a parameter cannot corrupt a design.

---

## 13. Recursive improvement

Bounded, hypothesis-driven, and never random:

```
GENERATE -> VALIDATE -> MEASURE -> pick the worst measured weakness
   -> form a specific hypothesis (parameter + direction + expected effect)
   -> apply -> regenerate -> re-measure -> KEEP if the target metric improved
      and nothing else regressed, else REVERT and try the next hypothesis
```

Weaknesses are drawn from **measured** quantities — petal-count-to-diameter
ratio, silhouette raggedness, split-boundary length, piece area balance, relief
depth variance, layer occlusion — not from vibes. Each iteration is recorded as a
version with its hypothesis and outcome, so the whole run is auditable.

Hard limits (all user-configurable): max iterations, max wall-clock, max render
seconds, max disk, plus a stop button. Terminates on approval, limit, budget
exhaustion, repeated failure, or **no demonstrated improvement** across two
consecutive iterations.

---

## 14. Error handling

Every failure mode below is explicitly handled, surfaced in the UI with a
human-readable message plus a technical detail pane, and logged:

Blender missing · Blender non-zero exit · Blender crash (signal) · invalid
config · empty mesh · split produced an empty piece · degenerate split path ·
render timeout · out of memory · corrupt/zero-byte output · interrupted job ·
DB locked · AI provider unreachable · AI returned unparseable JSON · AI command
rejected by schema · disk full.

Invariant: **a failed job never mutates the last good version.** Work is done in
a temp directory and published only after verification.

---

## 15. Performance

- Content-addressed stage caching (§5.2) — the dominant win.
- Preview renders at 640² / 24 spp for exploration; high quality only on demand.
- Vectorised NumPy throughout; no Python loops over vertices in hot paths.
- Blender started once per job, not once per stage.
- GLB is Draco-free but decimated for the viewer when triangle count is high.
- `tmp/` swept on startup and after each job.
- Concurrency 1 on this 4-core, GPU-less box.

---

## 16. Security boundaries

1. Binds to `127.0.0.1` by default. Exposure requires an explicit env var.
2. CORS restricted to the local dev origin.
3. **All** filesystem access goes through `core/security.py::safe_asset_path`,
   which resolves and asserts containment within the project root. Path traversal
   is rejected, symlinks resolved before the check.
4. The assistant cannot execute shell commands. It produces schema-validated JSON
   only. There is no `eval`, no `exec`, no shell-string interpolation anywhere in
   the command path.
5. Blender subprocesses are launched with an argument list (never `shell=True`),
   with a restricted CWD and a timeout.
6. No secrets in frontend code; no credentials logged.
7. Uploaded references are size- and type-checked, stored under the project root,
   and **never** transmitted anywhere.
8. No account, licence key, or network call is required for any core function.
   The app runs fully offline once installed.

### 16.3 Blender licensing note

Blender is GPL-2.0-or-later. AFRi Studio invokes `blender` as a **separate
process** over a file/CLI boundary and does not link, embed, or import `bpy` into
the application. The scripts that run *inside* Blender live in `blender_worker/`
and are themselves GPL-licensed, and are documented as such in `LICENSES.md`.
This is the same arrangement used by every render farm and pipeline tool.

---

## 17. Testing strategy

| Tier | Scope | Needs Blender? |
|---|---|---|
| `tests/unit/` | Geometry kernel, split maths, curves, schema validation, determinism, command parsing. Fast (< 5 s total). | no |
| `tests/integration/` | API routes, job lifecycle, version graph, SSE, asset guards, Blender scene build + real render. | partly |
| `tests/end_to_end/` | Full pipeline: config → geometry → split → validate → .blend → render → GLB → served asset, asserting real files on disk. | yes |

Tests assert on **artefacts**, not on log lines: files exist, are non-empty,
parse, and have the expected resolution/triangle counts.

---

## 18. Future extensibility

- **Stage Two (hat)** — planned in `future/HAT_INTEGRATION_PLAN.md`, not built.
- New split families are a single function in `splitting/paths.py` plus a schema
  enum entry; the kernel is agnostic to which curve it clips against.
- New flower species would subclass the layer-schedule generator.
- The AI adapter accepts new providers without touching the design engine.
- The `references/` import path is built for the client's PowerPoint when it
  arrives.

---

## 19. Definition of done (Stage One)

Tracked honestly in `PROGRESS.md`, with verified evidence for each item. Nothing
is reported as complete until its artefact has been inspected on disk.
