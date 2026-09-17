"""Blender entry point: build the scene, render, export.

Run as::

    blender -b --factory-startup -noaudio -P build_scene.py -- <job_spec.json>

Reads a mesh bundle produced by the design engine and a job spec, and does only
what Blender is uniquely good at: physically-based materials, studio lighting,
camera framing, Cycles rendering, .blend authoring and glTF export. It does not
generate or split geometry.

Progress is printed as ``AFRI_EVENT {json}`` lines so the job manager can stream
genuine stage transitions rather than inventing a timer.
"""
import json
import os
import sys
import time

import bpy  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from presets import (CAMERAS, HAT_MATERIALS, LIGHTING, MATERIALS, RENDER_PRESETS,  # noqa: E402
                     camera_transform, hex_to_rgb)

_T0 = time.time()


def event(stage, message, **extra):
    payload = {"stage": stage, "message": message,
               "elapsed": round(time.time() - _T0, 3), **extra}
    print("AFRI_EVENT " + json.dumps(payload), flush=True)


def fail(message, **extra):
    event("ERROR", message, **extra)
    print("AFRI_RESULT " + json.dumps({"ok": False, "error": message}), flush=True)
    sys.exit(3)


# ---------------------------------------------------------------------------
def mesh_from_arrays(name, verts, faces):
    """Build a Blender mesh from raw arrays via foreach_set (the fast path)."""
    me = bpy.data.meshes.new(name)
    v = np.ascontiguousarray(verts, dtype=np.float32)
    f = np.ascontiguousarray(faces, dtype=np.int32)
    me.vertices.add(len(v))
    me.vertices.foreach_set("co", v.ravel())
    me.loops.add(f.size)
    me.loops.foreach_set("vertex_index", f.ravel())
    me.polygons.add(len(f))
    me.polygons.foreach_set("loop_start", np.arange(0, f.size, 3, dtype=np.int32))
    me.polygons.foreach_set("loop_total", np.full(len(f), 3, dtype=np.int32))
    me.update()
    me.validate(verbose=False)
    ob = bpy.data.objects.new(name, me)
    ob.data.shade_smooth()
    return ob


def make_material(name, base_hex, preset, roughness, metallic, sheen, tint=0.0,
                  tint_hex=None):
    """Build a Principled BSDF.

    ``tint`` mixes the base colour toward ``tint_hex`` (the configuration's
    secondary colour). This is what lets the two pieces be told apart in a
    presentation image: with both halves in the identical colour the assembled
    flower is, correctly but unhelpfully, indistinguishable from a one-piece
    flower.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    p = MATERIALS.get(preset, MATERIALS["satin_silk"])
    col = list(hex_to_rgb(base_hex))
    if tint:
        other = list(hex_to_rgb(tint_hex or "#C9500A"))
        t = max(0.0, min(1.0, tint))
        col = [c * (1.0 - t) + o * t for c, o in zip(col, other)]
    bsdf.inputs["Base Color"].default_value = col
    bsdf.inputs["Roughness"].default_value = float(roughness if roughness is not None
                                                   else p["roughness"])
    bsdf.inputs["Metallic"].default_value = float(metallic if metallic is not None
                                                  else p["metallic"])
    for key, val in (("Sheen Weight", sheen if sheen is not None else p["sheen"]),
                     ("Specular IOR Level", p["spec"]),
                     ("Coat Weight", p["clearcoat"])):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = float(val)
    return mat


def build_world(scene, bg_hex, strength):
    world = bpy.data.worlds.new("AFRi_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    grad = nt.nodes.new("ShaderNodeTexGradient")
    mapping = nt.nodes.new("ShaderNodeMapping")
    texco = nt.nodes.new("ShaderNodeTexCoord")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    base = hex_to_rgb(bg_hex)
    ramp.color_ramp.elements[0].color = base
    ramp.color_ramp.elements[1].color = tuple(min(1.0, c * 3.2 + 0.05) for c in base[:3]) + (1.0,)
    mapping.inputs["Rotation"].default_value = (1.5708, 0.0, 0.0)
    nt.links.new(texco.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], grad.inputs["Vector"])
    nt.links.new(grad.outputs["Color"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = float(strength)
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def add_area_light(coll, name, loc, rot, energy, size, color=(1, 1, 1)):
    d = bpy.data.lights.new(name, type="AREA")
    d.energy = energy
    d.size = size
    d.color = color
    ob = bpy.data.objects.new(name, d)
    ob.location = loc
    ob.rotation_euler = rot
    coll.objects.link(ob)
    return ob


# ---------------------------------------------------------------------------
def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        fail("no job spec supplied")
    spec_path = argv[0]
    if not os.path.isfile(spec_path):
        fail(f"job spec not found: {spec_path}")
    with open(spec_path) as fh:
        spec = json.load(fh)

    bundle_path = spec["bundle"]
    outdir = spec["outdir"]
    os.makedirs(outdir, exist_ok=True)
    if not os.path.isfile(bundle_path):
        fail(f"mesh bundle not found: {bundle_path}")

    event("SCENE", "loading mesh bundle")
    data = np.load(bundle_path)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    view_layer = bpy.context.view_layer

    mat_cfg = spec.get("material", {})
    rnd_cfg = spec.get("render", {})
    radius = float(spec.get("radius", 4.5))

    # ---- collections --------------------------------------------------
    colls = {}
    for name in ("MASTER_FLOWER", "PIECE_A", "PIECE_B", "HAT", "LIGHTING",
                 "CAMERAS", "BACKGROUND"):
        c = bpy.data.collections.new(name)
        scene.collection.children.link(c)
        colls[name] = c

    # ---- materials ----------------------------------------------------
    preset = mat_cfg.get("preset", "satin_silk")
    mat_a = make_material("AFRi_PieceA", mat_cfg.get("base_color", "#F2A007"), preset,
                          mat_cfg.get("roughness"), mat_cfg.get("metallic"),
                          mat_cfg.get("sheen"))
    mat_b = make_material("AFRi_PieceB", mat_cfg.get("base_color", "#F2A007"), preset,
                          mat_cfg.get("roughness"), mat_cfg.get("metallic"),
                          mat_cfg.get("sheen"), tint=mat_cfg.get("piece_tint", 0.0),
                          tint_hex=mat_cfg.get("secondary_color"))
    mat_m = make_material("AFRi_Master", mat_cfg.get("base_color", "#F2A007"), preset,
                          mat_cfg.get("roughness"), mat_cfg.get("metallic"),
                          mat_cfg.get("sheen"))

    hat_cfg = spec.get("hat_material") or {}
    hm = HAT_MATERIALS.get(hat_cfg.get("material", "felt"), HAT_MATERIALS["felt"])
    mat_hat = make_material("AFRi_Hat", hat_cfg.get("base_color", "#2C2A27"),
                            "matte_felt", hm["roughness"], hm["metallic"], hm["sheen"])
    mat_band = make_material("AFRi_HatBand", hat_cfg.get("band_color", "#171513"),
                             "satin_silk", 0.58, 0.0, 0.30)

    # ---- geometry -----------------------------------------------------
    event("SCENE", "building objects")
    separated = bool(rnd_cfg.get("separated", False))
    sep = float(spec.get("separation", 0.0)) if separated else 0.0
    normal = spec.get("separation_normal", [1.0, 0.0])

    created = {}
    for key, coll_name, mat in (("master", "MASTER_FLOWER", mat_m),
                                ("piece_a", "PIECE_A", mat_a),
                                ("piece_b", "PIECE_B", mat_b),
                                ("hat", "HAT", mat_hat)):
        vk, fk = f"{key}_verts", f"{key}_faces"
        if vk not in data:
            continue
        ob = mesh_from_arrays(key, data[vk], data[fk])
        ob.data.materials.append(mat)
        pk = f"{key}_parts"
        if key == "hat" and pk in data:
            # The ribbon band is a separate body inside the same mesh; give it
            # its own slot so it does not read as moulded felt.
            ob.data.materials.append(mat_band)
            parts = data[pk]
            for i, poly in enumerate(ob.data.polygons):
                if i < len(parts) and parts[i] >= 6_000_000:
                    poly.material_index = 1
        if sep and key in ("piece_a", "piece_b"):
            s = 0.5 * sep * (1.0 if key == "piece_a" else -1.0)
            nz = normal[2] if len(normal) > 2 else 0.0
            ob.location = (normal[0] * s, normal[1] * s, nz * s)
        colls[coll_name].objects.link(ob)
        created[key] = ob
        event("SCENE", f"{key}: {len(ob.data.vertices)} verts, "
                       f"{len(ob.data.polygons)} faces")

    show_master = bool(spec.get("show_master", False))
    if "master" in created:
        created["master"].hide_render = not show_master
        created["master"].hide_viewport = not show_master
    for key in ("piece_a", "piece_b"):
        if key in created:
            created[key].hide_render = show_master
            created[key].hide_viewport = show_master

    # ---- backdrop ------------------------------------------------------
    # Sit the backdrop under the LOWEST piece of geometry, not at a fixed
    # -0.02. A hat brim droops several millimetres below the plane the flower
    # is built on, so a fixed floor cuts straight through it and the hat
    # renders as though it is sinking into the ground.
    lowest = 0.0
    for ob in created.values():
        if ob.hide_render:
            continue
        for v in ob.data.vertices:
            z = v.co.z + ob.location[2]
            if z < lowest:
                lowest = z
    bpy.ops.mesh.primitive_plane_add(size=max(radius, float(spec.get("frame_radius") or 0.0)) * 40)
    floor = bpy.context.active_object
    floor.name = "Backdrop"
    floor.location = (0, 0, lowest - 0.02)
    fmat = make_material("AFRi_Backdrop", rnd_cfg.get("background", "#14161A"),
                         "matte_felt", 0.85, 0.0, 0.0)
    floor.data.materials.append(fmat)
    for c in floor.users_collection:
        c.objects.unlink(floor)
    colls["BACKGROUND"].objects.link(floor)

    # ---- lighting ------------------------------------------------------
    event("LIGHTING", f"rig: {rnd_cfg.get('lighting', 'studio_soft')}")
    key_e, fill_e, rim_e, key_size, world_s = LIGHTING.get(
        rnd_cfg.get("lighting", "studio_soft"), LIGHTING["studio_soft"])
    # Light the whole subject, not just the flower. On a hat the subject is
    # four times the flower's radius, and a rig scaled to the flower puts every
    # lamp INSIDE the brim: the crown is lit from point-blank range and the
    # brim edges stay black. Energy follows the inverse square of the new
    # distance, so the exposure holds as the subject changes size.
    lit_r = float(spec.get("frame_radius") or 0.0) or radius
    d = lit_r * 3.0
    gain = (lit_r / radius) ** 2 if radius > 1e-9 else 1.0
    add_area_light(colls["LIGHTING"], "Key", (-d * 0.8, -d * 0.9, d * 1.25),
                   (0.72, 0.0, -0.72), key_e * gain, key_size * gain ** 0.5,
                   (1.0, 0.97, 0.93))
    add_area_light(colls["LIGHTING"], "Fill", (d * 1.15, -d * 0.55, d * 0.55),
                   (1.15, 0.0, 1.10), fill_e * gain, key_size * 1.5 * gain ** 0.5,
                   (0.90, 0.94, 1.0))
    add_area_light(colls["LIGHTING"], "Rim", (d * 0.15, d * 1.3, d * 0.95),
                   (-0.95, 0.0, 0.12), rim_e * gain, key_size * 0.8 * gain ** 0.5,
                   (1.0, 0.99, 0.96))
    build_world(scene, rnd_cfg.get("background", "#14161A"), world_s)

    # ---- cameras -------------------------------------------------------
    # When the pieces are parted they occupy the flower's radius plus half the
    # gap, in the separation direction. Frame for that, not for the flower alone.
    frame_r = float(spec.get("frame_radius") or 0.0) or (radius + (sep * 0.5 if sep else 0.0))
    active = rnd_cfg.get("camera", "three_quarter")
    for name in CAMERAS:
        cd = bpy.data.cameras.new(f"cam_{name}")
        loc, rot, focal = camera_transform(name, frame_r)
        cd.lens = focal
        ob = bpy.data.objects.new(f"cam_{name}", cd)
        ob.location = loc
        ob.rotation_euler = rot
        colls["CAMERAS"].objects.link(ob)
        if name == active:
            scene.camera = ob
    if scene.camera is None:
        fail("no camera matched the requested preset")

    # ---- render settings ----------------------------------------------
    quality = rnd_cfg.get("quality", "preview")
    rp = RENDER_PRESETS.get(quality, RENDER_PRESETS["preview"])
    res = int(rnd_cfg.get("resolution") or rp["resolution"])
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"          # verified: no GPU/EGL on this machine
    scene.cycles.samples = rp["samples"]
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.01
    scene.cycles.max_bounces = rp["max_bounces"]
    scene.cycles.use_denoising = rp["denoise"]
    scene.render.resolution_x = scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Filmic" if "Filmic" in [
        v.identifier for v in
        bpy.types.ColorManagedViewSettings.bl_rna.properties["view_transform"].enum_items
    ] else "Standard"

    outputs = {}

    # ---- glTF export for the browser viewer ----------------------------
    if spec.get("export_glb", True):
        event("EXPORT", "exporting GLB for the viewer")
        glb = os.path.join(outdir, "viewer.glb")
        for ob in bpy.data.objects:
            ob.hide_viewport = False
        bpy.ops.object.select_all(action="DESELECT")
        for key in ("master", "piece_a", "piece_b"):
            if key in created:
                created[key].select_set(True)
        try:
            bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB",
                                      use_selection=True, export_apply=True,
                                      export_yup=True)
            if os.path.isfile(glb) and os.path.getsize(glb) > 0:
                outputs["glb"] = glb
                event("EXPORT", f"GLB written ({os.path.getsize(glb)} bytes)")
            else:
                event("WARNING", "GLB export produced no file")
        except Exception as exc:
            event("WARNING", f"GLB export failed: {exc!r}")
        for key in ("master",):
            if key in created:
                created[key].hide_viewport = not show_master
        for key in ("piece_a", "piece_b"):
            if key in created:
                created[key].hide_viewport = show_master

    # ---- extra mesh exports --------------------------------------------
    for fmt in spec.get("export_meshes", []):
        for key in ("piece_a", "piece_b", "master"):
            if key not in created:
                continue
            bpy.ops.object.select_all(action="DESELECT")
            # A hidden object cannot be selected, and the exporter then writes a
            # valid file containing nothing: master.stl came out at 84 bytes,
            # a header with a triangle count of zero. Unhide for the export and
            # put the visibility back afterwards.
            was_hidden = created[key].hide_viewport
            created[key].hide_viewport = False
            created[key].select_set(True)
            view_layer.objects.active = created[key]
            path = os.path.join(outdir, f"{key}.{fmt}")
            try:
                if fmt == "stl":
                    bpy.ops.wm.stl_export(filepath=path, export_selected_objects=True)
                elif fmt == "obj":
                    bpy.ops.wm.obj_export(filepath=path, export_selected_objects=True)
                if os.path.isfile(path) and os.path.getsize(path) > 0:
                    outputs[f"{key}_{fmt}"] = path
            except Exception as exc:
                event("WARNING", f"{fmt} export of {key} failed: {exc!r}")
            finally:
                created[key].hide_viewport = was_hidden

    # ---- save the editable project -------------------------------------
    if spec.get("save_blend", True):
        blend = os.path.join(outdir, "scene.blend")
        event("SCENE", "saving editable .blend")
        bpy.ops.wm.save_as_mainfile(filepath=blend)
        if os.path.isfile(blend):
            outputs["blend"] = blend

    # ---- render ---------------------------------------------------------
    for shot in spec.get("shots", []):
        name = shot.get("name", "render")
        cam = shot.get("camera", active)
        if shot.get("detail") and spec.get("flower_target"):
            # A detail shot frames the accessory, not the hat it sits on.
            shot = dict(shot)
            shot.setdefault("target", spec["flower_target"])
            shot.setdefault("frame_radius",
                            float(spec.get("flower_radius") or 0.0)
                            + (float(spec.get("separation", 0.0)) * 0.5
                               if shot.get("separated") else 0.0))
        if shot.get("frame_radius") or shot.get("target"):
            # A detail shot frames something other than the whole subject, so it
            # gets its own camera rather than sharing the scene-wide one.
            cd = bpy.data.cameras.new(f"cam_shot_{name}")
            loc, rot, focal = camera_transform(
                cam, float(shot.get("frame_radius") or frame_r),
                tuple(shot.get("target") or (0.0, 0.0, 0.0)))
            cd.lens = focal
            cam_ob = bpy.data.objects.new(f"cam_shot_{name}", cd)
            cam_ob.location = loc
            cam_ob.rotation_euler = rot
            colls["CAMERAS"].objects.link(cam_ob)
        else:
            cam_ob = bpy.data.objects.get(f"cam_{cam}")
        if cam_ob is None:
            event("WARNING", f"unknown camera {cam}, skipping shot {name}")
            continue
        scene.camera = cam_ob

        if "separated" in shot or "show_master" in shot:
            sm = bool(shot.get("show_master", show_master))
            sep_shot = bool(shot.get("separated", separated))
            if "master" in created:
                created["master"].hide_render = not sm
            for key in ("piece_a", "piece_b"):
                if key in created:
                    created[key].hide_render = sm
                    s = 0.5 * float(spec.get("separation", 0.0)) * \
                        (1.0 if key == "piece_a" else -1.0) if sep_shot else 0.0
                    nz = normal[2] if len(normal) > 2 else 0.0
                    created[key].location = (normal[0] * s, normal[1] * s, nz * s)
        if "hat" in created and "show_hat" in shot:
            created["hat"].hide_render = not bool(shot["show_hat"])

        if shot.get("resolution"):
            scene.render.resolution_x = scene.render.resolution_y = int(shot["resolution"])
        if shot.get("samples"):
            scene.cycles.samples = int(shot["samples"])

        path = os.path.join(outdir, f"{name}.png")
        scene.render.filepath = path
        event("RENDER", f"rendering {name} ({cam}, {scene.render.resolution_x}px, "
                        f"{scene.cycles.samples} samples)", shot=name)
        t = time.time()
        bpy.ops.render.render(write_still=True)
        if not (os.path.isfile(path) and os.path.getsize(path) > 0):
            fail(f"render produced no file for shot {name}")
        outputs[name] = path
        event("RENDER", f"{name} complete in {time.time() - t:.1f}s "
                        f"({os.path.getsize(path)} bytes)", shot=name)

    event("DONE", "scene complete")
    print("AFRI_RESULT " + json.dumps({"ok": True, "outputs": outputs}), flush=True)


if __name__ == "__main__":
    main()
