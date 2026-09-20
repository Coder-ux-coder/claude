"""What a generated script is allowed to do.

The script that builds your object is written by Claude and then run by
Blender. That is real code execution, so it is checked first against a short
allow-list: a handful of imports, no file access, no network, no shell.

This is a guard, not a sandbox. It raises the cost of a bad script; it does not
make one harmless. Anything running this for other people should also put
Blender in a container with no network and nothing writable outside the job
folder. That is said plainly in the README rather than implied here.
"""

import ast

ALLOWED_IMPORTS = {"bpy", "bmesh", "math", "mathutils", "random", "colorsys"}

BANNED_CALLS = {
    "eval", "exec", "compile", "open", "input", "__import__", "breakpoint",
    "globals", "locals", "vars", "getattr", "setattr", "delattr", "memoryview",
}

# Blender operators that reach outside the object being built.
BANNED_ATTRS = {
    "save_as_mainfile", "save_mainfile", "open_mainfile", "read_homefile",
    "read_factory_settings", "execfile", "quit_blender", "url_open",
    "path_open", "console_toggle", "system", "popen", "Popen", "register_module",
}

MAX_CHARS = 40_000
MAX_LINES = 900


def check(code: str) -> list[str]:
    """Every reason this script may not run. Empty list means it may."""
    problems: list[str] = []

    if not code.strip():
        return ["The script is empty."]
    if len(code) > MAX_CHARS:
        return [f"The script is longer than {MAX_CHARS} characters."]
    if code.count("\n") > MAX_LINES:
        return [f"The script is longer than {MAX_LINES} lines."]

    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"Line {e.lineno}: the script does not parse ({e.msg})."]

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in ALLOWED_IMPORTS:
                    problems.append(f"Line {node.lineno}: cannot import {alias.name}.")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if node.level or root not in ALLOWED_IMPORTS:
                problems.append(f"Line {node.lineno}: cannot import from {node.module}.")
        elif isinstance(node, ast.Name) and node.id in BANNED_CALLS:
            problems.append(f"Line {node.lineno}: cannot use {node.id}.")
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__"):
                problems.append(f"Line {node.lineno}: cannot reach {node.attr}.")
            elif node.attr in BANNED_ATTRS:
                problems.append(f"Line {node.lineno}: cannot call {node.attr}.")

    # Same reason repeated many times is one problem to the person reading it.
    seen, unique = set(), []
    for p in problems:
        key = p.split(": ", 1)[-1]
        if key not in seen:
            seen.add(key)
            unique.append(p)
    return unique[:8]
