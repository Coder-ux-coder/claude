#!/usr/bin/env python3
"""Higgsfield API client: submit generation requests, poll them, fetch the media.

Standard library only -- no pip install, no third-party HTTP stack.

Every request is validated against the generated catalogue in models.json
before it leaves the machine, because a rejected request still costs a
round trip and a malformed one can cost credits. Credentials are read from the
environment or a .env file and are redacted from all output.

    higgsfield.py doctor                      check credentials and connectivity
    higgsfield.py models --output video       list what is available
    higgsfield.py show veo3.1/image-to-video  parameters for one model
    higgsfield.py estimate <model> --prompt   cost before committing
    higgsfield.py run <model> --prompt "..."  submit, wait, download

See references/api.md for the request lifecycle and references/models.md for
model selection.
"""

from __future__ import annotations

import argparse
import difflib
import json
import mimetypes
import os
import pathlib
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Cloudflare rejects the default Python-urllib agent with HTTP 403 (error 1010)
# before the request ever reaches the API. A named agent is required.
USER_AGENT = "higgsfield-skill/1.0 (+https://docs.higgsfield.ai/docs)"

SKILL_DIR = pathlib.Path(__file__).resolve().parent.parent
CATALOGUE = SKILL_DIR / "models.json"

TERMINAL = {"completed", "failed", "nsfw", "canceled"}
SUCCESS = "completed"

# Generation is slow and model-dependent. These are ceilings, not expectations.
DEFAULT_WAIT = {"image": 600, "video": 1800}

POLL_START = 2.0
POLL_MAX = 10.0
POLL_GROWTH = 1.5

MEDIA_CONTENT_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif",
    ".wav": "audio/wav", ".mp4": "video/mp4",
}


class HiggsfieldError(Exception):
    """Anything that should stop the command with a readable message."""


class ApiError(HiggsfieldError):
    def __init__(self, status: int, detail, correlation_id: str | None = None):
        self.status = status
        self.detail = detail
        self.correlation_id = correlation_id
        hint = HTTP_HINTS.get(status, "")
        msg = f"HTTP {status}: {_render_detail(detail)}"
        if hint:
            msg += f"\n  {hint}"
        if correlation_id:
            msg += f"\n  correlation id: {correlation_id}"
        super().__init__(msg)


HTTP_HINTS = {
    400: "Invalid parameters, rejected input, or account concurrency reached. Wait for a request to finish, or correct the request.",
    401: "Credentials missing or invalid. Run `higgsfield.py doctor`.",
    403: "Insufficient credits. Top up at https://cloud.higgsfield.ai.",
    404: "Request or model not found for this account.",
    422: "Request body failed server-side validation.",
    423: "Model is temporarily blocked. Retry later.",
    500: "Server error. Safe to retry a status check; do not resubmit blindly.",
    503: "Model is disabled or not ready. Retry later.",
}


def _render_detail(detail) -> str:
    if isinstance(detail, str):
        return detail
    if isinstance(detail, list):
        parts = []
        for item in detail:
            if isinstance(item, dict):
                loc = ".".join(str(x) for x in item.get("loc", []) if x != "body")
                parts.append(f"{loc or '?'}: {item.get('msg', item)}")
            else:
                parts.append(str(item))
        return "; ".join(parts)
    return json.dumps(detail)


# --------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------

def parse_dotenv(path: pathlib.Path) -> dict:
    values = {}
    try:
        text = path.read_text()
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.strip().strip('"').strip("'")
        values[key.strip()] = val
    return values


def find_dotenv() -> pathlib.Path | None:
    """Search upward from the skill and the working directory for a .env."""
    seen = []
    for start in (SKILL_DIR, pathlib.Path.cwd()):
        for parent in [start, *start.parents]:
            candidate = parent / ".env"
            if candidate in seen:
                continue
            seen.append(candidate)
            if candidate.is_file():
                return candidate
    return None


def load_credentials() -> tuple[str, str, str]:
    """Return (key_id, secret, source). Raises if nothing usable is configured."""
    env = dict(os.environ)
    source = "environment"

    if not (env.get("HF_API_KEY_ID") or env.get("HF_KEY") or env.get("HF_API_KEY")):
        dotenv = find_dotenv()
        if dotenv:
            for key, val in parse_dotenv(dotenv).items():
                env.setdefault(key, val)
            source = str(dotenv)

    key_id = env.get("HF_API_KEY_ID") or env.get("HF_API_KEY")
    secret = env.get("HF_API_KEY_SECRET") or env.get("HF_API_SECRET")

    # The SDK's combined form: HF_KEY="key-id:key-secret"
    combined = env.get("HF_KEY")
    if combined and not (key_id and secret):
        if ":" not in combined:
            raise HiggsfieldError(
                "HF_KEY must be in the form 'key-id:key-secret'.\n"
                "Set HF_API_KEY_ID and HF_API_KEY_SECRET separately if the secret contains a colon."
            )
        key_id, secret = combined.split(":", 1)

    # A combined value pasted into HF_API_KEY_ID is a common mistake.
    if key_id and not secret and ":" in key_id:
        key_id, secret = key_id.split(":", 1)

    if not key_id or not secret:
        raise HiggsfieldError(
            "No Higgsfield credentials found.\n"
            "  Create a key at https://cloud.higgsfield.ai, then either:\n"
            "    export HF_API_KEY_ID=...   export HF_API_KEY_SECRET=...\n"
            "  or put them in a .env file at the repository root (see .env.example).\n"
            "  Never commit credentials."
        )
    return key_id.strip(), secret.strip(), source


class Credentials:
    """Loaded on first use, so --dry-run and validation work without keys."""

    def __init__(self):
        self._pair = None

    def _load(self):
        if self._pair is None:
            key_id, secret, source = load_credentials()
            self._pair = (key_id, secret, source)
        return self._pair

    @property
    def key_id(self) -> str:
        return self._load()[0]

    @property
    def secret(self) -> str:
        return self._load()[1]


def redact(text: str, *secrets: str) -> str:
    for secret in secrets:
        if secret and len(secret) >= 4:
            text = text.replace(secret, "***REDACTED***")
    return text


# --------------------------------------------------------------------------
# Catalogue
# --------------------------------------------------------------------------

def load_catalogue() -> dict:
    if not CATALOGUE.exists():
        raise HiggsfieldError(
            f"Model catalogue missing at {CATALOGUE}.\nRun: python3 scripts/build_models.py"
        )
    return json.loads(CATALOGUE.read_text())


def resolve_model(name: str, catalogue: dict) -> str:
    """Accept a full path, a path without the leading slash, or a unique substring."""
    models = catalogue["models"]
    raw = name.strip()
    candidate = "/" + raw.strip("/")
    if candidate in models:
        return candidate

    lowered = raw.strip("/").lower()
    exact = [p for p in models if p.strip("/").lower() == lowered]
    if len(exact) == 1:
        return exact[0]

    partial = [p for p in models if lowered in p.lower()]
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        listing = "\n  ".join(sorted(partial))
        raise HiggsfieldError(f"'{name}' matches {len(partial)} models:\n  {listing}")

    close = difflib.get_close_matches(lowered, [p.strip('/') for p in models], n=5, cutoff=0.4)
    hint = ("\n  Did you mean:\n    " + "\n    ".join(close)) if close else ""
    raise HiggsfieldError(
        f"No model matches '{name}'.{hint}\n  List them with: higgsfield.py models"
    )


# --------------------------------------------------------------------------
# Parameter validation -- runs before anything is submitted
# --------------------------------------------------------------------------

def coerce(name: str, raw, spec: dict):
    """Turn a CLI string into the type the schema demands."""
    ptype = spec.get("type", "string")
    if not isinstance(raw, str):
        return raw

    if ptype == "integer":
        try:
            return int(raw)
        except ValueError:
            raise HiggsfieldError(f"--param {name}: '{raw}' is not an integer")
    if ptype == "number":
        try:
            return float(raw)
        except ValueError:
            raise HiggsfieldError(f"--param {name}: '{raw}' is not a number")
    if ptype == "boolean":
        low = raw.strip().lower()
        if low in ("true", "1", "yes", "on"):
            return True
        if low in ("false", "0", "no", "off"):
            return False
        raise HiggsfieldError(f"--param {name}: '{raw}' is not a boolean (use true/false)")
    if ptype == "array":
        if raw.strip().startswith("["):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    return parsed
            except json.JSONDecodeError:
                pass
        return [item.strip() for item in raw.split(",") if item.strip()]
    return raw


def validate(model_path: str, entry: dict, params: dict) -> dict:
    """Return validated params or raise with every problem found at once."""
    schema = entry["params"]
    errors: list[str] = []
    clean: dict = {}

    for name, raw in params.items():
        if name not in schema:
            close = difflib.get_close_matches(name, list(schema), n=3, cutoff=0.5)
            hint = f" Did you mean {', '.join(close)}?" if close else ""
            errors.append(f"unknown parameter '{name}' for {model_path}.{hint}")
            continue

        spec = schema[name]
        try:
            value = coerce(name, raw, spec)
        except HiggsfieldError as exc:
            errors.append(str(exc))
            continue

        enum = spec.get("enum")
        if enum is not None:
            allowed_str = [str(e) for e in enum]
            if str(value) not in allowed_str:
                errors.append(
                    f"{name}={value!r} is not allowed. Valid: {', '.join(allowed_str)}"
                )
                continue
            # Preserve the enum member's declared type (some are strings of digits).
            value = next(e for e in enum if str(e) == str(value))

        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in spec and value < spec["minimum"]:
                errors.append(f"{name}={value} is below the minimum {spec['minimum']}")
                continue
            if "maximum" in spec and value > spec["maximum"]:
                errors.append(f"{name}={value} is above the maximum {spec['maximum']}")
                continue

        clean[name] = value

    for name, spec in schema.items():
        if not spec.get("required") or name in clean:
            continue
        # A few endpoints (veo3.1, soul/character) mark a parameter required and
        # also give it a default. The server wants the field present, and the
        # schema says what it should be, so send that rather than failing.
        if "default" in spec:
            clean[name] = spec["default"]
            continue
        errors.append(f"missing required parameter '{name}'")

    if errors:
        listing = "\n  - ".join(errors)
        raise HiggsfieldError(
            f"{model_path} rejected {len(errors)} parameter problem(s):\n  - {listing}\n"
            f"  Inspect the model with: higgsfield.py show {model_path.lstrip('/')}"
        )
    return clean


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def api_call(method: str, url: str, key_id: str, secret: str, body: dict | None = None,
             timeout: int = 60, retries: int = 3) -> dict:
    payload = json.dumps(body).encode() if body is not None else None
    headers = {
        "Authorization": f"Key {key_id}:{secret}",
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }
    if payload is not None:
        headers["Content-Type"] = "application/json"

    # A POST that creates a generation must never be retried automatically:
    # the API has no idempotency key, so a retry can bill twice.
    idempotent = method == "GET"
    attempt = 0
    delay = 1.0

    while True:
        attempt += 1
        req = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8") or "{}"
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                detail = json.loads(raw).get("detail", raw)
            except json.JSONDecodeError:
                detail = raw[:400]
            correlation = exc.headers.get("X-Correlation-ID") if exc.headers else None
            retryable = exc.code >= 500 and idempotent and attempt <= retries
            if not retryable:
                raise ApiError(exc.code, redact(str(detail), secret, key_id), correlation)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if not (idempotent and attempt <= retries):
                raise HiggsfieldError(
                    redact(f"Network failure calling {url}: {exc}", secret, key_id)
                )
        time.sleep(delay + random.uniform(0, 0.4))
        delay = min(delay * 2, 8.0)


# --------------------------------------------------------------------------
# File upload
# --------------------------------------------------------------------------

def upload_file(path: pathlib.Path, creds: 'Credentials', base: str) -> str:
    """Upload local media through a presigned URL and return its public URL."""
    if not path.is_file():
        raise HiggsfieldError(f"No such file: {path}")

    ext = path.suffix.lower()
    content_type = MEDIA_CONTENT_TYPES.get(ext) or mimetypes.guess_type(str(path))[0]
    if not content_type:
        raise HiggsfieldError(
            f"Cannot determine a content type for {path.name}. "
            f"Supported: {', '.join(sorted(MEDIA_CONTENT_TYPES))}"
        )

    presigned = api_call("POST", f"{base}/files/generate-upload-url", creds.key_id, creds.secret,
                         {"content_type": content_type})
    upload_url = presigned.get("upload_url")
    public_url = presigned.get("public_url")
    if not upload_url or not public_url:
        raise HiggsfieldError(f"Unexpected upload-url response: {json.dumps(presigned)[:300]}")

    data = path.read_bytes()
    # Presigned storage URLs must not receive Higgsfield credentials.
    headers = dict(presigned.get("upload_headers") or {"Content-Type": content_type})
    headers.setdefault("User-Agent", USER_AGENT)
    req = urllib.request.Request(upload_url, data=data, headers=headers, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            if resp.status not in (200, 201, 204):
                raise HiggsfieldError(f"Upload failed with HTTP {resp.status}")
    except urllib.error.HTTPError as exc:
        raise HiggsfieldError(f"Upload failed: HTTP {exc.code} {exc.read()[:200].decode('utf-8', 'replace')}")
    return public_url


def resolve_media(value: str, creds: 'Credentials', base: str, quiet: bool = False) -> str:
    """A URL passes through; a local path is uploaded first."""
    if re.match(r"^https?://", value, re.I):
        return value
    path = pathlib.Path(value).expanduser()
    if not path.exists():
        raise HiggsfieldError(f"'{value}' is neither an https URL nor an existing file")
    if not quiet:
        print(f"  uploading {path.name} ...", file=sys.stderr)
    url = upload_file(path, creds, base)
    if not quiet:
        print(f"  uploaded -> {url}", file=sys.stderr)
    return url


# --------------------------------------------------------------------------
# Polling and output
# --------------------------------------------------------------------------

def poll(status_url: str, key_id: str, secret: str, timeout: int, quiet: bool = False) -> dict:
    deadline = time.monotonic() + timeout
    delay = POLL_START
    last = None

    while True:
        result = api_call("GET", status_url, key_id, secret, timeout=30)
        status = result.get("status")
        if status != last and not quiet:
            elapsed = int(timeout - (deadline - time.monotonic()))
            print(f"  [{elapsed:>4}s] {status}", file=sys.stderr)
            last = status
        if status in TERMINAL:
            return result
        if time.monotonic() >= deadline:
            raise HiggsfieldError(
                f"Timed out after {timeout}s with status '{status}'.\n"
                f"  The request is still running. Resume with:\n"
                f"    higgsfield.py wait {result.get('request_id')}"
            )
        time.sleep(min(delay + random.uniform(0, 0.5), max(0.0, deadline - time.monotonic())))
        delay = min(delay * POLL_GROWTH, POLL_MAX)


def collect_outputs(result: dict) -> list[tuple[str, str]]:
    """Return (label, url) for every media artifact in a completed result."""
    out: list[tuple[str, str]] = []
    for idx, item in enumerate(result.get("images") or []):
        if isinstance(item, dict) and item.get("url"):
            out.append((f"image_{idx + 1}", item["url"]))
    for key in ("video", "audio", "zip", "mov", "jsx", "fbx", "ply"):
        item = result.get(key)
        if isinstance(item, dict) and item.get("url"):
            out.append((key, item["url"]))
    for idx, item in enumerate(result.get("audios") or []):
        if isinstance(item, dict) and item.get("url"):
            url = item["url"]
            if url not in [u for _, u in out]:
                out.append((f"audio_{idx + 1}", url))
    return out


def download(url: str, dest: pathlib.Path) -> pathlib.Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=300) as resp:
        suffix = dest.suffix
        if not suffix:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
            guessed = mimetypes.guess_extension(ctype) if ctype else None
            dest = dest.with_suffix(guessed or ".bin")
        dest.write_bytes(resp.read())
    return dest


def save_outputs(result: dict, outdir: pathlib.Path, quiet: bool = False) -> list[pathlib.Path]:
    """Outputs expire after about seven days, so keep a local copy."""
    saved = []
    request_id = result.get("request_id", "request")
    for label, url in collect_outputs(result):
        ext = pathlib.Path(urllib.parse.urlparse(url).path).suffix
        dest = outdir / f"{request_id}_{label}{ext}"
        saved.append(download(url, dest))
        if not quiet:
            print(f"  saved {saved[-1]}", file=sys.stderr)
    return saved


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def gather_params(args, entry: dict, creds: 'Credentials', base: str) -> dict:
    params: dict = {}
    for item in args.param or []:
        if "=" not in item:
            raise HiggsfieldError(f"--param expects KEY=VALUE, got '{item}'")
        key, _, val = item.partition("=")
        params[key.strip()] = val
    if args.prompt is not None:
        params["prompt"] = args.prompt

    if getattr(args, "image", None):
        targets = entry["requires_media"] or entry["accepts_media"]
        target = next((t for t in ("image_url", "image_urls", "input_images", "first_frame_url") if t in targets), None)
        if not target:
            raise HiggsfieldError(
                f"{args.model} takes no image input. Its media parameters: {targets or 'none'}"
            )
        urls = [resolve_media(v, creds, base, args.quiet) for v in args.image]
        if entry["params"][target].get("type") == "array":
            params[target] = urls
        else:
            if len(urls) > 1:
                raise HiggsfieldError(f"{target} accepts one image; {len(urls)} were given")
            params[target] = urls[0]
    return params


def cmd_models(args) -> int:
    catalogue = load_catalogue()
    rows = []
    for path, entry in sorted(catalogue["models"].items()):
        if args.output and entry["output"] != args.output:
            continue
        if args.kind and entry["kind"] != args.kind:
            continue
        if args.family and args.family.lower() not in entry["family"].lower():
            continue
        if args.search and args.search.lower() not in path.lower():
            continue
        rows.append((path, entry))

    if args.json:
        print(json.dumps({p: e for p, e in rows}, indent=2))
        return 0

    if not rows:
        print("No models match those filters.", file=sys.stderr)
        return 1

    width = max(len(p) for p, _ in rows)
    current_family = None
    for path, entry in rows:
        if entry["family"] != current_family:
            current_family = entry["family"]
            print(f"\n{current_family}")
        needs = f"  needs {', '.join(entry['requires_media'])}" if entry["requires_media"] else ""
        print(f"  {path:<{width}}  {entry['kind']}{needs}")
    print(f"\n{len(rows)} of {catalogue['model_count']} models")
    return 0


def cmd_show(args) -> int:
    catalogue = load_catalogue()
    path = resolve_model(args.model, catalogue)
    entry = catalogue["models"][path]

    if args.json:
        print(json.dumps({path: entry}, indent=2))
        return 0

    print(path)
    print(f"  family   {entry['family']}")
    print(f"  kind     {entry['kind']}  (returns {entry['output']})")
    if entry["requires_media"]:
        print(f"  requires {', '.join(entry['requires_media'])}")
    print("\n  parameters")
    for name, spec in entry["params"].items():
        flags = "required" if spec.get("required") else "optional"
        bits = [spec.get("type", "string")]
        if "enum" in spec:
            bits.append("one of " + "|".join(str(e) for e in spec["enum"]))
        if "default" in spec:
            bits.append(f"default {spec['default']}")
        if "minimum" in spec or "maximum" in spec:
            bits.append(f"range {spec.get('minimum', '-')}..{spec.get('maximum', '-')}")
        print(f"    {name:<24} {flags:<8} {', '.join(str(b) for b in bits)}")
        if spec.get("description"):
            print(f"    {'':<24} {spec['description']}")

    example = f"higgsfield.py run {path.lstrip('/')} --prompt \"...\""
    if entry["requires_media"]:
        example += " --image ./frame.jpg"
    print(f"\n  {example}")
    return 0


def cmd_doctor(args) -> int:
    ok = True
    print("Higgsfield setup check\n")

    try:
        catalogue = load_catalogue()
        print(f"  catalogue     {catalogue['model_count']} models from {catalogue['source']}")
    except HiggsfieldError as exc:
        print(f"  catalogue     FAIL  {exc}")
        return 1

    try:
        key_id, secret, source = load_credentials()
        print(f"  credentials   key id {key_id[:4]}...{key_id[-2:]} (from {source})")
    except HiggsfieldError as exc:
        print(f"  credentials   NOT CONFIGURED\n\n{exc}")
        return 1

    base = catalogue["base_url"]
    try:
        # A known-absent request id proves auth and routing without spending credits.
        api_call("GET", f"{base}/requests/00000000-0000-0000-0000-000000000000/status",
                 key_id, secret, timeout=30)
        print("  connectivity  reachable, credentials accepted")
    except ApiError as exc:
        if exc.status == 404:
            print("  connectivity  reachable, credentials accepted")
        elif exc.status == 401:
            print("  connectivity  FAIL  credentials rejected (401). Check the key and secret.")
            ok = False
        elif exc.status == 403 and "1010" in str(exc.detail):
            print("  connectivity  FAIL  blocked by the CDN -- the User-Agent was stripped.")
            ok = False
        else:
            print(f"  connectivity  FAIL  {exc}")
            ok = False
    except HiggsfieldError as exc:
        print(f"  connectivity  FAIL  {exc}")
        ok = False

    print("\n" + ("Ready. Try: higgsfield.py models --output video" if ok else "Setup incomplete."))
    return 0 if ok else 1


def cmd_estimate(args) -> int:
    catalogue = load_catalogue()
    path = resolve_model(args.model, catalogue)
    entry = catalogue["models"][path]
    creds = Credentials()
    base = catalogue["base_url"]

    params = gather_params(args, entry, creds, base)
    body = validate(path, entry, params)
    result = api_call("POST", f"{base}/estimate{path}", creds.key_id, creds.secret, body, timeout=60)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        credits = result.get("credits", "?")
        usd = result.get("usd")
        print(f"{path}  {credits} credits" + (f"  (~${usd})" if usd else ""))
    return 0


def cmd_submit(args) -> int:
    catalogue = load_catalogue()
    path = resolve_model(args.model, catalogue)
    entry = catalogue["models"][path]
    creds = Credentials()
    base = catalogue["base_url"]

    params = gather_params(args, entry, creds, base)
    body = validate(path, entry, params)

    if args.dry_run:
        print(json.dumps({"url": f"{base}{path}", "body": body}, indent=2))
        return 0

    result = api_call("POST", f"{base}{path}", creds.key_id, creds.secret, body, timeout=120)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(result.get("request_id", ""))
    return 0


def cmd_status(args) -> int:
    catalogue = load_catalogue()
    creds = Credentials()
    url = f"{catalogue['base_url']}/requests/{args.request_id}/status"
    result = api_call("GET", url, creds.key_id, creds.secret, timeout=30)
    if args.json:
        print(json.dumps(result, indent=2))
        return 0
    print(result.get("status", "unknown"))
    for label, media_url in collect_outputs(result):
        print(f"  {label}: {media_url}")
    if result.get("error"):
        print(f"  error: {result['error']}")
    return 0


def _finish(result: dict, args) -> int:
    status = result.get("status")
    if args.json:
        print(json.dumps(result, indent=2))
    if status != SUCCESS:
        reason = result.get("error") or {
            "nsfw": "rejected by content moderation (not charged)",
            "canceled": "canceled before processing",
            "failed": "generation failed (not charged)",
        }.get(status, status)
        print(f"{status}: {reason}", file=sys.stderr)
        return 1

    outputs = collect_outputs(result)
    if args.output_dir:
        save_outputs(result, pathlib.Path(args.output_dir), args.quiet)
    elif not args.json:
        for label, url in outputs:
            print(f"{label}: {url}")
    if not args.json and not args.quiet:
        print("Output URLs expire after about seven days.", file=sys.stderr)
    return 0


def cmd_wait(args) -> int:
    catalogue = load_catalogue()
    creds = Credentials()
    url = f"{catalogue['base_url']}/requests/{args.request_id}/status"
    timeout = args.timeout or DEFAULT_WAIT["video"]
    result = poll(url, creds.key_id, creds.secret, timeout, args.quiet)
    return _finish(result, args)


def cmd_run(args) -> int:
    catalogue = load_catalogue()
    path = resolve_model(args.model, catalogue)
    entry = catalogue["models"][path]
    creds = Credentials()
    base = catalogue["base_url"]

    params = gather_params(args, entry, creds, base)
    body = validate(path, entry, params)

    if args.dry_run:
        print(json.dumps({"url": f"{base}{path}", "body": body}, indent=2))
        return 0

    if not args.quiet:
        print(f"{path}", file=sys.stderr)
    submitted = api_call("POST", f"{base}{path}", creds.key_id, creds.secret, body, timeout=120)
    request_id = submitted.get("request_id")
    status_url = submitted.get("status_url") or f"{base}/requests/{request_id}/status"
    if not args.quiet:
        print(f"  request {request_id}", file=sys.stderr)

    timeout = args.timeout or DEFAULT_WAIT[entry["output"]]
    try:
        result = poll(status_url, creds.key_id, creds.secret, timeout, args.quiet)
    except KeyboardInterrupt:
        print(f"\nStill running. Resume with: higgsfield.py wait {request_id}", file=sys.stderr)
        return 130
    return _finish(result, args)


def cmd_cancel(args) -> int:
    catalogue = load_catalogue()
    creds = Credentials()
    url = f"{catalogue['base_url']}/requests/{args.request_id}/cancel"
    try:
        api_call("POST", url, creds.key_id, creds.secret, timeout=30)
    except ApiError as exc:
        if exc.status == 400:
            print("Cannot cancel: processing has already started.", file=sys.stderr)
            return 1
        raise
    print("canceled")
    return 0


def cmd_upload(args) -> int:
    catalogue = load_catalogue()
    creds = Credentials()
    for item in args.files:
        print(upload_file(pathlib.Path(item).expanduser(), creds, catalogue["base_url"]))
    return 0


# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="higgsfield.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="command", required=True)

    def generation_args(p, with_media=True):
        p.add_argument("model", help="model path or a unique fragment of one")
        p.add_argument("--prompt", help="the generation prompt")
        p.add_argument("-p", "--param", action="append", metavar="KEY=VALUE",
                       help="any other model parameter; repeatable")
        if with_media:
            p.add_argument("--image", action="append", metavar="URL_OR_FILE",
                           help="input image; local files are uploaded first. Repeatable")
        p.add_argument("--json", action="store_true", help="emit raw JSON")
        p.add_argument("-q", "--quiet", action="store_true", help="suppress progress output")

    p = sub.add_parser("models", help="list available models")
    p.add_argument("--output", choices=["image", "video"])
    p.add_argument("--kind", help="e.g. text-to-video, image-to-video")
    p.add_argument("--family", help="e.g. veo3.1, sora-2, kling-video")
    p.add_argument("--search", help="substring of the model path")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_models)

    p = sub.add_parser("show", help="parameters for one model")
    p.add_argument("model")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("doctor", help="check credentials and connectivity")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("estimate", help="cost of a request before submitting it")
    generation_args(p)
    p.set_defaults(func=cmd_estimate)

    p = sub.add_parser("submit", help="submit and return immediately")
    generation_args(p)
    p.add_argument("--dry-run", action="store_true", help="print the request without sending it")
    p.set_defaults(func=cmd_submit)

    p = sub.add_parser("run", help="submit, wait, and collect the result")
    generation_args(p)
    p.add_argument("-o", "--output-dir", help="download the media into this directory")
    p.add_argument("--timeout", type=int, help="seconds to wait before giving up")
    p.add_argument("--dry-run", action="store_true", help="print the request without sending it")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("status", help="current state of a request")
    p.add_argument("request_id")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("wait", help="poll an existing request until it finishes")
    p.add_argument("request_id")
    p.add_argument("-o", "--output-dir")
    p.add_argument("--timeout", type=int)
    p.add_argument("--json", action="store_true")
    p.add_argument("-q", "--quiet", action="store_true")
    p.set_defaults(func=cmd_wait)

    p = sub.add_parser("cancel", help="cancel a request that has not started")
    p.add_argument("request_id")
    p.set_defaults(func=cmd_cancel)

    p = sub.add_parser("upload", help="upload local media and print its public URL")
    p.add_argument("files", nargs="+")
    p.set_defaults(func=cmd_upload)

    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except HiggsfieldError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
