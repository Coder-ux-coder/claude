# AFRi Studio

A local-first AI product design studio for **two-piece marigold flower
accessories**. It generates a procedural marigold, divides it into two genuinely
separate solids along an editable curve, renders it in Blender, and packages the
result as client-ready concepts.

Everything runs on your own machine. No paid API, no cloud rendering, no
commercial CAD tool, no subscription. The core application works fully offline.

---

## What it actually does

```
configuration ─> marigold engine ─> split engine ─> validation
                    (NumPy)          (NumPy)         (measured)
                                          │
                                          ▼
                          Blender ─> .blend · GLB · PNG · STL · OBJ
                          (subprocess, Cycles CPU)
                                          │
                                          ▼
                    React workspace: 3-D viewport · parameters
                    assistant · jobs · versions · exports
```

The split is the heart of it. Two pieces are produced by exact per-triangle
clipping against the vertical surface swept by the dividing curve — not by a
boolean modifier, and certainly not by a painted line. On the reference
configuration both pieces come out as **closed, watertight solids with zero open
edges**, and their volumes reconstruct the master to **0.000000 %**.

---

## Requirements

| | |
|---|---|
| Python | 3.11+ |
| Node.js | 18+ (22 tested) |
| Blender | 4.5 LTS — [blender.org/download](https://www.blender.org/download/) |
| RAM | 8 GB minimum, 16 GB comfortable |
| GPU | **Not required.** Rendering is Cycles on the CPU. |

## Install

```bash
cd AFRi-Studio

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cd frontend && npm install && cd ..
```

Blender is found automatically at the usual locations. If yours is elsewhere:

```bash
export AFRI_BLENDER=/path/to/blender
```

## Run

Two terminals:

```bash
# backend — http://127.0.0.1:8000
.venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000

# frontend — http://127.0.0.1:5173
cd frontend && npm run dev
```

Open **http://127.0.0.1:5173**. The top bar shows whether Blender and the AI
assistant were actually detected; it reports what it found, not what it hopes.

## Generate the three concepts from the command line

```bash
.venv/bin/python scripts/generate_concepts.py --quality preview --resolution 900 --meshes
.venv/bin/python scripts/build_comparison.py
.venv/bin/python scripts/build_presentation.py
```

Outputs land in `deliverables/`.

## Tests

```bash
.venv/bin/python -m pytest tests/unit          # geometry kernel, fast, no Blender
.venv/bin/python -m pytest tests/integration   # API, jobs, security, Blender
.venv/bin/python -m pytest tests/end_to_end    # full pipeline, needs Blender
```

Blender-dependent tests skip themselves cleanly when Blender is absent.

---

## The interface

| Area | What's there |
|---|---|
| **Workspace** | Interactive 3-D viewport (the real exported mesh) and the Blender renders side by side. Orbit, pan, zoom, four view presets, wireframe, assembled/separated, pieces/master, component selection, screenshot. |
| **Dashboard** | Active job with genuine progress, latest render, validation, a project timeline derived from real state, and the measured environment. |
| **Concepts** | Visual library with thumbnails, validation status, duplicate, compare, archive. |
| **History** | The full version DAG with parameter-level diffs, restore, prefer and approve. |
| **Exports** | Per-version assets, STL/OBJ export, and a zipped delivery bundle. |
| **Parameters** | Every parameter, generated from the backend schema, with ranges and descriptions. Changes apply explicitly — a slider never starts a Blender job on its own. |
| **Claude Designer** | Plain-language instructions become validated design commands. |
| **Jobs / Refinement / Event log** | Live SSE stream of what is actually happening. |

## The design assistant

Plain language in, real design changes out:

> *"Make the flower fuller and strengthen the S-curve of the split"*

becomes `petal_density 1.25 → 1.7`, `layer_count 7 → 9`,
`split.amplitude 0.3 → 0.55`, a new version, and a queued Blender job.

Three providers are tried in order:

1. **Claude Code CLI** — your existing Claude Code plan, through the CLI's
   supported headless mode (`claude -p --output-format json`). **No API key is
   used or requested.** Detected at runtime, not assumed.
2. **A local OpenAI-compatible server** — Ollama, llama.cpp, LM Studio. Off
   unless `AFRI_LOCAL_AI_URL` is set. The app never downloads model weights.
3. **Manual handoff** — always available. It shows you the exact prompt to paste
   into any assistant and accepts the JSON reply back, through the same
   validation and the same pipeline.

The assistant cannot execute code or shell commands. It emits JSON validated
against a closed command set; a hallucinated parameter is rejected with a reason
and never reaches the pipeline. **Every operation is also reachable from the UI,
so the application is fully functional with no AI at all.**

---

## Environment notes

Findings from the machine this was built on, which the app detects at runtime:

- **No GPU.** `BLENDER_EEVEE_NEXT` needs `libEGL` and a GPU context and aborts
  the Blender process on a headless box. **Cycles CPU is the only engine**, so
  the render presets are sample-count tiers (24 / 96 / 320 spp) rather than an
  engine switch. Cycles' OpenImageDenoise makes low-sample CPU previews usable.
- A preview render of a 130k-triangle flower takes roughly 30 s on four cores.
  Geometry generation and splitting together take under two seconds.

## Project layout

```
ARCHITECTURE.md      design decisions and rationale
PROGRESS.md          milestone state, honestly recorded
LICENSES.md          dependency and asset licences
design_engine/       pure-Python geometry: flower, petals, split, validation
blender_worker/      scene, materials, lighting, cameras, render, export
backend/app/         FastAPI, SQLite, jobs, events, versions, agents
frontend/src/        React workspace
tests/               unit · integration · end_to_end
projects/            project data, versions, assets
deliverables/        client-facing output
future/              HAT_INTEGRATION_PLAN.md — Stage Two, not implemented
```

## Stage

**Stage One** — standalone flower concepts. Complete.

**Stage Two** — hat modelling, placement and attachment. **Not started.** No hat
geometry exists anywhere in this repository. See `future/HAT_INTEGRATION_PLAN.md`.

## Scope and honesty

- The concepts are **provisional**. AFRi's reference material was not available,
  so colours, proportions and construction are studio assumptions, labelled as
  such in the UI and in the client presentation. No claim is made that any
  concept matches AFRi's design language.
- STL and OBJ exports are **geometry, not manufacturing data**. Wall thickness,
  tolerances and process constraints have not been assessed.
- Validation measures what can be measured. There is no invented beauty score.
