# Web Studio - the browser-native build

A single page that generates the master marigold, splits it into two genuinely
separate closed solids, and lets you steer the whole thing with sliders. No
server, no Python, no Blender, no install.

    web_studio/
      engine.js    hand port of design_engine/ to typed-array JavaScript
      worker.js    runs a generation off the main thread
      index.html   the studio: viewport, parameter editor, verification, export

Open `index.html` from any static server (`python3 -m http.server`) or use the
published artifact.

## What is ported, and what is not

Ported, and running live in the page:

| Python | JavaScript |
| --- | --- |
| `geometry/mesh.py` | `Mesh` as flat `Float64Array` / `Int32Array`, `weld`, `orient`, `concat` |
| `geometry/curves.py` | `smoothstep`, `valueNoise1D`, Catmull-Rom |
| `petals/profile.py` | `widthProfile`, `tipLengthProfile` |
| `petals/petal.py` | `buildPetal` - closed solid shell, mid-surface offset, stitched rim |
| `flower/base.py` | `buildBaseDisc`, `buildCenter` |
| `flower/marigold.py` | `layerSchedule`, `buildMasterFlower` |
| `splitting/paths.py` | `buildSplitPath` - balanced, s_river, organic |
| `splitting/splitter.py` | `splitFlower` - exact per-triangle clipping, per-body, with capping |

Not ported, and deliberately so:

* **Blender.** Materials, lighting, Cycles rendering, `.blend` and glTF export
  stay in `blender_worker/` on the desktop build. The page uses three.js for a
  working viewport, not for photoreal output.
* **The boolean union.** The desktop pipeline fuses the petals, base and centre
  into a single manifold with manifold3d before splitting, so each half exports
  as one solid. manifold3d is a WASM module that fetches its own `.wasm` at
  runtime, and the Artifact CSP blocks a library's runtime fetches, so the page
  cannot run it. The browser build therefore ships the flower *as built* -
  overlapping closed shells, one per petal plus the base and centre. It renders
  identically; it is not a manufacturable part. The page says so, and reports
  the real body count rather than implying one solid.

## Parity

`tests/integration/test_js_parity.py` runs the JavaScript engine under node and
compares it against Python. Measured on the default configuration:

| Quantity | Python | JavaScript |
| --- | --- | --- |
| Vertices | 65,976 | 65,976 |
| Triangles | 131,316 | 131,316 |
| Volume | 21.033674189 | 21.033673698 |
| Surface area | 431.110259242 | 431.110260340 |

The residual, about 2 parts in 10^8, is exactly the float32 rounding in the
Python `Mesh` vertex store against float64 in JavaScript.

Parity is asserted with `organic_variation = 0` **and** `petal_ruffle_amp = 0`.
numpy's PCG64 cannot be reproduced in JavaScript, so any parameter that
consumes a random draw diverges by construction. Note that the per-petal
ruffle *phase* is drawn whether or not jitter is enabled, which is why the
ruffle has to be switched off too; with both off, no random number reaches the
geometry.

At the shipped defaults the two engines therefore produce the same flower
design with individual petals seated at slightly different angles. The layer
schedule, the petal shape, the split path and the cut are identical.

## A known ambiguity in the cut wall

Both engines produce two watertight pieces that reconstruct the master to
machine precision. They do **not** always agree on how much volume lands on
each side - typically within 1%.

This is not a porting defect. A boundary loop through a petal is not planar,
because the split path curves across the petal's width. Ear-clipping such a
loop is under-determined: several triangulations are valid, they describe
slightly different ruled surfaces, and which one you pick decides which side
a sliver of material falls on. Python walks its boundary edges in `set`
iteration order and JavaScript in insertion order, so the two pick different
valid triangulations.

Consequences, stated plainly:

* Each piece is closed, and A + B reconstruct the master exactly. Both engines
  satisfy this. The physical claim is unaffected.
* The reported A:B balance can differ by up to about one percentage point
  between engines for the same configuration.
* The cut wall's micro-shape differs by well under the material thickness.

The fix, if this ever needs to be tight, is to subdivide each boundary loop at
the split path's own sample points before triangulating, so the cut wall
follows the curve instead of chording across it. That changes the production
kernel and has not been done.

## Capabilities the published page uses

* `sample` - the Claude designer. It may only move parameters that exist in the
  schema, within their declared bounds; every proposed change is re-validated
  in the page and anything out of range is rejected and shown. It cannot run
  code, read files or reach the network.
* `downloads` - export. Two binary STL meshes in millimetres plus a build
  report, in a zip. STL is not on the platform's download allowlist, which is
  why the zip is not optional.

Both degrade to hidden when unavailable. The geometry, the split, the
verification and the viewport work with neither.
