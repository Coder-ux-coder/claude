"""Runs inside Blender. Builds the object, lights it, renders it, exports it.

Called as:  blender -b --factory-startup --python build.py -- <job folder>

The generated script only has to make geometry. Everything a picture needs --
framing, light, ground, camera, material fallbacks -- happens here, the same
way every time, so two objects made a week apart look like they came from the
same place.
"""

import json
import math
import sys
from pathlib import Path

import bpy
import bmesh          # noqa: F401  (handed to the generated script)
import mathutils
import random         # noqa: F401  (handed to the generated script)

JOB = Path(sys.argv[sys.argv.index("--") + 1])
GEOMETRY = {"MESH", "CURVE", "SURFACE", "META", "FONT"}


def fail(message):
    (JOB / "result.json").write_text(json.dumps({"ok": False, "error": message}))
    sys.exit(0)          # a build that did not work is an answer, not a crash


def empty_scene():
    for block in (bpy.data.objects, bpy.data.meshes, bpy.data.materials,
                  bpy.data.cameras, bpy.data.lights, bpy.data.curves):
        for item in list(block):
            block.remove(item, do_unlink=True)


def world_bounds(objects):
    lo = mathutils.Vector((1e9, 1e9, 1e9))
    hi = mathutils.Vector((-1e9, -1e9, -1e9))
    found = False
    for ob in objects:
        for corner in ob.bound_box:
            p = ob.matrix_world @ mathutils.Vector(corner)
            lo = mathutils.Vector(map(min, lo, p))
            hi = mathutils.Vector(map(max, hi, p))
            found = True
    return (lo, hi) if found else (None, None)


def run_generated_code():
    code = (JOB / "code.py").read_text()
    scope = {"bpy": bpy, "bmesh": bmesh, "math": math,
             "mathutils": mathutils, "random": random, "__name__": "build"}
    try:
        exec(compile(code, "generated.py", "exec"), scope)
    except Exception as e:                                   # noqa: BLE001
        fail(f"{type(e).__name__}: {e}")


def normalise(objects):
    """Put the object on the floor, centred, about two units across.

    Its real size is measured first and reported back, so framing never
    changes what the thing is actually meant to be.
    """
    lo, hi = world_bounds(objects)
    if lo is None:
        fail("The script ran but made nothing.")
    size = hi - lo
    longest = max(size.x, size.y, size.z)
    if longest < 1e-9:
        fail("The script made something with no size.")

    rig = bpy.data.objects.new("rig", None)
    bpy.context.scene.collection.objects.link(rig)
    for ob in objects:
        if ob.parent is None and ob is not rig:
            ob.parent = rig
    bpy.context.view_layer.update()

    scale = 2.0 / longest
    centre = (lo + hi) * 0.5
    rig.scale = (scale, scale, scale)
    rig.location = (-centre.x * scale, -centre.y * scale, -lo.z * scale)
    bpy.context.view_layer.update()
    return size


def dress_the_set():
    scene = bpy.context.scene

    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.055, 0.05, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
    scene.world = world

    floor_mat = bpy.data.materials.new("floor")
    floor_mat.use_nodes = True
    bsdf = floor_mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.16, 0.17, 0.16, 1)
    bsdf.inputs["Roughness"].default_value = 0.85
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, -0.002))
    bpy.context.active_object.data.materials.append(floor_mat)

    def lamp(name, energy, size, location, colour):
        data = bpy.data.lights.new(name, type="AREA")
        data.energy, data.size, data.color = energy, size, colour
        ob = bpy.data.objects.new(name, data)
        ob.location = location
        bpy.context.scene.collection.objects.link(ob)
        ob.rotation_euler = (mathutils.Vector((0, 0, 0.6)) - mathutils.Vector(location)) \
            .to_track_quat("-Z", "Y").to_euler()
        return ob

    lamp("key", 900, 6, (3.4, -4.2, 5.0), (1.0, 0.97, 0.92))
    lamp("fill", 220, 8, (-4.6, -2.2, 2.4), (0.88, 0.93, 1.0))
    lamp("rim", 420, 4, (-2.0, 4.6, 3.4), (1.0, 0.93, 0.86))


def place_camera():
    data = bpy.data.cameras.new("camera")
    data.lens = 58
    cam = bpy.data.objects.new("camera", data)
    cam.location = (4.1, -5.2, 3.3)
    bpy.context.scene.collection.objects.link(cam)

    target = bpy.data.objects.new("target", None)
    target.location = (0, 0, 0.9)
    bpy.context.scene.collection.objects.link(target)
    track = cam.constraints.new("TRACK_TO")
    track.target = target
    bpy.context.scene.camera = cam


def give_everything_a_surface(objects):
    """Anything left without a material gets a neutral one, so nothing renders
    as an untextured black blob when the script forgot."""
    default = bpy.data.materials.new("surface")
    default.use_nodes = True
    bsdf = default.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.62, 0.62, 0.60, 1)
    bsdf.inputs["Roughness"].default_value = 0.45
    for ob in objects:
        if ob.type == "MESH" and not ob.data.materials:
            ob.data.materials.append(default)


def render(path):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 28
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 720
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    # AgX keeps highlights from clipping; the punchy look puts back the
    # saturation a plain tone map takes out, so a colour the script asked for
    # is the colour that comes back.
    scene.view_settings.view_transform = "AgX"
    for look in ("AgX - Punchy", "Punchy", "None"):
        try:
            scene.view_settings.look = look
            break
        except TypeError:
            continue
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def main():
    empty_scene()
    run_generated_code()

    objects = [o for o in bpy.data.objects if o.type in GEOMETRY]
    if not objects:
        fail("The script ran but made nothing.")

    size = normalise(objects)
    give_everything_a_surface(objects)
    dress_the_set()
    place_camera()
    render(JOB / "view.png")

    bpy.ops.export_scene.gltf(filepath=str(JOB / "model.glb"), export_format="GLB")
    bpy.ops.wm.save_as_mainfile(filepath=str(JOB / "scene.blend"))

    triangles = 0
    for ob in objects:
        if ob.type == "MESH":
            mesh = ob.data
            mesh.calc_loop_triangles()
            triangles += len(mesh.loop_triangles)

    (JOB / "result.json").write_text(json.dumps({
        "ok": True,
        "parts": len(objects),
        "triangles": triangles,
        # Blender's unit is the metre, and the script is asked to build at real
        # size, so this is the object's actual size in centimetres.
        "size_cm": [round(size.x * 100, 1), round(size.y * 100, 1), round(size.z * 100, 1)],
    }))


main()
