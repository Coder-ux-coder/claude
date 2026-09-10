#!/usr/bin/env python3
"""Prove the linter catches the bugs it claims to.

A linter that passes everything is worse than none: it manufactures confidence.
Each case below breaks one thing and asserts the linter says so.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

from lint_blueprints import lint

BP = json.loads((Path(__file__).parent / "blueprints" /
                 "01-identity-and-email-waterfall.json").read_text())


def errors(bp) -> list[str]:
    findings, _ = lint(bp, "test")
    return [f.message for f in findings if f.level == "error"]


def warnings(bp) -> list[str]:
    findings, _ = lint(bp, "test")
    return [f.message for f in findings if f.level == "warn"]


def case(name, mutate, expect_fragment, level="error"):
    bp = copy.deepcopy(BP)
    mutate(bp)
    found = errors(bp) if level == "error" else warnings(bp)
    hit = any(expect_fragment in m for m in found)
    print(f"  {'PASS' if hit else 'FAIL'}  {name}")
    if not hit:
        print(f"        expected {expect_fragment!r} in {found}")
    return hit


def main() -> int:
    print("Baseline")
    base = errors(copy.deepcopy(BP))
    print(f"  {'PASS' if not base else 'FAIL'}  clean blueprint reports no errors")
    ok = not base

    print("\nDetection")
    # A reference to a module that was deleted or renumbered.
    ok &= case("reference to a non-existent module",
               lambda b: b["flow"][2]["mapper"].__setitem__(
                   "data", '{"x":"{{99.data.person.name}}"}'),
               "references module 99, which does not exist")

    # The classic Make bug: mapping from a module that runs later.
    ok &= case("reference to a downstream module",
               lambda b: b["flow"][2]["mapper"].__setitem__(
                   "data", '{"x":"{{5.data.response.email}}"}'),
               "is not upstream")

    # A router route referencing a sibling route's module -- invisible at run time.
    def cross_route(b):
        router = b["flow"][5]
        route_b = router["routes"][1]["flow"][0]
        route_b["mapper"]["data"] = '{"x":"{{7.values.G}}"}'
    ok &= case("reference across sibling router routes", cross_route,
               "is not upstream")

    ok &= case("duplicate module id",
               lambda b: b["flow"][3].__setitem__("id", 3),
               "duplicate module id 3")

    ok &= case("HTTP module with no error handler",
               lambda b: b["flow"][2].pop("onerror"),
               "no error handler")

    ok &= case("error handler that is not Resume",
               lambda b: b["flow"][2]["onerror"][0].__setitem__(
                   "module", "builtin:Ignore"),
               "not builtin:Resume", level="warn")

    ok &= case("malformed filter condition",
               lambda b: b["flow"][5]["routes"][0]["flow"][0]["filter"]
                          .__setitem__("conditions", [[{"b": "x"}]]),
               "missing 'a' or 'o'")

    ok &= case("numeric column reference inside a formula",
               lambda b: b["flow"][3]["mapper"]["variables"][0].__setitem__(
                   "value", '{{ifempty(1.12; "x")}}'),
               "ambiguous with a decimal literal")

    ok &= case("hard-coded connection id",
               lambda b: b["flow"][0]["parameters"].__setitem__(
                   "__IMTCONN__", 123456),
               "hard-coded", level="warn")

    print(f"\n{'ALL CHECKS PASS' if ok else 'SOME CHECKS FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
