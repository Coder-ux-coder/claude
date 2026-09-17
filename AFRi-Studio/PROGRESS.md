# AFRi Studio — progress

**Stage One: standalone two-piece marigold concepts.**
Stage Two (hat) has **not** been started.

Last updated at the end of the build session that created this repository.
Every claim below was verified by running the thing and inspecting the output.
Where something is incomplete or constrained, it says so.

---

## Milestones

| # | Milestone | State | Evidence |
|---|---|---|---|
| 1 | Environment ready | **done** | Blender 4.5.14 LTS installed from the official tarball, MD5 verified against `blender-4.5.14.md5`. Background mode, `bpy`, array meshing, Cycles render, `.blend` save and glTF export all exercised and their output files inspected. |
| 2 | Architecture ready | **done** | `ARCHITECTURE.md`; backend, frontend and design engine scaffolded and running. |
| 3 | Minimal vertical slice | **done** | Config → flower → split → `.blend` → render → GLB → served to the browser, end to end, with real stage events. |
| 4 | Advanced flower engine | **done** | 157 petals in 7 rows, 131k triangles, ~1.2 s. Every petal is a watertight closed solid. |
| 5 | Split engine | **done** | All three families. Both pieces watertight, zero open edges, volume conserved to 0.000000%. |
| 6 | Professional interface | **done** | Full workspace, screenshotted in a real browser. |
| 7 | Workflow monitoring | **done** | Persistent SQLite queue, SSE stream, cancel, retry, restart recovery. |
| 8 | AI integration | **done** | Claude Code CLI headless mode, verified live. Local-model and manual-handoff fallbacks. |
| 9 | Recursive improvement | **done** | Bounded, hypothesis-driven, measured. |
| 10 | Concept generation | **done** | Concepts A, B and C, all from one master flower. Each 17/17 checks, 14 assets, ~200 s. |
| 11 | Final rendering | **done** | 18 renders (6 views x 3 concepts), zero missing, plus a 1648x1778 comparison sheet. |
| 12 | Client delivery | **done** | 10-page PDF (580 KB), 6-slide editable PPTX, delivery notes, exportable bundles. |
| 13 | Application testing | **done** | 112 tests executed and passing: 81 unit, 23 integration, 8 end-to-end. |
| 14 | User review | **awaiting you** | Concepts are ready to look at. Stage Two needs your explicit go-ahead. |

---

## What was verified, and how

### The split kernel — the part that mattered most

The brief's hard requirement was two genuinely separate meshes, not a texture or
a drawn line. Measured on the reference configuration, for all three split
families:

| Measure | Result |
|---|---|
| `|V(A) + V(B) − V(master)| / V(master)` | **0.000000 %** |
| Open edges, piece A / piece B | **0 / 0** |
| Non-manifold edges | **0** |
| Cap failures | **0** |
| Bodies physically divided | 7–9 of 57 |
| Validation checks | **17 / 17** |
| Time to split 131k triangles | ~0.5 s |

Volume conservation being *exactly* zero is not luck: clipping subdivides
triangles without losing area, and the cut walls added to the two pieces have
opposite winding and cancel. It is a strong check that nothing was dropped or
double-counted.

### Bugs found and fixed during the build

Recorded because they shaped the design:

1. **Petal tips read as squared keyholes.** The tip was rounded in *width*
   while a notch pulled the centre back, leaving the two edges furthest
   forward. Fixed by rounding the tip in *length* instead. There is now a test
   asserting the tip centre leads its edges.
2. **The flower curled into a bowl.** Outer petals inherited the same curl as
   inner ones. Curl and tilt now ramp inward from the outer row.
3. **Outer petals floated free.** The structural base disc was smaller than the
   outermost petal root radius, so the outer row was physically unattached. The
   disc now always reaches past it.
4. **The camera cropped the subject.** Distance was a hand-tuned multiple of
   radius; it is now derived from focal length and sensor size.
5. **Cut boundaries would not close.** Four successive causes: duplicate cap
   vertices, triangles with a vertex exactly on the cut, ear clipping stalling
   on slivers, and loops meeting at a shared vertex. Resolved by splitting one
   body at a time, deriving the cap outline from the piece's own topology,
   guaranteeing ear-clip progress, and perturbing the path off any vertex.
6. **The viewer showed the back of the flower.** The GLB is exported Y-up and
   the viewport rotated it again. Removed.
7. **Angled splits failed validation.** Pieces are rotated back to world space,
   but validation tested them against the split-frame path. `SplitPath` now
   carries its orientation and exposes `signed()`. Regression test covers six
   orientations.
8. **A live job's temp directory was deleted.** Worker startup swept *all*
   `tmp/pipe_*`, so booting a second process destroyed a running pipeline's job
   spec. The sweep now skips directories whose owning process is alive.
9. **The contamination tolerance was wrong in principle.** Crossing points are
   interpolated along triangle edges, so a curved cut is a chord of the path and
   sits slightly off it — real geometry, not error. The tolerance is now derived
   from the chord across the widest edge span instead of being a guessed constant.

### Environment constraints found

- **No GPU on this machine.** `BLENDER_EEVEE_NEXT` requires `libEGL` and a GPU
  context and *aborts the Blender process* when absent. Cycles CPU is therefore
  the only engine, and the render presets are sample-count tiers rather than an
  engine switch. This is detected at runtime and reported in `/api/system` and
  in the UI.
- A 900 px, 24-sample preview of a 131k-triangle flower takes ~30–45 s on four
  cores. Geometry and splitting together take under two seconds, which is why
  they were kept off the Blender path.

---

## Honest limitations

- **The concepts are provisional.** AFRi's reference PowerPoint was not
  available. Colours, proportions and construction are studio assumptions,
  labelled as such in the UI and in the client presentation. No claim is made
  that any concept matches AFRi's design language.
- **No manufacturing assessment.** STL and OBJ exports are geometry. Wall
  thickness, tolerances, draft and process constraints have not been evaluated.
- **No automated visual inspection.** The Claude Code CLI's headless mode is
  used for text, and this build did not wire image input through it. Aesthetic
  judgement in this session came from a human-equivalent look at the actual
  renders — which is how the petal, curl, base-disc and camera faults above
  were caught. The application does not claim to have inspected images it
  could not see.
- **Preview-quality concept renders.** The delivered set is 900 px at 24
  samples with denoising, which is honest exploration quality. Re-running
  `scripts/generate_concepts.py --quality high --resolution 1800` produces
  presentation-grade output; it takes substantially longer on a CPU-only box.
- **Concurrency is 1.** Deliberate on four cores with CPU-only Cycles.

---

## Verified artefacts

Everything below was inspected on disk, not merely reported by a log line.

| Artefact | Verified |
|---|---|
| Three concepts | 17/17 validation checks each; 14 assets each |
| Renders | 18 PNGs at 900x900, each opened, sized and checked for a blank frame |
| Browser models | 3 GLB files, each starting with the `glTF` magic number |
| Blender projects | 3 `.blend` files, each starting with `BLENDER` |
| Component meshes | `piece_a` and `piece_b` as STL and OBJ per concept, each re-imported as a real mesh with distinct bounds |
| Comparison sheet | `deliverables/comparison_all_concepts.png`, 1648x1778 |
| Presentation | 10-page PDF, page structure confirmed by text extraction and two pages rendered and inspected |
| Editable deck | 6-slide PPTX, 12 embedded images |
| Interface | Screenshotted in a real Chromium session; zero console errors |
| Component toggles | Hiding piece B measurably removed 27.5% of rendered pixels; re-showing restored the exact original pixel count |

### Test suite

```
tests/unit          81 passed   (~22 s, no Blender)
tests/integration   23 passed   (~10 s, includes real Blender scene build + render)
tests/end_to_end     8 passed   (~30 s, full pipeline to verified files)
                   ---
                   112 passed
```

---

## Next

Stage Two is planned in `future/HAT_INTEGRATION_PLAN.md` and **will not be
started without your explicit authorisation**.
