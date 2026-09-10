# Opening a terminal, and starting the app

You do not need to understand the terminal. You need to open one window, paste
four lines, and press Enter after each.

---

## Windows

### 1 · Check you have Python and Git

Both are free and take two minutes.

* **Python** — <https://www.python.org/downloads/> → *Download Python*.
  **On the first installer screen, tick "Add python.exe to PATH"** before
  clicking Install. Miss that box and nothing below works.
* **Git** — <https://git-scm.com/download/win> → run the installer, click Next
  through every screen.

Restart the computer after installing, so Windows notices them.

### 2 · Open the terminal

Press the **Windows key**, type `powershell`, press **Enter**.

A blue or black window opens with a blinking cursor. That is the terminal.

### 3 · Paste these, one line at a time

Right-click pastes in PowerShell (Ctrl+V also works). Press **Enter** after
each line and wait for it to finish before the next.

```
cd $HOME\Documents
git clone https://github.com/Coder-ux-coder/claude.git
cd claude\lead-enrichment
git checkout claude/intelligent-newton-tx4mru
```

### 4 · Start it

```
.\run.bat
```

Your browser opens at `http://127.0.0.1:8000`. **Leave the black window open**
while you use the app — closing it stops the app. Press **Ctrl+C** in that
window when you want to stop.

---

## Mac

### 1 · Open the terminal

Press **Cmd + Space**, type `terminal`, press **Enter**.

Git and Python are already installed. macOS may ask to install developer tools
the first time you run `git` — say yes and wait.

### 2 · Paste these, one line at a time

```
cd ~/Documents
git clone https://github.com/Coder-ux-coder/claude.git
cd claude/lead-enrichment
git checkout claude/intelligent-newton-tx4mru
```

### 3 · Start it

```
./run.sh
```

Your browser opens at `http://127.0.0.1:8000`. Leave the Terminal window open;
Ctrl+C stops the app.

---

## Once it is running

1. The app opens on the **Run** page. Click **Run the demo** — it works with no
   API keys at all, and shows you exactly what the system produces.
2. Click **Setup** in the top bar. Paste your API keys into the boxes and click
   **Save keys**. They are written to a file on your computer and go nowhere
   else.
3. Back on **Run**, drop in your CSV and press **Run enrichment**.

## Coming back tomorrow

You only clone once. After that:

```
cd $HOME\Documents\claude\lead-enrichment     (Windows)
cd ~/Documents/claude/lead-enrichment          (Mac)
git pull
```

then `.\run.bat` or `./run.sh`.

---

## If something goes wrong

| It says | Do this |
|---|---|
| `python is not recognized` / `command not found: python` | Python is not on PATH. Re-run the installer, choose **Modify**, and tick *Add python.exe to PATH*. Restart. |
| `git is not recognized` | Git is not installed, or the machine has not been restarted since installing it. |
| `.\run.bat : File cannot be loaded ... execution policies` | You are in the wrong file — that error is about `.ps1` scripts. Check you typed `.\run.bat`, with the dot and backslash. |
| The browser shows "can't reach this page" | The app is not running. Check the terminal window is still open and has not printed an error. |
| `Permission denied: ./run.sh` (Mac) | Run `chmod +x run.sh` once, then try again. |
| It ran, but every provider says "no credentials" | Expected until you add keys. The demo still works. Go to **Setup** and paste them in. |
