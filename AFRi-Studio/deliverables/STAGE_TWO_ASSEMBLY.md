# Stage Two — the accessory on the hat

Provisional studio work. AFRi has supplied no reference deck, brand palette,
hat specification or size chart. Every dimension below is an assumption, and
the ones that matter are stated so they can be corrected.

## The finding, first

**The refined 90 mm flower does not fit a standard fedora brim.**

It measures **96.6 mm** across its outermost petals. A 58 cm fedora with a
68 mm brim offers **67.2 mm of radial room** between the crown foot
(r = 92.3 mm) and the brim edge (r = 159.5 mm). For the flower to sit wholly on
that brim it needs 96.6 mm of room. It does not have it.

This was swept, not assumed: every radial position from the crown foot to the
brim edge, at tilts from 0° to 40°, and every one collides — the flower either
rides up the crown wall or hangs past the brim edge.

| Flower nominal | Across the petals | Fits a 67 mm fedora brim? |
|---|---|---|
| 90 mm | 96.6 mm | **No** — no collision-free placement exists |
| 75 mm | 80.5 mm | Marginal — clears at 3 mm standoff, 11 mm gap |
| 62 mm | 66.7 mm | Yes — 3 mm standoff, 3.6 mm gap |
| 55 mm | 59.2 mm | Yes — 2 mm standoff, 2.5 mm gap |

Two ways forward, and this is a client decision:

1. **Keep the 90 mm accessory and specify a wide-brim hat.** On a 110 mm brim
   it seats at r = 140 mm with zero interference and a 2 mm standoff.
2. **Keep the fedora and bring the accessory down to about 58 mm.** The same
   design, scaled; it seats at r = 128 mm.

Both are generated and rendered so the difference can be judged by eye rather
than argued from numbers.

## Measured

| | Wide brim | Fedora |
|---|---|---|
| Hat | wide brim, 110 mm | fedora, 68 mm |
| Hat overall | 401 mm across | 319 mm across |
| Accessory | 90 mm nominal | 58 mm nominal |
| Seated at | r = 140 mm | r = 128 mm |
| Standoff | 2.0 mm | 2.0 mm |
| Interference | **0.00 mm** | 0.17 mm |
| Gap across the footprint | up to 3.33 mm | up to 2.53 mm |
| Conformance error | 2.91 mm | 2.68 mm |
| Mass (cast resin, 1.24 g/cm³) | 53 g | 22 g |
| Moment about the crown foot | 2,597 g·mm | 801 g·mm |

## Rigid or conforming?

The stage-two plan proposed both and said they should be evaluated rather than
assumed. The measurement:

**A rigid flat back on a curved brim leaves 2.91 mm of conformance error across
the footprint**, with 12% of the underside within 0.6 mm of closest approach.

That figure is deliberately measured from the closest approach rather than from
the hat surface, so it is independent of standoff — moving the flower up or
down shifts every gap equally and says nothing about whether the two shapes
match.

**Recommendation: rigid, for now.** A pin-and-clutch through felt absorbs 3 mm
without complaint, and 3 mm on a 96 mm flower is not visible at wearing
distance. Conforming would close it, but it requires lifting the split path
onto a curved base — the path is currently a function of *y* in a plane, which
is exactly what guarantees it divides the flower into two regions and nothing
else. That is the main technical risk in stage two and should not be spent
until someone has held a 3 mm gap in their hand and objected to it.

## The fixing

Two pins per half, fused into the piece so each half stays a single solid
rather than a body with studs balanced on its back.

Where a pin goes is not a styling decision. Each is sited at a local maximum of
the distance to the edge of that piece's flat footprint — put one near a rim
and it tears out — and the pair is forced at least a third of the footprint
apart, because two pins close together are one pin and the piece pivots on
them. Every clearance is measured and reported, so a pin too close to an edge
shows up as a number rather than being discovered by a maker.

| | Wide brim | Fedora |
|---|---|---|
| Pins per half | 2 | 2 |
| Spacing, piece A / B | 24.5 / 27.4 mm | 16.7 / 19.0 mm |
| Least material around a pin | 7.80 mm | 6.46 mm |
| Shank through the hat | 5.4 mm | 5.4 mm |
| Enough to take a clutch | yes | yes |

Ø1.6 mm × 9 mm pins, through a 1.6 mm hat at a 2 mm standoff. Shorten the pin
below about 6 mm and the shank no longer clears the felt with enough left to
grip; the pipeline warns when that happens rather than shipping it quietly.

## What was built

* `design_engine/hat/` — five styles (fedora, boater, wide brim, cloche,
  bucket) as closed solids of revolution, with a ribbon band as its own body.
  The fedora's centre crease and finger dents are applied to the mid-surface
  before it is given thickness, so the shell stays closed.
* `design_engine/assembly/` — rigid placement onto a tangent frame of the hat's
  outer skin, and the contact, interference and load measurements above.
* Pipeline stages `HAT` and `ASSEMBLY`; Blender `HAT` collection, felt and
  straw materials, and six hat cameras including a detail framed on the
  accessory rather than the hat.

## Not done, and stated

* **Only one fixing of the five is modelled.** Pin-and-clutch is built,
  because it is the only candidate that is geometry rather than a bought
  component. Brooch bar, magnets either side of the brim, a sewn mount and an
  edge clip are not, and the choice between them is still the client's. It
  also interacts with the two-piece concept: the halves can take separate
  fixings and be positioned independently, or share a carrier plate and be
  easier to align but no longer two independent objects on the hat.
* **Surface conforming is not implemented.** See above.
* **Nothing has been reviewed by a maker.** Wall thickness against process,
  petal fragility, draft angles, tolerance at the split boundary, and whether
  a felt brim carries 53 g at 2,597 g·mm without deforming are all open. The
  brim load figure in particular is geometry, not a structural result.
* **The head is not modelled.** The hat is shown empty; a worn view would need
  a head form to sit on.
