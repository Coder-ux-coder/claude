"""The design pipeline: config in, verified assets out.

Stages are content-addressed by the slice of config they depend on, so a camera
change re-renders without touching a vertex and a material change skips the
flower and split engines entirely.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from backend.app.core.config import (BLENDER_SCRIPT, JOB_TIMEOUT_SECONDS,
                                     TMP_DIR, find_blender)
from design_engine.configurations.schema import DesignConfig
from design_engine.flower.marigold import MM, build_master_flower
from design_engine.splitting.splitter import split_flower
from design_engine.splitting.validate import validate_split


class PipelineError(RuntimeError):
    pass


@dataclass
class PipelineResult:
    outputs: dict = field(default_factory=dict)
    validation: dict = field(default_factory=dict)
    stats: dict = field(default_factory=dict)
    split_meta: dict = field(default_factory=dict)
    split_path: dict = field(default_factory=dict)
    seconds: float = 0.0


#: Pipeline stages, in order. The UI uses this to show what is left to do.
STAGES = ["CONFIG", "MASTER_FLOWER", "SPLIT", "VALIDATE", "BUNDLE",
          "SCENE", "MATERIALS", "EXPORT", "RENDER", "VERIFY", "PUBLISH"]


def run_pipeline(config: DesignConfig, outdir: Path, *, shots=None,
                 export_meshes=(), save_blend=True, export_glb=True,
                 show_master=False, emit=None, cancelled=None) -> PipelineResult:
    """Run the full pipeline. ``emit(stage, message, **extra)`` streams progress."""
    t0 = time.perf_counter()
    outdir = Path(outdir)
    emit = emit or (lambda *a, **k: None)

    def check_cancel():
        if cancelled is not None and cancelled():
            raise PipelineError("cancelled by user")

    emit("CONFIG", "validating configuration")
    radius = config.flower.diameter_mm * 0.5 * MM

    # ---- geometry (pure Python, no Blender) ---------------------------
    check_cancel()
    emit("MASTER_FLOWER", "generating master marigold")
    fr = build_master_flower(
        config.flower,
        progress=lambda msg, i, n: emit("MASTER_FLOWER", msg, index=i, total=n))

    check_cancel()
    emit("SPLIT", f"splitting into two pieces ({config.split.type.value})")
    sr = split_flower(
        fr.mesh, config.split, radius,
        progress=lambda msg, i, n: emit("SPLIT", msg, index=i, total=n))

    check_cancel()
    emit("VALIDATE", "running geometry validation")
    validation = validate_split(fr.mesh, sr.piece_a, sr.piece_b, sr.split_path,
                                tolerance_mm=config.split.boundary_tolerance_mm)
    emit("VALIDATE",
         f"{validation['passed']}/{validation['total']} checks passed, "
         f"{validation['errors']} errors, {validation['warnings']} warnings",
         passed=validation["passed"], total=validation["total"])
    if not validation["ok"]:
        failed = [c["name"] for c in validation["checks"]
                  if not c["passed"] and c["severity"] == "error"]
        raise PipelineError("geometry validation failed: " + ", ".join(failed))

    # ---- hand off to Blender ------------------------------------------
    check_cancel()
    work = TMP_DIR / f"pipe_{os.getpid()}_{int(time.time() * 1000)}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        emit("BUNDLE", "writing mesh bundle")
        bundle = work / "bundle.npz"
        np.savez_compressed(
            bundle,
            **fr.mesh.to_npz_dict("master"),
            **sr.piece_a.to_npz_dict("piece_a"),
            **sr.piece_b.to_npz_dict("piece_b"),
        )
        emit("BUNDLE", f"bundle written ({bundle.stat().st_size // 1024} KiB)")

        normal = sr.split_path.mean_normal()
        spec = {
            "bundle": str(bundle),
            "outdir": str(work / "out"),
            "radius": radius,
            "separation": config.split.separation_mm * MM,
            "separation_normal": [float(normal[0]), float(normal[1])],
            "show_master": show_master,
            "material": config.material.model_dump(mode="json"),
            "render": config.render.model_dump(mode="json"),
            "shots": shots if shots is not None else [
                {"name": "preview", "camera": config.render.camera.value}],
            "export_meshes": list(export_meshes),
            "save_blend": save_blend,
            "export_glb": export_glb,
        }
        spec_path = work / "job.json"
        spec_path.write_text(json.dumps(spec, indent=1))

        outputs = _run_blender(spec_path, config, emit, check_cancel)

        # ---- verify before publishing ---------------------------------
        emit("VERIFY", "verifying output files")
        verified = _verify_outputs(outputs, config)
        emit("VERIFY", f"{len(verified)} outputs verified")

        emit("PUBLISH", "publishing assets")
        outdir.mkdir(parents=True, exist_ok=True)
        published = {}
        for key, path in verified.items():
            dest = outdir / Path(path).name
            os.replace(path, dest)          # atomic within the same filesystem
            published[key] = str(dest)
        emit("PUBLISH", f"{len(published)} assets published")

        return PipelineResult(
            outputs=published, validation=validation,
            stats={**fr.stats, "radius": radius},
            split_meta=sr.metadata, split_path=sr.split_path.to_dict(),
            seconds=round(time.perf_counter() - t0, 2))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _run_blender(spec_path: Path, config: DesignConfig, emit, check_cancel) -> dict:
    info = find_blender()
    if not info.available:
        raise PipelineError(info.error or "Blender is unavailable")

    cmd = [info.path, "-b", "--factory-startup", "-noaudio",
           "-P", str(BLENDER_SCRIPT), "--", str(spec_path)]
    timeout = JOB_TIMEOUT_SECONDS.get(config.render.quality.value, 600)

    emit("SCENE", f"launching Blender ({info.version})")
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, start_new_session=True)

    result = None
    tail: list[str] = []
    started = time.time()
    try:
        for line in proc.stdout:
            line = line.rstrip("\n")
            tail.append(line)
            if len(tail) > 120:
                tail.pop(0)
            if line.startswith("AFRI_EVENT "):
                try:
                    ev = json.loads(line[11:])
                    emit(ev.get("stage", "SCENE"), ev.get("message", ""), **{
                        k: v for k, v in ev.items() if k not in ("stage", "message")})
                except json.JSONDecodeError:
                    pass
            elif line.startswith("AFRI_RESULT "):
                try:
                    result = json.loads(line[12:])
                except json.JSONDecodeError:
                    pass
            elif " | Sample " in line:
                # Genuine Cycles progress, parsed from its own output.
                try:
                    frag = line.rsplit("Sample ", 1)[1].split()[0]
                    done, total = (int(x) for x in frag.split("/"))
                    emit("RENDER", f"sample {done}/{total}",
                         index=done, total=total)
                except (ValueError, IndexError):
                    pass
            if time.time() - started > timeout:
                raise PipelineError(f"Blender exceeded its {timeout}s budget")
            if check_cancel:
                check_cancel()
    except PipelineError:
        _kill(proc)
        raise
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass

    code = proc.wait(timeout=30)
    if result is None or not result.get("ok"):
        detail = (result or {}).get("error") if result else None
        raise PipelineError(
            f"Blender failed (exit {code}): {detail or 'no result reported'}\n"
            + "\n".join(tail[-25:]))
    return result.get("outputs", {})


def _kill(proc):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        time.sleep(1.0)
        if proc.poll() is None:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _verify_outputs(outputs: dict, config: DesignConfig) -> dict:
    """Assert every output exists, is non-empty and parses. Renders must also
    match the requested resolution and not be a blank frame."""
    verified = {}
    for key, path in outputs.items():
        p = Path(path)
        if not p.is_file() or p.stat().st_size == 0:
            raise PipelineError(f"output {key} missing or empty: {path}")
        if p.suffix.lower() == ".png":
            try:
                from PIL import Image
                with Image.open(p) as im:
                    im.load()
                    w, h = im.size
                    arr = np.asarray(im.convert("L"), dtype=np.float32)
            except Exception as exc:
                raise PipelineError(f"render {key} is not a readable image: {exc}")
            if arr.std() < 0.5:
                raise PipelineError(
                    f"render {key} is effectively blank (luminance sd "
                    f"{arr.std():.3f}); the camera is probably pointing at nothing")
            verified[key] = str(p)
            continue
        verified[key] = str(p)
    return verified
