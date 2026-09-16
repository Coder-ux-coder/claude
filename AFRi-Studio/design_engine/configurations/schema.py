"""Design configuration schema.

The single source of truth for what a design *is*. Every numeric field carries
UI metadata (range, step, unit, description) so the frontend can build the
parameter editor generatively from ``/api/schema`` -- one definition, no drift
between backend validation and frontend controls.
"""
from __future__ import annotations

import hashlib
import json
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


# --------------------------------------------------------------------------
# UI metadata helper
# --------------------------------------------------------------------------
def P(default, lo, hi, step, unit, desc, group="general"):
    """A numeric parameter carrying the metadata the UI needs to render it."""
    return Field(
        default,
        ge=lo,
        le=hi,
        json_schema_extra={
            "ui": {
                "min": lo, "max": hi, "step": step,
                "unit": unit, "description": desc, "group": group,
            }
        },
    )


class SplitType(str, Enum):
    BALANCED = "balanced"
    S_RIVER = "s_river"
    ORGANIC = "organic"


class RenderQuality(str, Enum):
    PREVIEW = "preview"
    STANDARD = "standard"
    HIGH = "high"


class CameraPreset(str, Enum):
    TOP = "top"
    FRONT = "front"
    SIDE = "side"
    THREE_QUARTER = "three_quarter"
    CLOSEUP = "closeup"
    HERO = "hero"


class LightingPreset(str, Enum):
    STUDIO_SOFT = "studio_soft"
    DRAMATIC = "dramatic"
    FLAT_CATALOG = "flat_catalog"


class MaterialPreset(str, Enum):
    MATTE_FELT = "matte_felt"
    SATIN_SILK = "satin_silk"
    BRUSHED_METAL = "brushed_metal"
    ENAMEL = "enamel"
    VELVET = "velvet"


# --------------------------------------------------------------------------
# Flower
# --------------------------------------------------------------------------
class FlowerConfig(BaseModel):
    """Parameters of the canonical master marigold.

    Defaults are *provisional studio assumptions*, not client-confirmed values.
    """
    model_config = {"extra": "forbid"}

    diameter_mm: float = P(90.0, 30.0, 200.0, 1.0, "mm",
                           "Overall diameter of the finished flower.", "form")
    relief_depth_mm: float = P(18.0, 4.0, 60.0, 0.5, "mm",
                               "Height of the domed rosette above its base plane.", "form")
    thickness_mm: float = P(1.1, 0.3, 5.0, 0.1, "mm",
                            "Material thickness of each petal.", "form")

    layer_count: int = P(7, 1, 12, 1, "layers",
                         "Number of concentric petal rows.", "petals")
    petal_count_base: int = P(21, 5, 60, 1, "petals",
                              "Petals in the outermost row; inner rows scale from this.", "petals")
    petal_density: float = P(1.25, 0.4, 2.5, 0.05, "x",
                             "Multiplier on petals per row. Higher reads fuller.", "petals")
    petal_length_ratio: float = P(0.46, 0.15, 0.75, 0.01, "x",
                                  "Petal length as a fraction of flower radius.", "petals")
    petal_width_ratio: float = P(1.02, 0.20, 1.40, 0.01, "x",
                                 "Petal width relative to its natural spacing. >1 overlaps.", "petals")
    petal_overlap: float = P(0.34, 0.0, 0.8, 0.01, "x",
                             "Radial overlap between adjacent rows.", "petals")
    petal_curvature: float = P(0.62, 0.0, 1.0, 0.01, "x",
                               "Lengthwise curl. 0 is flat, 1 curls strongly inward.", "shape")
    petal_cup: float = P(0.45, 0.0, 1.0, 0.01, "x",
                         "Crosswise cupping, the channel along the petal.", "shape")
    petal_ruffle_amp: float = P(0.24, 0.0, 1.0, 0.01, "x",
                                "Amplitude of the ruffled petal edge.", "shape")
    petal_ruffle_freq: float = P(3.6, 1.0, 10.0, 0.1, "cycles",
                                 "Number of ruffle waves across the petal edge.", "shape")
    petal_notch: float = P(0.16, 0.0, 0.7, 0.01, "x",
                           "Depth of the notch at the petal tip.", "shape")
    layer_tilt_gain: float = P(0.62, 0.0, 1.4, 0.01, "x",
                               "How much more upright each inner row stands.", "shape")

    center_diameter_ratio: float = P(0.22, 0.08, 0.6, 0.01, "x",
                                     "Centre boss diameter as a fraction of flower diameter.", "center")
    center_dome_height: float = P(0.30, 0.0, 1.2, 0.01, "x",
                                  "Centre dome height relative to relief depth.", "center")
    center_floret_rings: int = P(5, 0, 10, 1, "rings",
                                 "Rings of tiny disc florets in the centre.", "center")

    base_disc_ratio: float = P(0.40, 0.15, 0.95, 0.01, "x",
                               "Structural base disc diameter, fraction of flower diameter. "
                               "This is what physically carries each half.", "structure")
    base_thickness_mm: float = P(1.8, 0.5, 6.0, 0.1, "mm",
                                 "Thickness of the structural base disc.", "structure")

    organic_variation: float = P(0.35, 0.0, 1.0, 0.01, "x",
                                 "Per-petal random jitter in angle, length, width and tilt.", "variation")
    seed: int = Field(20260916, ge=0, le=2**31 - 1, json_schema_extra={
        "ui": {"min": 0, "max": 2**31 - 1, "step": 1, "unit": "",
               "description": "Random seed. Same seed reproduces the flower exactly.",
               "group": "variation"}})

    # Tessellation density -- affects fidelity and cost, not shape.
    petal_segments_u: int = P(18, 5, 40, 1, "segs",
                              "Tessellation along petal length.", "quality")
    petal_segments_v: int = P(11, 3, 25, 1, "segs",
                              "Tessellation across petal width.", "quality")


# --------------------------------------------------------------------------
# Split
# --------------------------------------------------------------------------
class ControlPoint(BaseModel):
    model_config = {"extra": "forbid"}
    y: float = Field(..., ge=-1.5, le=1.5, description="Normalised position along the split axis.")
    x: float = Field(..., ge=-1.5, le=1.5, description="Normalised lateral offset.")


class SplitConfig(BaseModel):
    """How the master flower is divided into two pieces."""
    model_config = {"extra": "forbid"}

    type: SplitType = Field(SplitType.S_RIVER, json_schema_extra={
        "ui": {"description": "Family of dividing curve.", "group": "split"}})
    position: float = P(0.0, -0.6, 0.6, 0.01, "x",
                        "Lateral position of the split. 0 is centred.", "split")
    orientation_deg: float = P(0.0, -180.0, 180.0, 1.0, "deg",
                               "Rotation of the split axis around the flower.", "split")
    amplitude: float = P(0.30, 0.0, 0.9, 0.01, "x",
                         "How far the curve swings sideways. Drives the S.", "curve")
    smoothness: float = P(0.65, 0.05, 1.0, 0.01, "x",
                          "Curve softness. Low is taut and angular, high is flowing.", "curve")
    control_points: list[ControlPoint] | None = Field(None, json_schema_extra={
        "ui": {"description": "Explicit Bezier control points. Overrides amplitude/smoothness "
                              "when present, for hand-authored curves.", "group": "curve"}})

    organic_octaves: int = P(3, 1, 6, 1, "octaves",
                             "Noise detail levels for the organic split.", "organic")
    organic_roughness: float = P(0.45, 0.0, 1.0, 0.01, "x",
                                 "Irregularity of the organic split.", "organic")
    organic_seed: int = Field(7, ge=0, le=2**31 - 1, json_schema_extra={
        "ui": {"min": 0, "max": 2**31 - 1, "step": 1, "unit": "",
               "description": "Seed for the organic split's wander.", "group": "organic"}})

    separation_mm: float = P(14.0, 0.0, 80.0, 0.5, "mm",
                             "Gap between the pieces in the separated view.", "presentation")
    boundary_tolerance_mm: float = P(0.05, 0.001, 1.0, 0.001, "mm",
                                     "Tolerance for boundary and contamination checks.", "validation")
    cap_boundary: bool = Field(True, json_schema_extra={
        "ui": {"description": "Build a real boundary wall on the cut face so each "
                              "piece is a closed solid.", "group": "split"}})

    @field_validator("control_points")
    @classmethod
    def _cp_monotone(cls, v):
        if v is None:
            return v
        if len(v) < 2:
            raise ValueError("need at least 2 control points")
        if len(v) > 8:
            raise ValueError("at most 8 control points")
        ys = [p.y for p in v]
        if any(b <= a for a, b in zip(ys, ys[1:])):
            raise ValueError(
                "control point y values must strictly increase: the split path must "
                "remain a function of y so that it divides the plane into exactly two regions"
            )
        return v


# --------------------------------------------------------------------------
# Material / Render
# --------------------------------------------------------------------------
class MaterialConfig(BaseModel):
    model_config = {"extra": "forbid"}
    preset: MaterialPreset = Field(MaterialPreset.SATIN_SILK)
    base_color: str = Field("#F2A007", pattern=r"^#[0-9a-fA-F]{6}$",
                            description="Provisional marigold orange. NOT an AFRi brand colour.")
    secondary_color: str = Field("#C9500A", pattern=r"^#[0-9a-fA-F]{6}$",
                                 description="Deeper tone used at petal roots and centre.")
    roughness: float = P(0.42, 0.0, 1.0, 0.01, "x", "Surface roughness.", "material")
    metallic: float = P(0.0, 0.0, 1.0, 0.01, "x", "Metallic amount.", "material")
    sheen: float = P(0.35, 0.0, 1.0, 0.01, "x", "Fabric sheen at grazing angles.", "material")
    piece_tint: float = P(0.0, 0.0, 1.0, 0.01, "x",
                          "Tints piece B away from piece A so the division reads clearly "
                          "in presentation images. 0 keeps both identical.", "material")


class RenderConfig(BaseModel):
    model_config = {"extra": "forbid"}
    quality: RenderQuality = Field(RenderQuality.PREVIEW)
    camera: CameraPreset = Field(CameraPreset.THREE_QUARTER)
    lighting: LightingPreset = Field(LightingPreset.STUDIO_SOFT)
    resolution: int = P(900, 256, 2400, 32, "px", "Square output resolution.", "render")
    background: str = Field("#14161A", pattern=r"^#[0-9a-fA-F]{6}$",
                            description="Studio backdrop colour.")
    separated: bool = Field(False, description="Render the pieces apart rather than assembled.")


# --------------------------------------------------------------------------
# Root
# --------------------------------------------------------------------------
ENGINE_VERSION = "1.0.0"


class DesignConfig(BaseModel):
    """The unit of versioning, diffing, hashing and AI mutation."""
    model_config = {"extra": "forbid"}

    flower: FlowerConfig = Field(default_factory=FlowerConfig)
    split: SplitConfig = Field(default_factory=SplitConfig)
    material: MaterialConfig = Field(default_factory=MaterialConfig)
    render: RenderConfig = Field(default_factory=RenderConfig)

    # ---- stage hashing: drives the incremental-regeneration cache -------
    def _hash(self, parts: list[dict]) -> str:
        blob = json.dumps(parts, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256((ENGINE_VERSION + blob).encode()).hexdigest()[:16]

    def hash_flower(self) -> str:
        return self._hash([self.flower.model_dump(mode="json")])

    def hash_split(self) -> str:
        return self._hash([self.flower.model_dump(mode="json"),
                           self.split.model_dump(mode="json")])

    def hash_scene(self) -> str:
        return self._hash([self.flower.model_dump(mode="json"),
                           self.split.model_dump(mode="json"),
                           self.material.model_dump(mode="json")])

    def hash_render(self) -> str:
        return self._hash([self.flower.model_dump(mode="json"),
                           self.split.model_dump(mode="json"),
                           self.material.model_dump(mode="json"),
                           self.render.model_dump(mode="json")])

    def diff(self, other: "DesignConfig") -> dict[str, dict[str, Any]]:
        """Flat parameter-level diff, for the version comparison view."""
        a, b = self.model_dump(mode="json"), other.model_dump(mode="json")
        out: dict[str, dict[str, Any]] = {}
        for section in a:
            for key in a[section]:
                if a[section][key] != b[section][key]:
                    out[f"{section}.{key}"] = {"from": a[section][key], "to": b[section][key]}
        return out


# --------------------------------------------------------------------------
# UI schema export
# --------------------------------------------------------------------------
def ui_schema() -> dict:
    """Flatten the model metadata into what the parameter editor needs."""
    out: dict[str, Any] = {"engine_version": ENGINE_VERSION, "sections": {}}
    for name, model in (("flower", FlowerConfig), ("split", SplitConfig),
                        ("material", MaterialConfig), ("render", RenderConfig)):
        js = model.model_json_schema()
        fields: list[dict] = []
        for fname, finfo in model.model_fields.items():
            prop = js.get("properties", {}).get(fname, {})
            extra = (finfo.json_schema_extra or {}).get("ui", {}) if isinstance(
                finfo.json_schema_extra, dict) else {}
            ann = finfo.annotation
            kind = "number"
            choices = None
            if isinstance(ann, type) and issubclass(ann, Enum):
                kind, choices = "enum", [e.value for e in ann]
            elif ann is bool:
                kind = "bool"
            elif ann is int:
                kind = "int"
            elif ann is str:
                kind = "color" if "pattern" in prop and "0-9a-fA-F" in prop.get("pattern", "") else "text"
            elif fname == "control_points":
                kind = "curve_points"
            default = finfo.default
            if isinstance(default, Enum):
                default = default.value
            if default is not None and not isinstance(default, (int, float, str, bool, list)):
                default = None
            fields.append({
                "name": fname, "kind": kind, "default": default, "choices": choices,
                "min": extra.get("min"), "max": extra.get("max"), "step": extra.get("step"),
                "unit": extra.get("unit", ""),
                "description": extra.get("description") or prop.get("description", ""),
                "group": extra.get("group", "general"),
            })
        out["sections"][name] = fields
    return out
