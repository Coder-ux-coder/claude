# Stage Two — Hat integration plan

**Status: PLANNING ONLY. NOT IMPLEMENTED.**

No hat geometry exists in this repository. Nothing in `design_engine/`,
`blender_worker/` or the UI models, renders or references a hat, and
`GET /api/system` reports `hat_stage_two_started: false`. Stage Two begins only
when the client explicitly authorises it.

This document records how it would be built, so that the Stage One architecture
can be judged against what comes next.

---

## 1. What Stage Two adds

1. A parametric hat, with the brim as the surface that matters.
2. Placement of an approved flower on that brim.
3. An attachment mechanism between flower and hat.
4. Integrated product visualisation.
5. A first pass at manufacturing considerations.

## 2. What Stage One already did to make it possible

These are not accidents; they were chosen with Stage Two in mind:

- **Geometry is pure Python.** A hat is another procedural generator beside
  `flower/`. It needs no new execution model.
- **The relief form factor.** The flower is a domed rosette with a flat
  underside and a structural base disc, not a sphere. It already has a face that
  can meet a brim.
- **Real units.** 1 scene unit = 10 mm throughout, so hat and flower dimensions
  will be directly comparable without a conversion layer.
- **The structural base disc.** Every petal is attached to a disc that reaches
  past the outermost petal roots. That disc is the natural mounting surface, and
  it survives the split — each piece keeps its own portion.
- **Stage-separated caching.** Adding `HAT` and `ASSEMBLY` stages slots into the
  existing dependency graph without disturbing the flower or split stages.
- **Collections in Blender.** `MASTER_FLOWER`, `PIECE_A`, `PIECE_B`, `LIGHTING`,
  `CAMERAS`, `BACKGROUND` already separate cleanly; `HAT` and `ATTACHMENT` are
  additive.

## 3. Proposed hat model

```
HatConfig
├── style: fedora | boater | wide_brim | cloche | bucket
├── head_circumference_mm    (54-62, the standard adult range)
├── crown_height_mm
├── crown_taper
├── brim_width_mm
├── brim_droop_deg           (how far the brim falls from horizontal)
├── brim_curl                (upward curl at the outer edge)
├── brim_thickness_mm
└── material: felt | straw | wool | canvas
```

The brim is the only part the flower interacts with, so it is modelled as a
surface of revolution with a controllable droop and curl, sampled finely enough
that the flower's footprint can be projected onto it accurately.

## 4. Placement

```
PlacementConfig
├── azimuth_deg              (around the crown)
├── radial_position          (0 at the crown, 1 at the brim edge)
├── surface_offset_mm        (lift off the brim)
├── tilt_deg / roll_deg      (orientation relative to the local surface)
└── conform: rigid | surface_conform
```

The brim is doubly curved, so a rigid flat flower will not sit flush on it. Two
approaches, to be evaluated against each other rather than assumed:

1. **Rigid mount.** Keep the flower flat and take up the gap in the attachment.
   Simplest to make; may show a visible gap on a strongly drooped brim.
2. **Surface conform.** Deform the base disc to match the local brim surface,
   then rebuild the petals on the deformed base. Better contact, but the split
   geometry must be recomputed because the base is no longer planar.

The split kernel is agnostic to the shape it cuts, but the split path is
currently a function of `y` in a plane. Conforming would require lifting that
path onto the deformed surface — a genuine piece of new work, not a parameter
change, and the main technical risk in Stage Two.

## 5. Attachment

To be explored, not decided:

- Pin and clutch through the brim.
- A brooch bar on the underside of each piece.
- Magnets, one half either side of the brim (removable, no perforation).
- A sewn-in mount.
- A hidden clip that grips the brim edge.

For a **two-piece** flower, attachment has a wrinkle worth stating early: the
two pieces may attach independently (each with its own fixing, so they can be
positioned separately) or as one assembly (a shared carrier plate, easier to
align but no longer two independent objects on the hat). This is a design
decision for the client, and it interacts with the whole point of the
two-piece concept.

## 6. Visualisation

- New camera presets framing the whole hat, plus a detail on the flower.
- A "worn" preset at a plausible head angle.
- Existing render presets carry over unchanged.
- Turntable renders would be a natural addition.

## 7. Manufacturing considerations

Deliberately absent from Stage One and still open:

- Wall thickness against the chosen process and material.
- Petal fragility — the current petals are thin by design.
- Draft angles if moulded.
- Tolerance at the split boundary so the pieces meet cleanly.
- Weight on the brim, and whether the brim can carry it without deforming.
- Whether the two pieces are made as one part and separated, or made separately.

None of this has been assessed. The Stage One exports are geometry, not
manufacturing data.

## 8. Order of work

1. Confirm the flower concept and replace the provisional assumptions with
   AFRi's real references.
2. Build the parametric hat; verify the brim surface independently.
3. Rigid placement first — it is cheap and answers most questions.
4. Evaluate whether surface conforming is needed.
5. Prototype attachment options.
6. Integrated renders.
7. A manufacturing review with an actual maker.

## 9. What would need to change in the codebase

| Area | Change |
|---|---|
| `design_engine/hat/` | New package: crown, brim, profile curves. |
| `design_engine/assembly/` | New: placement transform, surface projection, contact check. |
| `configurations/schema.py` | Add `HatConfig` and `PlacementConfig`; extend the stage hashes. |
| `blender_worker/` | `HAT` and `ATTACHMENT` collections, hat materials, new cameras. |
| `splitting/` | Only if surface conforming is chosen — lifting the split path onto a curved base. |
| Frontend | A hat panel, placement gizmo, assembled/exploded product view. |
| Validation | Contact-gap check, interpenetration check, centre-of-mass on the brim. |

Everything above is additive. Nothing in Stage One would need to be torn up.
