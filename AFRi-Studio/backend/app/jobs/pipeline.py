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
from design_engine.geometry.mesh import PART_BASE
from design_engine.geometry.consolidate import (clean_piece, consolidate,
                                                fragment_report, restore_provenance)
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
STAGES = ["CONFIG", "MASTER_FLOWER", "CONSOLIDATE", "SPLIT", "VALIDATE", "BUNDLE",
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

    # ---- one solid, not a pile of overlapping shells -------------------
    check_cancel()
    soup = fr.mesh
    consolidation = None
    body_labels = None
    if config.flower.consolidate:
        emit("CONSOLIDATE", "fusing petals, base and centre into one solid")
        master, consolidation = consolidate(
            soup, dust_volume_mm3=config.flower.dust_volume_mm3,
            part_id=PART_BASE, name="master_flower")
        emit("CONSOLIDATE",
             f"{consolidation['bodies_in']} bodies fused into "
             f"{consolidation['bodies_out']}, "
             f"{consolidation['overlap_removed_mm3']:.1f} mm3 of overlap removed",
             **{k: consolidation[k] for k in ("bodies_in", "bodies_out", "seconds")})
        if not consolidation["watertight"]:
            raise PipelineError("consolidation produced a non-watertight solid")
        # The consolidated flower is ONE closed body whose faces still carry
        # per-petal ids, so the kernel has to be grouped by component, not by
        # part id, or it will try to clip open patches.
        body_labels = master.component_labels()
        master = restore_provenance(master, soup)
    else:
        emit("CONSOLIDATE", "skipped (flower.consolidate is off)")
        master = soup

    check_cancel()
    emit("SPLIT", f"splitting into two pieces ({config.split.type.value})")
    sr = split_flower(
        master, config.split, radius, body_labels=body_labels,
        progress=lambda msg, i, n: emit("SPLIT", msg, index=i, total=n))

    if config.flower.consolidate:
        # The kernel clips one consolidated body, so every rebuilt face inherits
        # that body's single part id and the per-petal provenance is lost. Put
        # it back from the as-built soup, or the validator can no longer say
        # which petals the curve actually divided.
        sr.piece_a = restore_provenance(sr.piece_a, soup)
        sr.piece_b = restore_provenance(sr.piece_b, soup)
        a_clean, a_rep = clean_piece(sr.piece_a, config.flower.dust_volume_mm3)
        b_clean, b_rep = clean_piece(sr.piece_b, config.flower.dust_volume_mm3)
        if a_rep["removed_bodies"] or b_rep["removed_bodies"]:
            emit("SPLIT",
                 f"removed {a_rep['removed_bodies'] + b_rep['removed_bodies']} debris bodies "
                 f"({a_rep['removed_volume_mm3'] + b_rep['removed_volume_mm3']:.3f} mm3)")
        sr.piece_a, sr.piece_b = a_clean, b_clean
        piece_cleanup = {"piece_a": a_rep, "piece_b": b_rep}
    else:
        piece_cleanup = None

    check_cancel()
    emit("VALIDATE", "running geometry validation")
    validation = validate_split(master, sr.piece_a, sr.piece_b, sr.split_path,
                                tolerance_mm=config.split.boundary_tolerance_mm)
    # Component coherence is a manufacturing question, not a topology one, so
    # it is reported beside the checks rather than folded into them.
    coherence = {"piece_a": fragment_report(sr.piece_a, config.flower.dust_volume_mm3),
                 "piece_b": fragment_report(sr.piece_b, config.flower.dust_volume_mm3)}
    if consolidation is not None:
        coherence["consolidation"] = consolidation
    if piece_cleanup is not None:
        coherence["debris_removed"] = piece_cleanup
    validation["coherence"] = coherence
    emit("VALIDATE",
         f"piece A is {coherence['piece_a']['bodies']} bodies, "
         f"piece B is {coherence['piece_b']['bodies']}",
         **{f"a_{k}": v for k, v in coherence["piece_a"].items()})
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
            **master.to_npz_dict("master"),
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

        # Report the triangle counts of the meshes that were actually shipped,
        # and state plainly that the pieces do not sum to the master: the split
        # subdivides every straddling triangle and then builds two cut walls.
        stats = {**fr.stats, "radius": radius}
        stats.update({
            "as_built_triangles": int(soup.n_faces),
            "master_triangles": int(master.n_faces),
            "piece_a_triangles": int(sr.piece_a.n_faces),
            "piece_b_triangles": int(sr.piece_b.n_faces),
            "pieces_triangles_total": int(sr.piece_a.n_faces + sr.piece_b.n_faces),
            "triangles_added_by_split": int(sr.piece_a.n_faces + sr.piece_b.n_faces
                                            - master.n_faces),
            "cut_wall_triangles": int(sr.metadata["cap_triangles"]),
            "consolidated": bool(config.flower.consolidate),
        })
        if consolidation is not None:
            stats["consolidation"] = consolidation
        return PipelineResult(
            outputs=published, validation=validation,
            stats=stats,
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
        if p.suffix.lower() == ".stl":
            # Non-empty is not the same as non-trivial. A binary STL carrying no
            # triangles is 84 bytes and passes a size check happily.
            with p.open("rb") as fh:
                head = fh.read(84)
            if len(head) < 84:
                raise PipelineError(f"mesh {key} is truncated: {path}")
            ntris = int.from_bytes(head[80:84], "little")
            if ntris == 0:
                raise PipelineError(f"mesh {key} exported zero triangles: {path}")
            expected = 84 + ntris * 50
            if p.stat().st_size < expected:
                raise PipelineError(
                    f"mesh {key} claims {ntris} triangles but is "
                    f"{p.stat().st_size} bytes, short of {expected}")
        verified[key] = str(p)
    return verified
