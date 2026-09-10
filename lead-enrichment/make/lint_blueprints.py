#!/usr/bin/env python3
"""Static checks for Make blueprints.

Make's own schema validator is structural only: it confirms the JSON shape but
not that ``{{7.data.email}}`` refers to a module that exists, runs *before* this
one, and is reachable on the same route. Those are the mistakes that import
cleanly and then fail at run time on row 1 -- which is exactly the failure this
build cannot afford.

Checks performed:

1. every module id is unique across the whole blueprint, routes included
2. every ``{{N.…}}`` reference names a module that exists
3. every reference points *upstream* -- to a module that has already run on the
   route the reference sits on
4. placeholders ({{UPPERCASE}}) are collected, so the setup guide can list
   exactly what has to be filled in
5. every HTTP module has an error handler, so one provider outage cannot end a
   2,000-row run
6. filters are well-formed and reference resolvable modules
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

#: {{12.data.x}} or {{12.__ROW_NUMBER__}} -- a numeric module reference.
MODULE_REF = re.compile(r"\{\{[^}]*?\b(\d+)\.")
#: {{SPREADSHEET_ID}} -- an all-caps placeholder the operator must replace.
PLACEHOLDER = re.compile(r"\{\{([A-Z][A-Z0-9_]{2,})\}\}")
#: A numeric field reference (1.12 = module 1, column M) sitting inside a
#: formula, where Make cannot tell it from the decimal literal 1.12. Safe as a
#: whole expression, unsafe as a function argument -- and the failure is silent.
NUMERIC_IN_FORMULA = re.compile(r"[(,;+]\s*\d+\.\d+\b")


class Finding:
    def __init__(self, level: str, where: str, message: str):
        self.level, self.where, self.message = level, where, message

    def __str__(self) -> str:
        mark = {"error": "ERROR", "warn": " WARN"}[self.level]
        return f"  {mark}  {self.where}: {self.message}"


def walk(flow: list, path: str = "flow", upstream: tuple = ()
         ) -> list[tuple[dict, str, tuple]]:
    """Yield (module, path, ids-visible-to-it) for every module.

    A module can reference anything earlier on its own route, plus everything on
    the routes it is nested inside -- which is exactly Make's visibility rule.
    """
    out: list[tuple[dict, str, tuple]] = []
    seen = list(upstream)
    for i, mod in enumerate(flow):
        here = f"{path}[{i}]#{mod.get('id')}"
        out.append((mod, here, tuple(seen)))
        seen.append(mod.get("id"))
        for handler in (mod.get("onerror") or []):
            out.append((handler, f"{here}.onerror", tuple(seen)))
            seen.append(handler.get("id"))
        for r, route in enumerate(mod.get("routes") or []):
            out.extend(walk(route.get("flow", []), f"{here}.routes[{r}]",
                            tuple(seen)))
    return out


def strings_in(obj) -> list[str]:
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, dict):
        return [s for v in obj.values() for s in strings_in(v)]
    if isinstance(obj, list):
        return [s for v in obj for s in strings_in(v)]
    return []


def lint(bp: dict, name: str) -> tuple[list[Finding], set[str]]:
    findings: list[Finding] = []
    placeholders: set[str] = set()
    modules = walk(bp.get("flow", []))

    # 1 -- unique ids
    ids: dict[int, str] = {}
    for mod, where, _ in modules:
        mid = mod.get("id")
        if mid is None:
            findings.append(Finding("error", where, "module has no id"))
            continue
        if mid in ids:
            findings.append(Finding(
                "error", where, f"duplicate module id {mid} (also at {ids[mid]})"))
        ids[mid] = where

    for mod, where, visible in modules:
        payload = {k: v for k, v in mod.items()
                   if k not in ("routes", "onerror", "metadata")}
        texts = strings_in(payload)

        # 4 -- collect placeholders
        for text in texts:
            placeholders.update(PLACEHOLDER.findall(text))

        # 4b -- numeric column refs must not appear inside formulas
        for text in texts:
            for expr in re.findall(r"\{\{([^}]*)\}\}", text):
                if NUMERIC_IN_FORMULA.search(expr):
                    findings.append(Finding(
                        "error", where,
                        f"numeric column reference inside a formula is ambiguous "
                        f"with a decimal literal: {expr[:70]}"))

        # 2 and 3 -- references must exist and be upstream
        for text in texts:
            for ref in {int(m) for m in MODULE_REF.findall(text)}:
                if ref not in ids:
                    findings.append(Finding(
                        "error", where,
                        f"references module {ref}, which does not exist"))
                elif ref not in visible and ref != mod.get("id"):
                    findings.append(Finding(
                        "error", where,
                        f"references module {ref}, which is not upstream on this "
                        f"route (it runs later, or sits on a different branch)"))

        # 5 -- HTTP calls need an error handler
        if mod.get("module") == "http:ActionSendData":
            handlers = [h.get("module") for h in (mod.get("onerror") or [])]
            if not handlers:
                findings.append(Finding(
                    "error", where,
                    "HTTP module has no error handler; one provider outage would "
                    "stop the whole run"))
            elif "builtin:Resume" not in handlers:
                findings.append(Finding(
                    "warn", where,
                    f"error handler is {handlers}, not builtin:Resume -- the "
                    f"waterfall expects a failed provider to yield empty output"))

        # 6 -- filters
        flt = mod.get("filter")
        if flt is not None:
            if not isinstance(flt.get("conditions"), list):
                findings.append(Finding("error", where,
                                        "filter has no conditions array"))
            else:
                for group in flt["conditions"]:
                    if not isinstance(group, list):
                        findings.append(Finding(
                            "error", where,
                            "filter conditions must be an array of arrays "
                            "(outer = OR, inner = AND)"))
                        continue
                    for cond in group:
                        if "a" not in cond or "o" not in cond:
                            findings.append(Finding(
                                "error", where,
                                f"filter condition missing 'a' or 'o': {cond}"))

    # connections must be left unset so import prompts for them
    for mod, where, _ in modules:
        params = mod.get("parameters") or {}
        if "__IMTCONN__" in params and params["__IMTCONN__"] not in (None, 0):
            findings.append(Finding(
                "warn", where,
                "__IMTCONN__ is hard-coded; it should be null so Make prompts "
                "on import"))

    return findings, placeholders


def main(argv: list[str]) -> int:
    paths = [Path(p) for p in argv[1:]] or sorted(
        (Path(__file__).parent / "blueprints").glob("*.json"))
    total_errors = 0
    all_placeholders: set[str] = set()

    for path in paths:
        bp = json.loads(path.read_text(encoding="utf-8"))
        findings, placeholders = lint(bp, path.name)
        all_placeholders |= placeholders
        errors = [f for f in findings if f.level == "error"]
        total_errors += len(errors)

        modules = walk(bp.get("flow", []))
        status = "FAIL" if errors else "ok"
        print(f"\n{path.name}  [{status}]")
        print(f"  {len(modules)} modules · {bp['name']}")
        for f in findings:
            print(f)
        if not findings:
            print("  no findings")

    print("\nPlaceholders to fill in before running:")
    for p in sorted(all_placeholders):
        print(f"  {{{{{p}}}}}")

    print(f"\n{total_errors} error(s)")
    return 1 if total_errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
