# Dependency and asset licence manifest

AFRi Studio is built entirely on free and open-source software. No component
requires a paid API, a cloud service, a commercial CAD tool, a subscription, or
a purchased asset. The application runs fully offline once installed.

## Runtime — Python

| Package | Licence | Role |
|---|---|---|
| FastAPI | MIT | HTTP API |
| Starlette | BSD-3-Clause | ASGI framework under FastAPI |
| Uvicorn | BSD-3-Clause | ASGI server |
| Pydantic | MIT | Configuration schema and validation |
| NumPy | BSD-3-Clause | All geometry maths |
| SciPy | BSD-3-Clause | Connectivity queries; nearest-face provenance after the boolean |
| Shapely | BSD-3-Clause | 2-D footprint helpers |
| trimesh | MIT | Independent mesh verification; boolean front end |
| manifold3d | Apache-2.0 | Exact boolean union that fuses the flower into one solid |
| Pillow | MIT-CMU | Render verification, comparison image |
| ReportLab | BSD-3-Clause | Client PDF |
| python-pptx | MIT | Editable PPTX, and PowerPoint reference import |
| httpx | BSD-3-Clause | Optional local-AI provider transport |
| pytest | MIT | Test runner |
| SQLite | Public domain | Database (Python standard library) |

## Runtime — JavaScript

| Package | Licence | Role |
|---|---|---|
| React, React DOM | MIT | UI |
| TypeScript | Apache-2.0 | Types |
| Vite | MIT | Dev server and build |
| Tailwind CSS | MIT | Styling |
| PostCSS, Autoprefixer | MIT | CSS pipeline |
| three.js | MIT | 3-D viewport |
| @react-three/fiber | MIT | React renderer for three.js |
| @react-three/drei | MIT | Viewport helpers (grid, controls) |
| zustand | MIT | State |
| Playwright | Apache-2.0 | Browser tests (dev only) |

## External tools

| Tool | Licence | How it is used |
|---|---|---|
| **Blender 4.5 LTS** | **GPL-2.0-or-later** | Invoked as a **separate process** for scene assembly, materials, lighting, cameras, Cycles rendering, `.blend` authoring and glTF/STL/OBJ export. |
| Claude Code CLI | Proprietary (Anthropic) | **Optional.** Used through its supported headless mode for the design assistant, on the user's existing Claude Code plan. No API key is used or requested. Every feature works without it. |

### Note on the Blender licence

Blender is GPL. AFRi Studio does **not** link against, embed, or import `bpy`
into its own process. It runs the `blender` executable as a subprocess and
communicates over a file and CLI boundary — the same arrangement used by render
farms and pipeline tools. The scripts that run *inside* Blender live in
`blender_worker/` and are themselves GPL-2.0-or-later. The rest of the
application is independent of Blender's licence.

## Fonts

Inter and JetBrains Mono are loaded from Google Fonts when online, both under
the SIL Open Font License 1.1. The interface falls back to system fonts when
offline, so no font file is bundled or required.

## Assets

**No third-party 3-D assets, textures, HDRIs or purchased models are used.**
Every piece of geometry is generated procedurally by `design_engine/`, and the
studio environment is built from Blender primitives and a procedural gradient
world — there is no HDRI to download.

## Generated output

Geometry, renders, `.blend` files and documents produced by this application are
the user's own work product. Nothing in this repository asserts a claim over them.
