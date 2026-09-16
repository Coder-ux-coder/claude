# Design review framework

How an AFRi Studio concept is judged, and — just as importantly — where the
software stops judging and a person has to look.

The division is deliberate. Some properties of a design are measurable, and the
application measures them. Others are aesthetic, and no amount of arithmetic
turns an opinion into a measurement. **This framework does not produce a beauty
score**, because a number that claims to rank designs by attractiveness would be
an invention dressed up as evidence.

---

## 1. What the software measures

These run automatically on every generation and are stored on the version.
Each has a stated method and a stated tolerance; each either passes or fails.

### Geometry validity — `design_engine/splitting/validate.py`

| Check | Method | Criterion |
|---|---|---|
| `master_nonempty` | vertex and face counts | > 0 |
| `pieces_nonempty` | both pieces | > 0 each |
| `split_is_geometric` | count of bodies present in both pieces | > 0 bodies actually divided |
| `volume_conservation` | \|V(A)+V(B) − V(master)\| / V(master) | < 1 % |
| `area_conservation` | surface area, discounting the two new cut walls | < 2 % |
| `no_cross_contamination` | signed field in the split frame | 0 vertices beyond the chord tolerance |
| `no_bridging_geometry` | connected components vs. the dividing line | 0 components straddle it |
| `piece_a/b_closed` | edges used by exactly one face | 0 open edges |
| `piece_a/b_manifold` | edges used by more than two faces | 0 |
| `piece_a/b_has_boundary_surface` | count of generated cut-wall triangles | > 0 |
| `components_addressable` | finite coordinates, independent export | true |
| `footprint_reconstruction` | rasterised A∪B vs. master, area-proportional sampling | < 2 % of cells differ |
| `degenerate_faces` | triangle area threshold | reported, not fatal |

Two notes on where the tolerances come from, because guessed constants are how
validation quietly becomes theatre:

- **The contamination tolerance is derived, not chosen.** Crossing points are
  found by interpolating along a triangle edge, so a curved cut is a *chord* of
  the split path and sits slightly off it. That gap is real geometry. The
  allowance is computed as the chord deviation across the widest edge span in
  the mesh, so it scales with tessellation and with path curvature. A genuinely
  misassigned petal exceeds it by orders of magnitude.
- **Watertightness is checked but not universally demanded.** These petals are
  modelled as closed solids so it is meaningful here, and both pieces do come
  out watertight. A decorative open surface would legitimately fail, so the
  check reports rather than blocks.

### Render validity — `backend/app/jobs/pipeline.py`

| Check | Criterion |
|---|---|
| File exists and is non-empty | required |
| Opens in Pillow | required |
| Matches the requested resolution | required |
| Not a blank frame | luminance standard deviation above a floor |

The blank-frame check exists because "the camera was pointing at nothing" is a
real and easily-missed failure that otherwise ships as a valid-looking file.

### Design measurements — `backend/app/agents/refine.py`

Descriptive, not pass/fail. They are what the refinement engine targets.

| Measurement | What it says |
|---|---|
| `petal_count`, `layer_count` | how densely the flower is built |
| `diameter_mm`, `height_mm`, `relief_ratio` | overall proportion |
| `piece_balance` | 1.0 when the two pieces are equal in volume |
| `silhouette_raggedness` | standard deviation of outer radius over 72 angular bins, normalised. Low means a full, even circular outline. |
| `boundary_area` | how much surface the division creates — a proxy for how prominent it is |

---

## 2. What a person has to judge

The software cannot settle any of these. They are recorded as review notes
against a version, not computed.

| Quality | What to look for |
|---|---|
| **Marigold recognisability** | Does it read as a marigold rather than a chrysanthemum, dahlia or generic daisy? Dense packed rows, broad ray florets with rounded ends, a full circular outline, a visible centre. |
| **Overall silhouette** | Is the outline full and even from above, and does the side profile read as a domed rosette rather than a bowl or a flat disc? |
| **Petal coherence** | Do the petals look like they belong to one flower — consistent in character, varied without looking random? |
| **Petal layering** | Do the rows read as distinct layers, or do they merge into an undifferentiated mass? |
| **Split clarity** | Is the dividing line legible as a deliberate design feature, or does it disappear into the petals? |
| **Component alignment** | When assembled, do the two pieces read as one flower? When apart, is each a satisfying object on its own? |
| **Visual balance** | Do the proportions of the two pieces feel intentional? (Concept C is deliberately unequal.) |
| **Surface quality** | Does the material read as the intended finish, without plastic sheen or muddy shading? |
| **Consistency with the brief** | Does it meet the confirmed requirements, and are the assumptions still clearly labelled as assumptions? |

### What this framework will not claim

- It will not say a design is objectively beautiful.
- It will not rank concepts by a composite score.
- It will not claim any concept matches AFRi's brand language. The references
  were not available, so that judgement cannot be made yet.
- It will not claim a design has been visually inspected when it has not.

---

## 3. How the two halves fed each other in practice

Worth recording, because it shows the framework earning its keep. Every one of
these faults passed the automated checks and was caught by looking at a render:

| Seen | Diagnosed as | Fixed by |
|---|---|---|
| Petal tips read as squared keyholes | Tip rounded in width while the notch pulled the centre back, leaving the edges proudest | Round the tip in *length* instead |
| Flower curled into a bowl | Outer rows inherited the inner rows' curl | Ramp curl and tilt inward from the outer row |
| Outer petals floated free | Base disc smaller than the outermost petal root radius | Disc now always reaches past it |
| Subject cropped in every render | Camera distance was a hand-tuned multiple of radius | Derive it from focal length and sensor size |
| Division invisible in the assembled view | Piece tint too weak to see; close-up camera at a low angle | Mix toward the secondary colour; move the close-up overhead and part the pieces slightly |

Conversely, the automated checks caught what the eye could not: a piece that was
not watertight, a cap that failed to close, an angled split validated in the
wrong coordinate frame. Neither half of the framework is sufficient alone.

---

## 4. Recording a review

Review findings belong on the version, alongside its measurements, so that the
history shows what was thought at the time as well as what was measured:

- `description` — what changed and why
- `hypothesis` — for refinement versions, what was expected and what happened
- `preferred` — a human liked this one
- `approved` — a human signed it off; the version becomes write-locked

Approval is the only signal in the system that means "a person looked at this
and was happy". Nothing sets it automatically.
