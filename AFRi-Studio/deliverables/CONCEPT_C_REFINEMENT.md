# Concept C — refinement, v1 to v2

Provisional studio work. AFRi has supplied no reference deck, brand palette or
size chart, so every value here remains an assumption.

## What was asked, and what was found

Three defects were reported from the exported meshes. All three were real, and
one was worse than reported.

### 1. Face winding and normals

**Reported:** inconsistent face winding and normals.

**Found:** cut caps were being triangulated in whatever rotational direction
the undirected boundary walk happened to produce. Measured on the shipped
configuration, **9 bodies in piece A and 10 in piece B were wound inside-out**.

The reason this survived a full validation suite is worth recording. The suite
checked that `volume(A) + volume(B)` matched the master, and it did — to eight
decimal places. It could not have failed: the two pieces' cut walls are exact
negatives of one another, so an inverted cap subtracts from one piece exactly
what it adds to the other and the error cancels in the sum.

**Fixed** at source: each cap loop is now oriented from its area-weighted
normal against the direction that piece's material faces at the cut. A new
`outward_normals` check asserts it per body, and a test deliberately inverts a
body to prove the check fails on bad input — a check that cannot fail is not a
check. It is scoped to bodies carrying meaningful volume, because a clipped
petal tip can leave a sliver enclosing a millionth of a cubic unit whose sign
is numerical noise rather than a defect.

### 2. Disconnected mesh bodies

**Reported:** 92 and 107 disconnected bodies; petals not integrated into the
structural base.

**Found:** two separate causes.

*The petals were not attached.* Rows 4 and 5 sat **0.64 mm and 1.61 mm clear of
the base disc**, held by nothing. This was invisible in every render, because
geometry that merely overlaps looks identical to geometry that is joined.

| Row | Radius | Petal z span | Disc top | Gap |
|---|---|---|---|---|
| 0 | 26.8 mm | −0.55 … 0.55 | 1.89 | −2.44 embedded |
| 3 | 17.9 mm | 2.74 … 3.75 | 2.99 | −0.25 embedded |
| 4 | 15.1 mm | 4.04 … 4.99 | 3.40 | **+0.64 floating** |
| 5 | 12.3 mm | 5.40 … 6.28 | 3.79 | **+1.61 floating** |
| 6 | 9.5 mm | 6.79 … 7.61 | 4.12 | +2.67 (met the centre boss) |

The structural base is now built to follow the petal-root profile, so every row
is embedded with 0.41–2.35 mm of overlap. That is also what a real composite
flower has: a receptacle that rises to meet each whorl.

*The bodies were never fused.* A new CONSOLIDATE stage boolean-unions the
petals, base and centre into one manifold before the split, using manifold3d
(Apache-2.0). Blender's edit-mode self-intersect was tried first and made the
mesh worse — 88 bodies in, 176 bodies and 14,105 non-manifold edges out — so it
is not used.

Union-first then split beats split-then-union, measured:

| Order | Open edges | Volume error | Inverted bodies |
|---|---|---|---|
| Union, then split | 0 / 0 | 2.6 × 10⁻⁷ % | 0 |
| Split, then union each piece | 0 / 0 | 1.9 × 10⁻³ % | 0 |

**Result: each half of Concept C v2 is one coherent solid**, after removing 19
debris specks totalling 1.06 mm³ — 0.002% of volume.

### 3. Triangle count in BUILD_REPORT.txt

**Reported:** the counts do not add up.

**Found:** correct. The report printed the master count beside the per-piece
counts as though they summed. They never can. The split subdivides every
triangle the curve crosses, and then gives each piece a cut wall that did not
exist in the master.

    master            453,368
    piece A           230,198
    piece B           232,294
    A + B             462,492
    added by split      9,124
    of which cut wall   5,354   (both walls)

Now reported explicitly, with the delta and the reason.

## The flower

v1 read as a daisy. v2 reads as a marigold.

| | v1 | v2 |
|---|---|---|
| Ray florets | 157 | 315 |
| Rows | 7 | 9 |
| Petal length / radius | 0.46 | 0.33 |
| Petal width | 1.02 | 1.12 |
| Edge crenulation | 0.24 at 3.6 cycles | 0.42 at 4.6 cycles |
| Height : diameter | 0.205 | 0.352 |
| Bodies per half | 86 / 90 | **1 / 1** |

Two intermediate settings were built, rendered and rejected on inspection:

* At width 1.28 with a 0.22 tip notch, each floret read as a **clover leaf**
  rather than a petal. Width was pulled back to 1.12 and the notch to 0.10.
* At curl 0.78 with `dome_gain` 0.72, the rows **terraced into a stepped cone**
  and the receptacle showed through between them as bare bands. Curl went to
  0.64, tilt gain to 0.80, dome gain to 0.56.

`dome_gain` is a new parameter. Its default is 0.40, which is exactly the
constant it replaced, so v1 reproduces bit-for-bit.

## The dividing curve

The organic family added fractal noise at up to 0.7 of amplitude across the
whole span. That reads as jitter: the curve wandered, changed its mind
repeatedly, and frayed where it crossed the silhouette.

It is now one dominant sweep answered by a shorter counter-curve, placed
off-centre so the halves are unequal on purpose, with the wander subordinate to
that gesture and enveloped to nothing at both ends — so the curve meets the
outline at two clean points. Measured: **two direction changes inside the
flower**, sinuosity 1.13.

## Honest limits

* The **browser studio cannot consolidate**. manifold3d is a WASM module that
  fetches its own binary at runtime, which the page's content-security policy
  blocks. The web build therefore exports the flower as built — overlapping
  closed shells — and now says so and reports the real body count. Exports
  intended for manufacture must come from the desktop pipeline. This is the
  gap that produced the 92 and 107 figures.
* Removing debris means A and B no longer reconstruct the master *exactly*:
  volume conservation is 0.0017% rather than 10⁻⁷. That is the deliberate
  trade for two clean solids, and the amount removed is reported every run.
* The two halves are tinted apart in the presentation renders so the division
  reads. They are one material; this is a presentation aid.
* Nothing here has been reviewed by a maker. The exports are geometry, not
  manufacturing data.
