# AFRi Marigold Studio — browser build

A working parametric design application for the AFRi two-piece marigold accessory.
The real geometry engine, ported to JavaScript and running live on the page: same
layer schedule, same closed-solid petals, same exact per-triangle clipping split
kernel as `design_engine/`.

## Architecture

The page is a shell. Everything else is an ES module, loaded same-origin.

| File | Responsibility |
| --- | --- |
| `index.html` | Design tokens, layout, static shell. No application logic. |
| `app.js` | Composition root: state wiring, build pipeline, views, keyboard, capabilities. |
| `schema.js` | Every parameter with its bounds and its explanation. One table, read by the controls, the command palette, the designer's allow-list and the spec sheet. |
| `store.js` | The design document, its undo/redo history, and the listener bus. Only the design is undoable; camera and display state are not. |
| `viewport.js` | One instance per canvas: scene, lighting rig, materials, framing, scale, capture. |
| `views.js` | Library, Compare and Spec — renderers over a context object. |
| `library.js` | Persistence on the `db` capability, plus the private per-viewer workspace. |
| `designer.js` | Claude at the bench: the tool loop and the parameter allow-list. |
| `exporters.js` | Binary STL, ZIP, build report, spec model and spec sheet. |
| `ui.js` | Toasts, dialogs, command palette, sliders, selects. |
| `engine.js` | The geometry kernel, plus the hat and the fit analysis. Hand-ported from `design_engine/`, parity-tested against it. |
| `worker.js` | Runs `generateDesign` off the main thread. Two instances: the bench and the compare pane. |

## The four views

- **Bench** — the viewport, 44 parameters, live measurement, split verification and,
  once the hat is on, the fit report.
- **Compare** — the working design beside one off the shelf, cameras locked together,
  with the measured deltas and every parameter that differs listed underneath.
- **Library** — every design the team has saved, with a captured still, the measurements
  and who saved it.
- **Spec** — a manufacturing sheet generated from the built geometry, printable and
  exportable as a standalone HTML document.

## The fit report

A render cannot answer whether an accessory fits a hat — overlapping geometry looks
exactly like seated geometry. So the browser build now measures it, as a port of
`design_engine/assembly/contact.py`:

- **Interference** — how deep any part of the accessory sits inside the hat's outer skin.
- **Clearance** — closest approach and furthest gap across the flat underside.
- **Conformance error** — how far the flat back departs from the doubly curved brim
  *across* the footprint. Measured from the closest approach, so a deliberate standoff
  does not flatter it; this is the number that decides rigid versus conforming.
- **Footprint touching** — the fraction of the underside within the contact tolerance.
- **Past the brim edge** — how far the footprint overhangs, which is what rules a
  narrow brim out.

Distance is computed analytically against the hat's meridian, not by nearest-neighbour
search over the sampled skin: the skin is sampled at about 5.9 mm circumferentially, so
a nearest-point search would carry several millimetres of error — useless for judging a
sub-millimetre gap.

Two figures are bounds rather than measurements, and are labelled as such in the
interface: **mass** and the **brim moment**. Both depend on volume, and this build ships
the flower as overlapping closed shells, so its volume is overcounted wherever petals
intersect.

## Runtime capabilities

Each one is optional. The studio builds, measures, verifies and renders without any
of them; they are checked at run time and the affordances they drive stay hidden when
absent.

| Capability | What it gives the product |
| --- | --- |
| `db` | The shared design library, and each viewer's private workspace (`data/users/<id>/workspace`) so the bench is where they left it. |
| `user` | Attribution on saved designs, and the write-level check that decides whether to offer library controls. Only ids are stored; names are resolved per viewer on every render. |
| `sample` | Claude at the bench. Where the host offers tools, Claude moves parameters, rebuilds, and reads the measurements back — so it can converge on a target instead of guessing once. |
| `downloads` | STL pair plus build report, configuration JSON, high-resolution stills, and the spec sheet. |
| `room` | Who else is in the studio right now, and presenting a saved design to them. |

Declaring `db` makes the artifact organization-internal: it can no longer be shared by
public link.

## Keyboard

`⌘K` / `Ctrl K` command palette · `⌘Z` / `⌘⇧Z` undo and redo · `⌘S` save ·
`1`–`4` views · `A` / `B` isolate a piece · `H` hat · `W` wireframe · `C` dividing
curve · `Space` pause the turntable.

## What stays on the desktop build

Two things, stated plainly rather than faked here:

1. **Photoreal rendering.** Blender Cycles renders the product shots; this page uses
   three.js, which is a preview, not a render.
2. **Boolean consolidation.** `manifold3d` fuses the petals, base and centre into one
   manifold solid per piece. It fetches its own WebAssembly at run time, which the
   artifact's content policy blocks, so the browser build ships the flower **as built**:
   overlapping closed shells, one per petal. It renders identically and it verifies
   identically, but it is a body count rather than a single manufacturable part.

## Running it locally

```sh
cd AFRi-Studio/web_studio
python3 -m http.server 8899
# then open http://127.0.0.1:8899/index.html
```

ES modules and workers need an HTTP origin; opening the file directly will not work.
Without `window.claude` the capability-driven features stay hidden, which is the
same path a viewer gets when a capability is not granted.
