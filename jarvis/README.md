# JARVIS — implementation

The design is in [`../docs/jarvis`](../docs/jarvis/00-index.md). This directory is the code.

## Layout

| Path | What it is |
|---|---|
| `packages/shared` | Contracts: zod schemas (canonical), IDs, errors, hashing, clock. JSON Schema 2020-12 is exported to `schemas/`. |
| `packages/core` | The Coordinator: database and event store, task engine, memory, policy, vault, broker and executors, model gateway, boss runtime, scheduler, notifications, IPC server. Entry point: `dist/main.js`. |
| `packages/console` | The Console: Electron main + preload, React renderer, local speech-to-text (whisper.cpp), and a dev web bridge for running the renderer in a browser. |
| `native/` | .NET 8 helpers for Windows: Launcher, Exec Host (Job Objects, Recycle Bin, DPAPI), Session Agent (hotkeys, lock/power events, tray, capture). |
| `phase0/` | The Windows verification kit (run once on the target PC). |
| `tools/`, `scripts/` | Spec-conformance checker; `scripts/check.sh`, the verification gate. |

## Build and verify

```sh
npm install                      # Node 22+; ELECTRON_SKIP_BINARY_DOWNLOAD=1 is fine for building and testing
npm run build                    # shared + core (tsc), then the console bundles (esbuild)
bash scripts/check.sh            # everything below; must pass before every commit
```

`check.sh` runs the TypeScript build, the Console typecheck and bundle, the JSON Schema check, spec conformance (every `interface` in the docs vs. its zod schema), the .NET build and tests, and all TypeScript tests, including a real Chromium run of the Console (`/opt/pw-browsers/chromium`, or set `JARVIS_CHROMIUM`).

## Run it (development, any OS)

```sh
export JARVIS_DEV_SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
node packages/core/dist/main.js --data-dir ./.jarvis-dev       # the Coordinator
node packages/console/dist/bridge/dev-main.js                   # prints a http://127.0.0.1:…/#token=… URL
```

Open the printed URL. Add your Anthropic API key in **Settings**; it is stored only in the local encrypted vault. Without a key the Console works, and JARVIS replies that it can't reason yet.

Optional local speech-to-text: set `JARVIS_WHISPER_BIN` (whisper.cpp's `whisper-cli`) and `JARVIS_WHISPER_MODEL` (a ggml model file) before starting the bridge.

## Run it (Windows, as installed)

The Launcher (`native/Jarvis.Launcher`, configured by `launcher.example.json`) starts the Exec Host, the Coordinator, the Session Agent and the Console in order. It passes a per-boot session secret to each over stdin, restarts them with backoff, and switches to safe mode after repeated crashes. On Windows the master key is wrapped with DPAPI through the Exec Host.

## Security notes

- The per-user pipes need the session secret. The Console proves knowledge of it with a mutual HMAC handshake and never sends it (protocol 1.1). The C# clients use `PipeOptions.CurrentUserOnly`.
- API keys and passwords live only in the vault. They are refused in settings, redacted from chat, logs and events, and never sent to a model.
- The Electron renderer is sandboxed, with context isolation, no Node, a strict CSP, no navigation, and only the microphone permission.
