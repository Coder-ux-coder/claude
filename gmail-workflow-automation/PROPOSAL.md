# Technical &amp; Commercial Proposal

Answering, point by point, the nine items requested under *"What to include in
your proposal"*. The system described here is **built and tested**, not
hypothetical — the code is in `src/`, the test suite in `test/`.

---

## 1. Recommended technical solution

A **Google Apps Script bound to the mailbox**, running on a fifteen-minute
timer, calling the **Anthropic Messages API** for judgement and writing its
conclusions back as **Gmail labels**.

| Layer | Choice | Why this and not the alternative |
|---|---|---|
| Runtime | Google Apps Script | Runs inside the Google account. No server to rent, patch, monitor or secure; no OAuth refresh-token infrastructure; no per-device install. The alternative — a Node service on a VPS with the Gmail API — adds hosting cost, a credential store, an uptime obligation and a second thing that can break, and buys nothing this specification asks for. |
| Mail access | `GmailApp` (Apps Script's built-in Gmail service) | Already authorised as the mailbox owner. The raw Gmail REST API would need a Cloud project, a service account and domain-wide delegation — real work, and it makes the deployment something only a developer can repeat. |
| Intelligence | Anthropic Messages API, one call per *changed* thread | Direct HTTPS. Apps Script cannot install the official SDK (no npm, no Node runtime), so retries, backoff and error classification are written explicitly in `Classifier.gs`. |
| Output format | Structured outputs (`output_config.format`, JSON Schema) | The response is schema-constrained by the API rather than parsed hopefully from prose. A malformed verdict is impossible by construction; only an *unwise* one is possible, and the confidence gates catch those. |
| State | A Google Sheet | Apps Script's properties store caps near 500 KB. A Sheet is unbounded in practice, and — the reason that actually decided it — the office can read the system's memory and retune it from the `config` tab without a developer. The specification says *"we are not developers"*. |
| Scheduling | Two time-driven triggers | 15-minute scan; hourly sweep that also sends the digest at the configured local hour. |
| Interface | Gmail labels + one daily email | The specification rules out a CRM, a dashboard and a task application. Labels and email are the two surfaces the office already looks at, on every device, with nothing to install. |

**Why "every device" is free rather than expensive.** Gmail labels are
server-side properties of the mail. The script changes them on Google's servers;
every client — web, Android, iOS, Outlook over IMAP, a laptop bought next month
— reads them from that same server. There is no client component, so there is
nothing to port, distribute, update or support per device. The one setting that
is genuinely per-device is optional push notification for a label, and it takes
about ten seconds per phone.

---

## 2. How the next required action is determined

**By reading the conversation, and by explicitly refusing the four signals that
look like answers but are not.**

The model is instructed — and tested — to ignore whether a message is read or
unread, who sent the last message, whether we have replied, and how recently
anything happened. None of those distinguishes *answered* from *acted on*.

Instead, each changed thread is rendered into a compact transcript and the model
returns a single state, with its confidence, a one-line summary, and the
outstanding commitment in the thread's own words. The specification's own example
is encoded in the prompt and asserted in the test suite:

```
Customer: "Please send a quotation for 40 units."
Us:       "Thank you. We will prepare the quotation."
```

This stays **Company Next Step**. We answered; we did not act. The promise became
the outstanding item, and it remains ours until the quotation is sent — after
which the thread becomes **Customer Next Step**, and if they ask a further
question it returns to us immediately.

Two guarantees are implemented in code rather than left to the prompt, because a
prompt is guidance and this specification asked for a rule:

- **An uncertain model may never close a matter.** Completing a thread requires
  confidence ≥ 0.85; keeping it open requires only 0.65. A `COMPLETED` verdict
  below that threshold is converted to "still open, needs review". This is your
  *"if the AI is uncertain, the conversation should remain visible"* requirement,
  enforced structurally.
- **Overdue is arithmetic, never opinion.** The model is never asked whether
  something is late. Code computes that from the timestamp, in working hours.

The governing principle, and the reason the system is auditable:

> **The model judges intent. Code judges time.**

---

## 3. How unfinished commitments are remembered

Through a **commitment ledger** — one row per conversation in the state
spreadsheet, holding the current state, the outstanding commitment in the
thread's own words, **when we became responsible**, and **when that becomes
overdue**.

Four properties make it trustworthy:

1. **The clock starts when their message arrived**, not when the scanner
   happened to run. A scan at 14:00 on a message from 09:30 does not quietly
   award us four and a half hours.
2. **A follow-up does not reset the clock.** If a customer chases us three times,
   our deadline still dates from the original obligation. Otherwise the most
   impatient customer would be the easiest to keep waiting.
3. **The clock counts working hours.** An enquiry landing at 18:40 on Friday is
   not overdue at 09:00 on Saturday. Office days, hours and timezone are
   configurable; a six-day week is one cell.
4. **The ledger outlives the search window.** Threads drop out of Gmail's
   `newer_than:21d` window after three weeks; an obligation does not expire
   because a search query moved on. The hourly sweep walks the *ledger*, not the
   mailbox, so a commitment made five weeks ago still turns red on time.

Commitments become visible in three ways, all of which reach every device: the
`Workflow/! Overdue` label, the thread being pulled back into the inbox when it
goes overdue (so having read it once does not make it vanish), and the morning
digest, which lists the oldest obligation first.

---

## 4. Recommended AI model

**Claude Opus 5** (`claude-opus-5`), with adaptive thinking at *medium* effort.

The task looks like classification and is not. Deciding that "we'll revert
shortly" is an unfulfilled promise, that a courteous acknowledgement is not a
delivery, or that a thread switched hands three messages ago requires reading
intent across a whole conversation. Cheaper models handle the obvious 80% and
fail on exactly the threads this system exists to catch — the ones a busy person
already read and misjudged. The failure is also asymmetric: a missed obligation
costs a customer, while a slightly higher token bill costs a few tens of dollars
a month.

Three features of this model shape the integration directly:

- **Adaptive thinking** lets the model spend reasoning on the ambiguous threads
  and skip it on the obvious ones. An email queue is mostly obvious with
  occasional genuine difficulty — precisely that shape.
- **Structured outputs** make a malformed response impossible; the schema is
  enforced by the API.
- **Prompt caching** makes the stable half of the system prompt cost a tenth
  after the first call in each window.

`effort` and `model` are both single cells in the `config` tab. Dropping to
`claude-sonnet-5`, or to `low` effort, is a change the office can make and
reverse in ten seconds if the bill matters more than the marginal accuracy. We
would recommend running Opus 5 for the first month, reading the corrections log,
and only then deciding whether a cheaper setting holds up on your actual mail.

---

## 5. Estimated development hours

The build is complete. What follows separates what has been done from what
remains for your specific mailbox.

| Work | Hours |
|---|---|
| **Delivered** | |
| Architecture, state model, working-hours clock | 10 |
| Prompt design, taxonomy, structured-output schema | 8 |
| API integration: retries, backoff, refusal and truncation handling, cost logging | 6 |
| Scan loop: fingerprint dedupe, correction detection, locking, time budget | 8 |
| Labels, inbox resurfacing, daily digest | 7 |
| Sheet-backed ledger and no-code config layer | 5 |
| Test suite (126 assertions) and in-product self-tests | 8 |
| Documentation: install guide, operations, this proposal | 6 |
| *Subtotal* | **58** |
| **Remaining, per mailbox** | |
| Deployment, authorisation, API key, first preview run | 2 |
| Tuning against your real mail: office hours, SLA, search scope, confidence | 4 |
| Handover session and written runbook | 2 |
| Supervised first week — reading the corrections log, adjusting the prompt | 6 |
| *Subtotal* | **14** |

A comparable system commissioned from scratch would be budgeted at **60–75
hours**. The estimate above is narrow because the work is done and testable, not
because the scope has been trimmed.

---

## 6. Estimated delivery time

| | |
|---|---|
| Deployment to a live mailbox | **Same day** — about 15 minutes of clicking, per `INSTALL.md` |
| Running in observation mode (`dryRun`), no labels changed | Days 1–3 |
| Tuned and switched live | **Within one week** |
| Supervised operation, prompt tuned to your correspondence | Weeks 2–3 |
| Handover complete, office self-sufficient | **Three weeks from start** |

The observation period is not padding. It is where the office discovers that its
definition of "waiting on the customer" differs slightly from the model's — and
corrections made in that window teach the system before any label is trusted.

---

## 7. Fixed-price estimate

Quoted as a fixed price, because the scope is defined and the build is done.

| Package | Includes | Price |
|---|---|---|
| **Deployment** | One mailbox, tuned and live, handover session, 30 days of support | **Fixed: 14 hours at your standard rate** |
| **Each additional mailbox** | Separate deployment, separate config | **3 hours** |
| **Optional retainer** | Prompt tuning from the corrections log, quota and cost review, changes to categories or SLA | **2 hours per month** |

Excluded and billed only if requested: reading PDF attachments (see §9), a second
mailbox with shared state, calendar or CRM integration, and any change to the
five categories after sign-off.

**Running costs are separate and are yours directly**, not billed through us:

- **Google: nil.** Apps Script is included with free Gmail and with Workspace.
- **Anthropic: usage-based.** A mailbox seeing 40–60 new or updated conversations
  on a working day runs **$20–40 per month** at the default settings. Only
  *changed* threads are ever charged for, and the `log` tab records the token
  usage of every single call — the figure is auditable from day one, not
  estimated. Lowering `effort` to `low` roughly halves it.

---

## 8. Examples of similar Gmail / Workspace automation projects

**This section must be completed by the delivering party, and we will not
fabricate it.** A proposal's reference list is a claim about who has done what,
and inventing one would be misrepresentation — including to you, who would then
rely on it.

What belongs here, and what you should insist on seeing from any bidder:

- Two or three named Gmail or Workspace automations, with the mailbox volume each
  handled and what specifically was automated.
- For each, the **failure mode that mattered** and how it was handled — an
  automation that has never been wrong in production has never been in
  production.
- A contactable reference for at least one.
- A sample of the actual code, not screenshots of a dashboard.

In place of a portfolio, this submission offers something more directly
checkable: **the working system, its test suite, and its prompt are all in this
repository.** Run `node test/run.js` before you award anything. Read
`src/Prompt.gs` and judge whether the instructions match how your office actually
thinks about its mail. That is better evidence than a reference list.

---

## 9. Technical limitations and risks

Stated plainly, because each of these will eventually surface and it is cheaper
to hear it now.

### Material — read these before deciding

**Email content is sent to Anthropic.** This is the design. Message text from
changed threads leaves Google and is processed by Anthropic's API. API traffic is
not used to train models by default, and zero-retention arrangements are
available commercially — but if any part of this mailbox carries privileged,
classified or regulated correspondence, that is a procurement decision requiring
sign-off before deployment, not a technical detail. Three mitigations, in order
of strength: narrow `searchQuery` so sensitive correspondence is never scanned;
run a separate deployment for the sensitive mailbox with a tighter scope; or
negotiate a zero-retention agreement. We recommend deciding this *before* the
first live run, not after.

**The model will sometimes be wrong.** Not often, and less often on the threads
that matter — but a system claiming otherwise is being sold to you. The design
assumes error and contains it: low confidence routes to *Needs Review* rather
than to a wrong label, a `COMPLETED` verdict needs higher confidence than any
other, a human correction is permanent until the thread moves, and every decision
is logged with its confidence and reasoning. Budget for reading the corrections
log weekly during the first month.

**Attachments are not read.** The model sees message text only. If a quotation is
a PDF with no covering text, the system sees a near-empty message and is likely
to hedge to *Needs Review* — which is the safe failure, but a failure. Adding
attachment reading via the Files API is a well-defined extension, quoted
separately.

### Operational

| Risk | Reality | Handling |
|---|---|---|
| Apps Script execution limit | 6 minutes per run on free Gmail, 30 on Workspace | The loop stops itself at 4.5 minutes and the next trigger resumes. Nothing is lost or half-written. |
| Apps Script daily quotas | 20,000 URL fetches/day; 90 minutes of trigger runtime on free Gmail, 6 hours on Workspace | Well inside them at the default caps. Very large mailboxes should move to Workspace or narrow `searchQuery`. |
| Gmail search cap | 500 threads per query | `maxThreadsPerScan` defaults to 120; the scan is incremental and catches up across runs. |
| Latency | Up to 15 minutes from arrival to labelling | The trigger interval. It can be lowered to 5 minutes at proportionally higher cost. Not suitable if you need sub-minute reaction. |
| API outage or rate limit | 429 and 5xx are retried with exponential backoff; a persistent failure labels the thread *Needs Review* and retries next run | A thread is never silently dropped. Check the `log` tab. |
| Cost drift | A sudden surge of mail means a surge of calls | `maxClassificationsPerScan` is a hard fuse. Token usage is logged per call. |
| Key exposure | Anyone with edit access to the Apps Script project can read the API key | Restrict editor access to the project. Rotate the key on any staff change. |
| Non-English mail | The model handles mixed-language correspondence well. The *quote-stripping* patterns are English-centric | Threads in other scripts are classified correctly but cost more tokens, because quoted history is not trimmed. Adding local-language markers is a few lines in `Transcript.gs`. |
| Thread links and multiple sign-ins | Gmail permalinks assume the first signed-in account in a browser | If staff are signed in to several Google accounts, a digest link may open the wrong one. Use a dedicated browser profile. |
| Shared or delegated mailboxes | The script runs as one account | Deploy per mailbox. Delegated access does not carry Apps Script authorisation. |

### Deliberately out of scope

Not oversights — judgements that they are a different project:

- **Nothing is sent on your behalf.** The system never drafts, never replies,
  never auto-acknowledges. It labels and it reminds. Anything that writes to a
  customer is a separate decision with a separate risk profile, and should be.
- **No chasing of *their* deadlines.** The specification asks for alerts when
  *our* action is late. A customer who has gone silent for three weeks is also a
  commercial risk; a "waiting too long on them" clock is a natural phase two and
  is perhaps two hours of work.
- **No calendar, CRM or task-manager integration**, per the specification.
- **No analytics.** The ledger is a spreadsheet, so response-time and volume
  reporting is a pivot table away whenever you want it.
