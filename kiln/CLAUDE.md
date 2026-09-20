# Kiln — notes for working on the code

Installing it for someone? Read `AGENTS.md` instead. This file is for changing it.

## What it is

Six files, about a thousand lines, no framework.

| File | Holds |
| --- | --- |
| `app.py` | Start-up, port choice, browser, `--check` |
| `server.py` | Four routes on `http.server`. No framework, deliberately |
| `maker.py` | The Claude call, and one repair round when the guard refuses |
| `guard.py` | What a generated script may do |
| `build.py` | Runs **inside Blender**: build, light, frame, render, export |
| `settings.py` | Key, Blender path, model, history |

`build.py` is never imported by the app — Blender runs it as a subprocess. It
ships as data in `kiln.spec`, not as code.

## Rules that are not negotiable

1. **The guard only ever gets stricter.** Adding an allowed import means
   arguing why in the commit message. `guard.check()` returning `[]` is the
   only thing standing between a generated script and the user's filesystem.
2. **The key never leaves `settings.py`.** Not into a log line, not into a
   response body, not into a job record. `key_hint()` returns four characters
   for the interface; that is the whole public surface.
3. **`127.0.0.1` stays the default.** See `README.md` § Safety.
4. **Errors are sentences a person can act on.** `friendly()` in `server.py`
   turns SDK exceptions into them. New failure modes get new sentences.
5. **No jargon in the interface.** The words are Make, Change it, Download,
   Start again, Settings. Not mesh, modifier, tessellation, viewport.

## Checks before a commit

```sh
./.venv/bin/python -c "import guard; assert guard.check('import os'); assert not guard.check('import bpy'); print('guard ok')"
./.venv/bin/python app.py --check
```

The first proves the guard still refuses what it must. The second proves the
whole Blender chain works. Neither needs a key or the network.

## The model

`claude-opus-5` by default, adaptive thinking, streamed. Prices live in
`settings.MODELS` and must match Anthropic's published rates — the app shows
people what they spent, so a stale number there is a lie, not a rounding error.
