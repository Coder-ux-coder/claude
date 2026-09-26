# Crew — your team of AI engineers

Tell Crew what you want in plain words. It turns your subscriptions (several
Claude accounts and a ChatGPT/Codex account) into one team that plans the
work, splits it, builds it in parallel, checks every piece with fresh eyes, and
hands you the finished result — while you watch their group chat if you like.

- **Same top-model quality** as one agent working alone: every piece of work is
  built by Claude Opus 5.5, reviewed by an agent that did not write it, tested,
  and signed off by the most capable model (Claude Fable 5.1) at the end.
- **Faster:** independent parts are built at the same time by different agents.
- **Usage spread out:** work goes to whichever subscription has the most room,
  and if one runs out mid-task the agent moves to another one and carries on
  with its conversation intact.
- **Learns:** every run leaves lessons that the next team reads.

## One-time setup

1. Install **Python 3.11 or newer** (python.org), **git**, and **Claude Code**
   (`curl -fsSL https://claude.ai/install.sh | bash`, or see claude.com/claude-code).
   For your ChatGPT subscription also install **Codex**: `npm install -g @openai/codex`.
2. Get this folder onto your computer.
3. Run `./crew setup` (Windows: `crew setup`). It creates your settings in
   `~/.crew/` and opens a browser sign-in for each subscription you list in
   `~/.crew/crew.toml`.
4. Optional: put API keys your projects need into `~/.crew/secrets.env`.
5. Check everything with `./crew doctor`.

## Using it

```
./crew start "a website for my bakery with a menu page and an order form"
```

A live page opens (http://127.0.0.1:8765) showing the team chat, who is doing
what, how much of each subscription is used, and finally the result. You can
type into the chat at any time; the team treats your messages as top priority.

| You want to… | Type |
|---|---|
| start something new | `./crew start "what you want"` |
| work on an existing project folder | `./crew start --repo path/to/folder "what to change"` |
| tell the team something | `./crew say "use green as the main colour"` |
| see progress | `./crew status` or `./crew chat -f` |
| pause, then continue later | `./crew stop` … `./crew resume` |
| read the final report | `./crew report` |
| see what past teams learned | `./crew lessons` |

## Your controls (all in `~/.crew/crew.toml`)

- **Models:** `work` (default Claude Opus 5.5) does the work; `ceo` (default
  Claude Fable 5.1) reviews the plan and the final result. Haiku and Sonnet are
  banned by default; only models on the `allowed` list can ever run.
- **Effort:** `effort_work`, `effort_light`, `effort_ceo` — low to max.
- **Subscriptions:** one `[[account]]` block per subscription.
- **Team behaviour:** time limit, how long before a silent agent is nudged,
  review style, whether the result is merged into your folder or pushed.
- **Team rules:** `~/.crew/team_rules.md` — the instructions every agent
  follows. Edit freely.
- **Skills:** built-in skills (screenshots and visual checks, verification,
  handover notes, thrifty usage, creating new skills) plus any the teams create
  in `~/.crew/skills/`.
- **Permissions:** agents act without asking by default
  (`permission_mode = "bypassPermissions"`). Use `"auto"` for a safer mode.

## How it avoids the usual multi-agent problems

- **No freezing:** a watchdog restarts silent agents from where they were; a
  progress ledger forces a re-plan when nothing moves; nobody waits on anybody.
- **No slop:** each piece has written acceptance criteria, must be submitted
  with evidence, passes the tests, and is reviewed by a fresh agent before it is
  merged. Merges that break the tests are undone automatically.
- **No endless arguing:** chat is budgeted, the lead makes binding decisions,
  and disagreements are settled by a test or one ruling from the CEO model.
- **No corruption:** each agent works in its own copy; only the orchestrator
  combines work; everything is saved so a stopped run resumes exactly.

The design and the research behind it are in `ARCHITECTURE.md`.

## Good to know

- **Solo or team is chosen for you.** Small jobs, or jobs that do not split
  well, are built by one agent and checked by the others. That is the fastest
  way to get reviewed, high-quality work. Jobs with several independent parts
  get the full team, because only then does working in parallel beat the
  extra coordination. (On a small test job, one agent took 9 minutes and the
  full team 34.) Force either with `mode = "solo"` or `mode = "team"`.
- Anthropic states that Pro/Max plan limits assume ordinary, individual use.
  Spreading one project across several of your own subscriptions is your call;
  never share logins with other people.
- The team runs on your machine with your permissions. Keep secrets in
  `~/.crew/secrets.env` (they are blanked out of every chat and log).
- Tests: `python3 -m unittest tests.test_units tests.test_e2e` (unit tests plus
  full simulated runs with injected freezes, crashes, limit hits, rejected
  reviews, merge conflicts, and stop/resume).

## Next: the app

The engine above is complete. The next phase is a desktop and phone app on top
of it: prompt box and live result; side-panel browser with a toolbar to click,
record and film websites; screenshot tools; voice dictation, two-way voice
conversation and read-aloud; computer and phone control; model/effort pickers
and all settings as simple menus; skill library; and a mobile companion — with
no code or git on screen.
