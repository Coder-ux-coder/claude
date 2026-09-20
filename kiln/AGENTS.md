# Setting Kiln up for someone

You are reading this because a person asked you to install Kiln for them. This
file is the whole job. It should take you about three minutes and one question.

**Kiln** is a small desktop app. The person types what they want, Claude writes
a Blender script, Blender builds and renders it, and they get a picture and a
3D model. It runs entirely on their machine.

---

## The one rule

**Never ask for, read, store, or type their Claude API key.**

Kiln asks for the key itself, in its own browser window, and writes it to a
file only their account can read. You do not need it and should not see it. If
the person offers it to you, tell them to paste it into Kiln's setup screen
instead.

Everything else below is yours to do.

---

## Do this

### 1. Get the code

```sh
git clone https://github.com/Coder-ux-coder/kiln.git
cd kiln
```

If `git` is missing, download and unzip
`https://github.com/Coder-ux-coder/kiln/archive/refs/heads/main.zip` instead.

### 2. Run setup

| Their machine | Command |
| --- | --- |
| macOS, Linux | `bash setup.sh` |
| Windows | `powershell -ExecutionPolicy Bypass -File setup.ps1` |

Safe to run twice. It installs a private Python environment, the one
dependency, then builds a test object to prove the whole chain works.

**Read the last line of its output.** `Everything Kiln needs is working.`
means you are done with this step. Anything else is in the table below.

### 3. Start it

```sh
./.venv/bin/python app.py           # macOS, Linux
.\.venv\Scripts\python.exe app.py   # Windows
```

It prints an address and opens the browser. Leave it running.

### 4. Hand over

Tell them, in your own words:

> Kiln is open in your browser. It needs one thing from you: a Claude key.
> Get one at https://console.anthropic.com/settings/keys, paste it into the
> box, and press Save. You pay Claude directly for what you make — usually a
> few cents an object, and Kiln shows you the cost each time.

Then stop. Do not press Make for them; the first object should be theirs.

---

## When something is wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| `Python 3.10 or newer is needed` | No suitable Python | macOS: `brew install python@3.12`. Ubuntu: `sudo apt install python3 python3-venv`. Windows: python.org, tick *Add to PATH*. |
| `Blender is not installed yet` | Everything else is set up | macOS: `brew install --cask blender`. Ubuntu: `sudo snap install blender --classic`. Windows: `winget install BlenderFoundation.Blender`. Then run setup again. |
| Setup finishes but `--check` fails | Blender is there but will not run | Run `blender --version` yourself. On a headless Linux box install `libx11-6 libxi6 libxrender1 libxxf86vm1`. |
| `That Claude key was not accepted` | Their key is wrong or has no credit | They fix it in Kiln's Settings. Not your problem to solve, and do not ask to see the key. |
| Port already in use | Another copy is running | It picks a free port by itself. If you need a specific one: `app.py --port 7005`. |
| `externally-managed-environment` from pip | Debian or Ubuntu system Python | The setup script already uses a virtual environment; if you see this you ran pip by hand. Use `./.venv/bin/python -m pip` instead. |

---

## Checking your work

```sh
./.venv/bin/python app.py --check
```

Builds one test sphere and prints its size. Costs nothing, needs no internet,
and touches no key. If it prints `Everything Kiln needs is working.` the
install is good even before they connect an account.

---

## Do not

- Do not install anything system-wide. Everything lives in `.venv` beside the code.
- Do not put a key in `settings.json`, in a shell profile, or in any file you write.
- Do not set `HOST` to anything but `127.0.0.1`. Kiln runs Claude-written code
  in Blender; a guard checks each script, but that guard is not a sandbox, and
  the app is only safe as a local tool. Read `README.md` § Safety before
  changing this, and tell the person what they would be accepting.
- Do not make the first object for them.

---

## If you are editing the code, not installing it

See `CLAUDE.md`.
