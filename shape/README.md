# Shape

Say what you want. Claude builds it in Blender and shows you.

![Shape](docs/screen.png)

## Get it

Download the file for your computer from
[Releases](../../releases), then open it. Shape opens in your browser.

| Your computer | File |
| --- | --- |
| Mac | `shape-macos-arm64` |
| Windows | `shape-windows-x64.exe` |
| Linux | `shape-linux-x64` |

Nothing to install, no Python, no terminal.

> On a Mac the first open may need **right-click → Open**, because the app is
> not signed yet. On Windows, SmartScreen may ask the same way.

## Two things on the first run

Shape asks for both and remembers them.

**Blender.** Free, from [blender.org/download](https://www.blender.org/download/).
Shape looks in the usual places; if you put it somewhere unusual, type where.

**Your Claude account.** A key from
[console.anthropic.com](https://console.anthropic.com/settings/keys). You pay
Claude directly for what you make, at their published rates — Shape takes
nothing and adds nothing.

Most objects cost a few cents. Shape shows what each one cost and what you have
spent so far, because it is your money.

## Using it

Type what you want. Press **Make**. About fifteen seconds later you get a
picture, the real size in centimetres, and a model you can download and open in
anything.

**Change it** keeps what you have and adjusts it — "make the handle bigger",
"taller", "in brass" — so the object keeps its identity instead of being
rebuilt from nothing.

Everything you make stays in a strip at the bottom. Click one to bring it back.

## Where your things live

| | |
| --- | --- |
| Mac | `~/Library/Application Support/Shape` |
| Windows | `%APPDATA%\Shape` |
| Linux | `~/.config/shape` and `~/.local/share/shape` |

Your key is a file only your account can read. Your objects are folders with a
picture, a model, and the Blender file. Copy them, back them up, or delete
them — they are ordinary files.

## Is it working?

```sh
shape --check
```

Builds one test sphere and tells you whether Blender and Shape agree. Costs
nothing and needs no internet.

## For the curious

Six files, about a thousand lines, no framework.

| File | What it does |
| --- | --- |
| `app.py` | Starts it and opens your browser |
| `server.py` | The web server |
| `maker.py` | Asks Claude for the script; one repair round if the guard refuses |
| `guard.py` | What a generated script may do |
| `build.py` | Runs inside Blender: build, light, frame, render, export |
| `settings.py` | Your key, your Blender, your history |

Build it yourself:

```sh
python3 -m venv .venv && .venv/bin/pip install anthropic pyinstaller
.venv/bin/pyinstaller shape.spec        # -> dist/shape
```

## Safety, said plainly

Claude writes code and Shape runs it in Blender. Before a script runs it is
checked: six imports allowed (`bpy`, `bmesh`, `math`, `mathutils`, `random`,
`colorsys`), and no file access, network, shell, dunder attributes, or the
Blender operators that reach outside the job folder. A refused script goes back
to Claude once for a rewrite, and is then reported rather than run.

**That is a guard, not a sandbox.** It raises the cost of a bad script; it does
not make one harmless. It is an acceptable trade on your own machine, with your
own key, building your own things — which is exactly what Shape is.

It would not be acceptable as a website where strangers submit prompts to a
server you own. If you ever run it that way, Blender needs to be in a container
with no network and nothing writable outside the job folder. Shape binds to
`127.0.0.1` so that stays a deliberate decision rather than an accident.

## What Shape is not

- Not a modeller. You describe; you do not push vertices.
- Not a viewer. You get a render and a model file, not something to spin.
- Not a service. No accounts, no queue, no servers — it runs on your computer.
