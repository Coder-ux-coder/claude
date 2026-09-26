# Crew — your AI team, on your own computer

Crew turns your subscriptions (several Claude accounts and a ChatGPT account)
into one team. You type — or say — what you want. For a question, the
Assistant answers. For something to build, a team plans the work, splits it,
builds the parts at the same time, checks every piece with fresh eyes, and
hands you the finished result. You never see code or technical screens unless
you ask.

- **Top-model quality:** every piece of work is done by Claude Opus 5.5,
  checked by an agent that did not write it, and approved at the end by the
  most capable model (Claude Fable 5.1). Haiku and Sonnet are never used.
- **Faster:** independent parts are built in parallel.
- **Usage spread out:** work goes to whichever subscription has the most room;
  if one runs out, another carries on.
- **Learns:** every project leaves lessons that the next team reads.

## Install on Windows (once, about 10 minutes)

1. **Download** this project from GitHub (green **Code** button →
   **Download ZIP**), then right-click the ZIP → **Extract All**.
2. In the extracted folder open **crew → install** and double-click
   **Install Crew.cmd**. If Windows warns that the publisher is unknown, choose
   **Run** (or **More info → Run anyway**).
3. Answer two questions (whether you use ChatGPT too, and whether Crew should
   start with Windows). If Windows asks for permission to install Python or
   Git, choose **Yes**.
4. Crew opens by itself and puts a **Crew** icon on your desktop. On its Home
   page press **Sign in** and sign in to your Claude account in the browser.
   Add your other subscriptions in **Settings → Subscriptions** — each one signs
   in once.

To update, download the newer ZIP and run **Install Crew.cmd** again (your
projects and settings are kept). To remove Crew, run **Uninstall Crew.cmd**.

## What you can do

| Screen | What it does |
|---|---|
| **Home** | One box for everything: **Ask the assistant**, or **Build with the team**. The microphone types for you; the sound-wave button starts a spoken conversation. |
| **Assistant** | Answers appear word by word. Attach files or pictures (paperclip, drag and drop, or paste). Pages and documents it makes open in the side panel. The speaker button reads an answer aloud. **Build this with the team** turns the conversation into a project. |
| **Projects** | Follow a team at work: who is doing what, the plan, their group chat (you can write to them), how much of each subscription is used, and the final result with a **Preview** button. Stop and continue any time. |
| **Browser** | A real browser that you and the assistant share, also in a side panel next to a conversation. Click and type on it, switch to phone size, take screenshots (visible part or whole page) and record it. Sign in to websites here once and the assistant can use them for you. |
| **Phone** | See and control your Samsung from the computer — tap, swipe, type, open apps, screenshots and recordings. The assistant can use it too when you ask. The app walks you through connecting (Wireless debugging). |
| **Captures** | Screenshots and recordings of your screen, the browser or your phone. Draw on them (pen, highlighter, box, arrow, label), copy, download, or ask the assistant about one. |
| **Skills** | The ways of working the team follows automatically. Switch any off, write your own, or ask the assistant to help you write one. |
| **Settings** | Drop-downs and switches for everything: models and effort (for the Assistant and for the team), how the team works, subscriptions, team rules and assistant instructions, API keys, voice (including Urdu), look and colour, phone pairing, lessons learned, and a check-up of what is installed. |

## Use it on your Samsung

1. On the computer: **Settings → Use on your phone** → switch it on.
2. With the phone on the same Wi-Fi, point its camera at the code and tap the link.
3. In Chrome tap **⋮ → Add to Home screen** for a Crew icon.

Crew keeps running on the computer; the phone is a remote screen for it. The
phone's browser only allows the microphone on secure connections: at your desk,
connect the phone on the **Phone** page and Crew also opens on the phone at a
local, secure address; away from home, install the free **Tailscale** app on
both devices.

## Honest limits

- The Windows installer and the Windows-only parts (desktop icon, windowless
  start, sign-in windows) were written carefully but could not be run on a real
  Windows PC in the build environment, which is Linux. Everything else was
  tested there end to end with a real browser, simulated agents and a
  simulated phone. If a step fails, the installer says which one and how to
  fix it.
- ChatGPT through Codex has not been tried with a real ChatGPT sign-in yet.
- Google may refuse sign-in inside automated browsers ("this browser may not be
  secure"). Sign in to Google in your normal browser instead, or use sites
  that do not need it.
- Typing on the phone through the connector supports English letters only; use
  the phone's own keyboard for Urdu. iPhones cannot be controlled this way
  (Apple does not allow it); Android phones such as Samsung can.
- Anthropic's Pro and Max plans assume ordinary, individual use. Use only your
  own subscriptions and never share sign-ins.

## For the technically curious: the command line

Everything the app does is also available as commands (`./crew` on macOS/Linux,
`crew` on Windows):

| You want to… | Type |
|---|---|
| open the app | `crew app` (`--phone` also allows paired phones) |
| start something new | `crew start "a website for my bakery with a menu and an order form"` |
| work on an existing folder | `crew start --repo path/to/folder "what to change"` |
| tell the team something | `crew say "use green as the main colour"` |
| see progress | `crew status` or `crew chat -f` |
| pause, then continue later | `crew stop` … `crew resume` |
| read the final report | `crew report` |
| see what past teams learned | `crew lessons` |
| check the installation | `crew doctor` |

Settings live in `~/.crew/crew.toml` (the app edits this file for you), team
rules in `~/.crew/team_rules.md`, assistant instructions in
`~/.crew/assistant.md`, API keys in `~/.crew/secrets.env` (blanked out of every
chat, log and report).

### How the team avoids the usual multi-agent problems

- **No freezing:** a watchdog restarts silent agents from where they were; a
  progress ledger forces a re-plan when nothing moves; nobody waits on anybody.
- **No slop:** each piece has written acceptance criteria, must be submitted
  with evidence, passes the tests, and is reviewed by a fresh agent before it is
  merged. Merges that break the tests are undone automatically.
- **No endless arguing:** chat is budgeted, the lead makes binding decisions,
  and disagreements are settled by a test or one ruling from the CEO model.
- **No corruption:** each agent works in its own copy; only the orchestrator
  combines work; everything is saved so a stopped project resumes exactly.
- **Solo or team is chosen for you.** Small jobs, or jobs that do not split
  well, are built by one agent and checked by the others — the fastest way to
  reviewed, high-quality work. Jobs with several independent parts get the full
  team. (On a small test job, one agent took 9 minutes and the full team 34.)

The design and the research behind it are in `ARCHITECTURE.md`.

### Tests

`python3 -m unittest discover -s tests` runs the unit tests, full simulated team
runs (with injected freezes, crashes, limit hits, rejected reviews, merge
conflicts, and stop/resume) and the app's own tests.
