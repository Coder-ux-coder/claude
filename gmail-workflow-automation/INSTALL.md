# Installation

Fifteen minutes. No developer required, no software installed on any device.
Do this once, on a laptop, signed in to the mailbox you want automated.

---

## Before you start

You need two things:

1. **The Google account whose mailbox this is.** Sign in to it in the browser you
   are about to use. Everything the script does, it does as that account.
2. **An Anthropic API key.** Create one at <https://console.anthropic.com> →
   *API keys*. It begins `sk-ant-`. Treat it like a company bank card: it spends
   real money, and anyone holding it can spend yours.

---

## Step 1 — Create the script project

1. Go to <https://script.google.com> and click **New project**.
2. Click the project name (top left, "Untitled project") and rename it
   **Gmail Workflow Automation**.

## Step 2 — Add the code

For each file in the `src/` folder of this repository:

1. In the left sidebar, next to **Files**, click **+** → **Script**.
2. Name it exactly as the file is named, **without the `.gs`** — Apps Script adds
   that itself. So `Config.gs` is entered as `Config`.
3. Delete whatever is in the editor and paste the file's contents.
4. Repeat for: `Config`, `Store`, `Workflow`, `Transcript`, `Prompt`,
   `Classifier`, `Labels`, `Scanner`, `Digest`, `Main`, `Tests`.

Then delete the empty `Code.gs` the project was created with.

The order does not matter — Apps Script loads every file into one shared scope.

## Step 3 — Add the manifest

1. Click the gear icon (**Project Settings**) in the left sidebar.
2. Tick **Show "appsscript.json" manifest file in editor**.
3. Return to the editor, open `appsscript.json`, and replace its contents with
   `src/appsscript.json` from this repository.
4. **Change `timeZone`** to your own if it is not `Asia/Karachi`. Use an IANA
   name: `Europe/London`, `America/New_York`, `Asia/Dubai`.

This file declares which permissions the script will ask for. It requests the
minimum the specification needs and nothing else — no ability to delete mail, no
access to Drive beyond the one spreadsheet it creates.

## Step 4 — Store the API key

1. **Project Settings** → scroll to **Script Properties** → **Add script
   property**.
2. Property: `ANTHROPIC_API_KEY`
3. Value: your `sk-ant-...` key.
4. **Save script properties**.

The key lives here and nowhere else. It is never written into the code, never
written into the spreadsheet, and never leaves Google's servers except in the
`x-api-key` header of the call to Anthropic.

## Step 5 — Run setup

1. Back in the editor, choose **`setup`** from the function dropdown at the top.
2. Click **Run**.
3. Google will ask for authorisation. Choose the account, then **Advanced** →
   **Go to Gmail Workflow Automation (unsafe)** → **Allow**.

   That warning appears for every private script that has not been through
   Google's public-app review. It is your own code running in your own account;
   the permissions it is actually asking for are the ones listed in
   `appsscript.json`, and you can read them on the consent screen.

4. The execution log prints a summary and a link to the state spreadsheet.
   **Open that link and bookmark it** — it is the system's control panel.

`setup` creates the labels, creates the spreadsheet, and installs the two timers.
It is safe to run again; it repairs rather than duplicates.

## Step 6 — Prove it works

Run these two functions from the dropdown, in order:

- **`testApiConnection`** — sends one real request (a fraction of a cent) and
  prints what came back. It classifies the specification's own quotation example
  and tells you whether the model got it right.
- **`selfTest`** — checks the clock, the state machine, the labels and the
  installation without spending anything.

Both print to the execution log at the bottom of the editor.

## Step 7 — Watch before you trust

Run **`previewScan`**. It decides everything and changes nothing, writing what it
*would* have done to the `log` tab of the spreadsheet.

Read that log. If the classifications look right, you are finished — the timers
are already installed and the first real scan will run within fifteen minutes.

If they look wrong, tune the settings in Step 8 and preview again.

---

## Step 8 — Tune it, from the spreadsheet

Open the state spreadsheet and go to the **`config`** tab. Change a value, and
the next run uses it. No code, no redeployment.

| Setting | What it does |
|---|---|
| `slaWorkingHours` | Working hours before *our* action is overdue. Default 16 — two office days. |
| `slaWorkingHoursOfficial` | The tighter clock for government, tax, bank and insurance mail. Default 8. |
| `workingDays` | `1,2,3,4,5` is Monday–Friday. `0` is Sunday, `6` is Saturday. For a six-day office, use `1,2,3,4,5,6`. |
| `workingStartHour` / `workingEndHour` | Office hours, 24-hour clock. |
| `timezone` | IANA name. Must match the office, not the server. |
| `digestHour` | Local hour the morning summary is sent. |
| `digestRecipients` | Comma-separated. Blank sends to the mailbox owner. |
| `searchQuery` | Which mail is looked at. Default is everything from the last 21 days excluding chats, spam and bin. |
| `minConfidence` | Below this the thread is labelled *Needs Review*. Raise it for more human oversight. |
| `minConfidenceToComplete` | How certain the model must be before it may close a matter. Keep this high. |
| `maxClassificationsPerScan` | A spending fuse: the most AI calls one run may make. |
| `model` | The Anthropic model id. |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`. Higher means more careful and more expensive. |
| `dryRun` | `TRUE` makes the system decide and log but change no labels. |

### Narrowing what it looks at

`searchQuery` takes ordinary Gmail search syntax, so the scope can be as tight as
you like:

```
newer_than:21d -in:chats -in:spam -in:trash          # everything (default)
newer_than:30d label:Customers                        # only a label you maintain
newer_than:21d -from:me -list:*                       # skip newsletters
newer_than:21d to:sales@yourcompany.com               # one shared address
```

---

## Step 9 — Make it visible on the phones (optional)

Labels appear on every device automatically. To be *pushed* when something goes
overdue, on each phone that should buzz:

**Gmail app → Settings → (the account) → Manage labels → `Workflow/! Overdue` →
Label notifications → on.**

This is the only setting that is per-device, because notification preferences
belong to a device rather than to an account. Consider doing the same for
`Workflow/2 We Must Act`.

---

## Running costs

Two bills, and one of them is zero.

**Google:** nothing. Apps Script is included with both free Gmail and Google
Workspace. The script stays well inside the free quotas — the scan is capped so
that it cannot run away.

**Anthropic:** you pay per thread *classified*, and unchanged threads are never
re-classified. A mailbox seeing 40–60 new or updated conversations on a working
day typically costs **$20–40 a month** at the default settings. The `log` tab
records the token usage of every call, so the figure is auditable from day one
rather than estimated.

To spend less: lower `effort` to `low`, or narrow `searchQuery` to the labels
that matter commercially. To spend more and get more care on hard threads, raise
`effort`.

---

## If something goes wrong

Run **`status()`**. It prints the number of tracked threads, the breakdown by
state, how many are overdue, whether the triggers are installed, whether the API
key is present, and the local time the system believes it is.

| Symptom | Cause | Fix |
|---|---|---|
| "No API key" | Step 4 skipped or mistyped | Check the property name is exactly `ANTHROPIC_API_KEY` |
| No labels appear | Triggers not installed | Run `installTriggers()`, then `status()` |
| "State spreadsheet not created yet" | `setup` never completed | Run `setup()` again |
| Deadlines land at the wrong hour | Timezone mismatch | Set `timezone` in the `config` tab *and* `timeZone` in `appsscript.json` |
| Everything is *Needs Review* | `minConfidence` too high, or the API is failing | Check the `log` tab for the actual error |
| `HTTP 401` in the log | Bad or revoked API key | Issue a new key in the Anthropic console |
| `HTTP 429` in the log | Rate limited | Harmless — it retries. Lower `maxClassificationsPerScan` if persistent. |
| Nothing runs at all | Authorisation lapsed | Run any function manually and re-authorise |

Every error is written to the `log` tab with the thread it happened on. A thread
that fails to classify is labelled *Needs Review* and retried on the next run —
it is never silently dropped.

---

## Removing it

1. Run `removeAllTriggers()` — the system stops immediately.
2. Run `uninstallLabels()` — removes the workflow labels from every conversation.
3. Delete the Apps Script project, and the state spreadsheet if you want the
   record gone.

No mail is ever deleted, moved out of the mailbox, or altered in content. The
system only ever adds and removes its own labels, and moves overdue threads back
to the inbox.
