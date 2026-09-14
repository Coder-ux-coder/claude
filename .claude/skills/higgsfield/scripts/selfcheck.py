#!/usr/bin/env python3
"""Validate the Higgsfield integration without spending a credit.

Every check here runs offline against the generated catalogue: catalogue
integrity, model resolution, parameter validation, request shaping, and
credential redaction. Nothing is submitted, so this is safe to run in CI and
safe to run without an account.

    python3 selfcheck.py            offline checks only
    python3 selfcheck.py --live     also verify the endpoint accepts our
                                    User-Agent and rejects a bad key with 401
                                    (network only; still generates nothing)

A live check needs no credentials: it asserts on the API's auth response.
"""

from __future__ import annotations

import argparse
import io
import json
import pathlib
import sys
import contextlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import higgsfield as hf  # noqa: E402

PASS, FAIL = "pass", "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, PASS if condition else FAIL, detail))


def expect_error(name: str, fn, fragment: str) -> None:
    """The call must raise HiggsfieldError whose message contains fragment."""
    try:
        fn()
    except hf.HiggsfieldError as exc:
        check(name, fragment.lower() in str(exc).lower(), f"got: {str(exc)[:90]}")
    except Exception as exc:  # noqa: BLE001
        check(name, False, f"wrong exception {type(exc).__name__}: {exc}")
    else:
        check(name, False, "no error raised")


# ---------------------------------------------------------------- catalogue

def catalogue_checks(cat: dict) -> None:
    models = cat["models"]
    check("catalogue loads", bool(models), f"{len(models)} models")
    check("catalogue count matches", cat["model_count"] == len(models))
    check("base url is the API host", cat["base_url"] == "https://api.higgsfield.ai", cat["base_url"])

    every_prompt = all("prompt" in e["params"] for e in models.values())
    check("every model takes a prompt", every_prompt)

    prompt_required = all(e["params"]["prompt"].get("required") for e in models.values())
    check("prompt is required everywhere", prompt_required)

    outputs = {e["output"] for e in models.values()}
    check("outputs are image or video", outputs <= {"image", "video"}, str(outputs))

    bad_paths = [p for p in models if not p.startswith("/")]
    check("paths are absolute", not bad_paths, str(bad_paths[:3]))

    # Media requirements must name a real parameter of that model.
    broken = [
        f"{p}:{m}" for p, e in models.items()
        for m in e["requires_media"] if m not in e["params"]
    ]
    check("required media params exist", not broken, str(broken[:3]))

    # Enum defaults must be members of their own enum.
    bad_defaults = [
        f"{p}.{n}" for p, e in models.items() for n, s in e["params"].items()
        if "enum" in s and "default" in s and str(s["default"]) not in [str(x) for x in s["enum"]]
    ]
    check("enum defaults are valid members", not bad_defaults, str(bad_defaults[:3]))

    families = {e["family"] for e in models.values()}
    check("families are populated", all(families) and len(families) > 5, f"{len(families)} families")


# --------------------------------------------------------------- resolution

def resolution_checks(cat: dict) -> None:
    check("resolves a full path",
          hf.resolve_model("/veo3.1/image-to-video", cat) == "/veo3.1/image-to-video")
    check("resolves without leading slash",
          hf.resolve_model("veo3.1/image-to-video", cat) == "/veo3.1/image-to-video")
    check("resolves a unique fragment",
          hf.resolve_model("soul/standard", cat) == "/higgsfield-ai/soul/standard")
    expect_error("rejects an ambiguous fragment",
                 lambda: hf.resolve_model("sora-2", cat), "matches 4 models")
    expect_error("suggests a near miss",
                 lambda: hf.resolve_model("veo31/image-to-video", cat), "did you mean")


# --------------------------------------------------------------- validation

def validation_checks(cat: dict) -> None:
    models = cat["models"]

    sora = "/sora-2/text-to-video"
    body = hf.validate(sora, models[sora], {"prompt": "a street at dusk", "duration": "8"})
    check("accepts a valid request", body == {"prompt": "a street at dusk", "duration": 8}, str(body))

    expect_error("rejects a bad enum value",
                 lambda: hf.validate(sora, models[sora], {"prompt": "x", "duration": "7"}),
                 "not allowed")
    expect_error("rejects an unknown parameter",
                 lambda: hf.validate(sora, models[sora], {"prompt": "x", "aspect": "16:9"}),
                 "unknown parameter")
    expect_error("suggests a near-miss parameter",
                 lambda: hf.validate(sora, models[sora], {"prompt": "x", "aspect": "16:9"}),
                 "did you mean aspect_ratio")

    i2v = "/veo3.1/image-to-video"
    expect_error("rejects a missing required image",
                 lambda: hf.validate(i2v, models[i2v], {"prompt": "x"}),
                 "missing required parameter 'image_url'")
    expect_error("rejects a missing prompt",
                 lambda: hf.validate(sora, models[sora], {}),
                 "missing required parameter 'prompt'")

    # Every problem is reported at once, not one per run.
    try:
        hf.validate(sora, models[sora], {"duration": "99", "bogus": "1"})
    except hf.HiggsfieldError as exc:
        check("reports all problems together", str(exc).count("- ") >= 3, str(exc).count("- "))

    soul = "/higgsfield-ai/soul/standard"
    expect_error("enforces a maximum",
                 lambda: hf.validate(soul, models[soul], {"prompt": "x", "num_images": "9"}),
                 "above the maximum")
    expect_error("enforces a minimum",
                 lambda: hf.validate(soul, models[soul], {"prompt": "x", "num_images": "0"}),
                 "below the minimum")

    # Type coercion: CLI strings must reach the API as the declared JSON type.
    body = hf.validate(i2v, models[i2v], {
        "prompt": "x", "image_url": "https://e/x.jpg", "generate_audio": "true",
    })
    check("coerces booleans", body["generate_audio"] is True, repr(body.get("generate_audio")))

    nano = "/nano-banana"
    body = hf.validate(nano, models[nano], {"prompt": "x", "input_images": "https://a/1.jpg,https://b/2.jpg"})
    check("coerces comma lists to arrays", body["input_images"] == ["https://a/1.jpg", "https://b/2.jpg"],
          repr(body.get("input_images")))

    # veo3.1 declares duration as a string enum; it must not be silently int-ified.
    veo = "/veo3.1"
    body = hf.validate(veo, models[veo], {"prompt": "x", "duration": "8"})
    check("preserves declared enum types", body["duration"] == "8" and isinstance(body["duration"], str),
          repr(body.get("duration")))

    # veo3.1 marks resolution/aspect_ratio/generate_audio required *and* gives
    # them defaults. A prompt alone must still produce a complete request.
    body = hf.validate(veo, models[veo], {"prompt": "x"})
    check("fills required params that carry a default",
          body.get("resolution") == "720" and body.get("aspect_ratio") == "16:9"
          and body.get("generate_audio") is False, str(body))
    # Property test across the whole catalogue: a minimal payload built only
    # from genuinely-required parameters must validate for every model. This is
    # what catches a catalogue/validator mismatch after the API adds models.
    def minimal(entry):
        payload = {}
        for name, spec in entry["params"].items():
            if not spec.get("required") or "default" in spec:
                continue
            if "enum" in spec:
                payload[name] = str(spec["enum"][0])
            elif spec.get("type") == "array":
                payload[name] = "https://example.com/a.jpg"
            elif spec.get("type") in ("integer", "number"):
                payload[name] = str(spec.get("minimum", 1))
            elif spec.get("type") == "boolean":
                payload[name] = "false"
            elif name.endswith("_url") or name.endswith("_urls"):
                payload[name] = "https://example.com/a.jpg"
            else:
                payload[name] = "x"
        return payload

    unbuildable = []
    for path, entry in models.items():
        try:
            hf.validate(path, entry, minimal(entry))
        except hf.HiggsfieldError as exc:
            unbuildable.append(f"{path}: {str(exc)[:60]}")
    check("every model accepts a minimal payload", not unbuildable,
          f"{len(unbuildable)} failed: {unbuildable[:2]}")


# ----------------------------------------------------------------- security

def security_checks() -> None:
    secret = "sk-live-abcdef123456"
    text = f"Authorization: Key id:{secret} failed"
    check("redacts secrets", secret not in hf.redact(text, secret), hf.redact(text, secret))
    check("ignores trivially short values", hf.redact("abc", "ab") == "abc")

    check("user agent is not the python default",
          "python-urllib" not in hf.USER_AGENT.lower(), hf.USER_AGENT)
    check("user agent is named", "higgsfield" in hf.USER_AGENT.lower())

    # A combined key pasted into the wrong variable must still work.
    import os
    saved = {k: os.environ.pop(k, None) for k in
             ("HF_API_KEY_ID", "HF_API_KEY_SECRET", "HF_KEY", "HF_API_KEY", "HF_API_SECRET")}
    try:
        os.environ["HF_API_KEY_ID"] = "the-id:the-secret"
        key_id, sec, _ = hf.load_credentials()
        check("splits a combined key pasted into the id", (key_id, sec) == ("the-id", "the-secret"),
              f"{key_id}/{sec}")
        del os.environ["HF_API_KEY_ID"]

        os.environ["HF_KEY"] = "no-colon-here"
        expect_error("rejects a malformed HF_KEY", hf.load_credentials, "key-id:key-secret")
        del os.environ["HF_KEY"]
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v


# ------------------------------------------------------------ request shape

def shaping_checks(cat: dict) -> None:
    """The dry-run path must produce a correct request without credentials."""
    import os
    saved = {k: os.environ.pop(k, None) for k in
             ("HF_API_KEY_ID", "HF_API_KEY_SECRET", "HF_KEY", "HF_API_KEY", "HF_API_SECRET")}
    try:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = hf.main([
                "run", "veo3.1/image-to-video", "--prompt", "a test",
                "--image", "https://example.com/f.jpg", "-p", "duration=8", "--dry-run",
            ])
        check("dry run succeeds without credentials", code == 0, f"exit {code}")
        payload = json.loads(buf.getvalue())
        check("dry run targets the right url",
              payload["url"] == "https://api.higgsfield.ai/veo3.1/image-to-video", payload["url"])
        check("dry run carries the prompt", payload["body"]["prompt"] == "a test")
        check("dry run maps --image to image_url",
              payload["body"]["image_url"] == "https://example.com/f.jpg")

        # A local-file --image would need an upload, which needs credentials.
        expect_error("requires credentials to upload a local file",
                     lambda: hf.resolve_media(__file__, hf.Credentials(), cat["base_url"], quiet=True),
                     "no higgsfield credentials")
        expect_error("rejects media that is neither url nor file",
                     lambda: hf.resolve_media("not-a-thing", hf.Credentials(), cat["base_url"], quiet=True),
                     "neither an https url nor an existing file")
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v


# -------------------------------------------------------------- output scan

def output_checks() -> None:
    image = {"status": "completed", "request_id": "r1",
             "images": [{"url": "https://cdn/a.jpg"}, {"url": "https://cdn/b.jpg"}]}
    check("finds image outputs", hf.collect_outputs(image) ==
          [("image_1", "https://cdn/a.jpg"), ("image_2", "https://cdn/b.jpg")])

    video = {"status": "completed", "request_id": "r2", "video": {"url": "https://cdn/v.mp4"}}
    check("finds video output", hf.collect_outputs(video) == [("video", "https://cdn/v.mp4")])

    audio = {"status": "completed", "audio": {"url": "https://cdn/a.mp3"},
             "audios": [{"url": "https://cdn/a.mp3"}]}
    check("does not double count audio", len(hf.collect_outputs(audio)) == 1)

    check("handles an empty result", hf.collect_outputs({"status": "failed"}) == [])
    check("terminal states are complete",
          hf.TERMINAL == {"completed", "failed", "nsfw", "canceled"}, str(hf.TERMINAL))


# --------------------------------------------------------------------- live

def live_checks(cat: dict) -> None:
    """Network only. Proves the endpoint is reachable and our agent is accepted."""
    url = f"{cat['base_url']}/requests/00000000-0000-0000-0000-000000000000/status"
    try:
        hf.api_call("GET", url, "selfcheck-not-a-real-key", "selfcheck-not-a-real-secret",
                    timeout=30, retries=0)
        check("live: endpoint reachable", True, "unexpectedly authorised")
    except hf.ApiError as exc:
        check("live: endpoint reachable", True, f"HTTP {exc.status}")
        check("live: not blocked by the CDN", exc.status != 403,
              "403/1010 means the User-Agent was rejected" if exc.status == 403 else "")
        check("live: bad credentials give 401", exc.status == 401, f"got {exc.status}")
    except hf.HiggsfieldError as exc:
        check("live: endpoint reachable", False, str(exc)[:90])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", action="store_true", help="also run the network reachability checks")
    args = ap.parse_args()

    cat = hf.load_catalogue()
    catalogue_checks(cat)
    resolution_checks(cat)
    validation_checks(cat)
    security_checks()
    shaping_checks(cat)
    output_checks()
    if args.live:
        live_checks(cat)

    width = max(len(n) for n, _, _ in results)
    for name, status, detail in results:
        marker = "  " if status == PASS else ">>"
        suffix = f"   {detail}" if detail and status == FAIL else ""
        print(f"{marker} {name:<{width}}  {status}{suffix}")

    failed = [r for r in results if r[1] == FAIL]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print(f"{len(failed)} FAILED", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
