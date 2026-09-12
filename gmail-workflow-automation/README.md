# Gmail Workflow Automation

An AI classifier that reads your Gmail conversations, works out **whose move it
is**, labels them accordingly, and refuses to let an unfinished matter disappear
just because somebody opened it on their phone.

Built to the specification in *Gmail Workflow Automation with Google Apps Script
and AI*. No CRM, no dashboard, no second application to check — the office keeps
working in Gmail exactly as before.

---

## One deployment. Every device. No installs.

This was the first requirement, so it is the first section.

The system runs as a **Google Apps Script bound to the mailbox**, not as an app
on a machine. It executes on Google's servers on a timer. What it changes —
labels, inbox placement, importance markers — are *server-side properties of the
mail itself*. Every client that signs in to the mailbox reads those properties
from the same server.

So there is nothing to install on a laptop, nothing to install on a phone, and
nothing that stops working when a device is replaced.

| Surface | Labels &amp; state | Overdue resurfacing | Daily digest | Install needed |
|---|---|---|---|---|
| Gmail on the web | Yes | Yes | Yes | None |
| Gmail on Android | Yes | Yes | Yes | None |
| Gmail on iPhone / iPad | Yes | Yes | Yes | None |
| Outlook / Apple Mail / Thunderbird over IMAP | Yes, as folders | Yes | Yes | None |
| A brand-new device signed in tomorrow | Yes, immediately | Yes | Yes | None |
| Someone else granted access to the mailbox | Yes | Yes | Add their address to `digestRecipients` | None |

**The only genuinely per-device setting is optional**: push notifications for a
specific label. On the Gmail mobile app, *Settings → (account) → Manage labels →
`Workflow/! Overdue` → Label notifications*. Turn that on and the phone buzzes
when something goes past its deadline — on each phone you want buzzed. Everything
else is set once, centrally, and follows the account.

To cover several mailboxes, deploy one copy of the script per mailbox. They share
no state by design: each mailbox keeps its own ledger, its own office hours and
its own deadlines.

---

## What it actually decides

The specification is blunt about the failure it wants fixed:

> The main problem is that an important email can be read when we are busy but
> cannot respond immediately. Once the email is marked as read, it can later be
> forgotten.

So the system never uses read/unread, who sent the last message, or whether we
replied as evidence of anything. It reads the whole conversation and judges the
next required action. The worked example from the specification is encoded
directly in the prompt and covered by a test:

```
Customer: "Please send a quotation for 40 units."
Us:       "Thank you. We will prepare the quotation."
```

That thread stays **We Must Act**. We answered, but we did not act. The promise
has become the outstanding item, and it stays ours until the quotation is
actually sent — at which point the thread becomes **Waiting On Customer**, and if
they ask a further question it comes straight back to us.

### The labels

| Label | Meaning |
|---|---|
| `Workflow/1 New Enquiry` | A new request nobody has engaged with yet |
| `Workflow/2 We Must Act` | We owe an answer, a quotation, documents, a call, a decision |
| `Workflow/3 Waiting On Customer` | Delivered; the ball is genuinely in their court |
| `Workflow/4 Official & Financial` | Government, tax, regulator, bank, insurance — shorter clock |
| `Workflow/5 Done` | Demonstrably concluded |
| `Workflow/! Overdue` | An overlay: we are past the agreed response time |
| `Workflow/? Needs Review` | An overlay: the system was not confident enough to decide |

The numeric prefixes force Gmail's alphabetical sidebar into workflow order.
`!` and `?` sort above the digits, so the two labels that demand attention sit at
the top of the list on every device.

---

## The design decision that matters

> **The model judges intent. Code judges time.**

A language model is the right tool for reading a thread and working out that
"we'll revert shortly" is an unfulfilled promise. It is the wrong tool for
answering "has this been open for more than sixteen working hours?" — that is
arithmetic, it must be exact, and it must be reproducible.

So the model returns a *state*, and `Workflow.gs` decides when that state has
gone stale. Every overdue alert in this system can be recomputed from a
timestamp. No model call is involved in raising one, and no model call can
suppress one.

The clock counts **working hours**, not calendar hours: an enquiry arriving at
18:40 on Friday is not late at 09:00 on Saturday. Office days, opening hours and
timezone are all configurable from a spreadsheet.

### Two rules enforced in code, not trusted to the prompt

1. **An uncertain model may never close a matter.** Closing a thread requires
   higher confidence (`0.85`) than keeping it open (`0.65`). A `COMPLETED`
   verdict below that threshold is converted to "still open, needs review". This
   is the specification's *"if the AI is uncertain, the conversation should
   remain visible for review instead of being treated as completed"* — a
   guarantee, not an instruction the model might overlook.
2. **A customer chasing us cannot reset our own deadline.** The clock starts when
   we became responsible and does not restart when they follow up. Otherwise the
   most impatient customer would be the easiest to keep waiting.

---

## Architecture

```
                  time-driven trigger, every 15 minutes
                                  │
                                  ▼
  Gmail search ──► fingerprint ──► changed? ──no──► run the clock only  (free)
                                     │
                                    yes
                                     │
              strip quotes, signatures, legal footers  (Transcript.gs)
                                     │
                    one Anthropic API call per thread  (Classifier.gs)
                    cached system prompt · JSON schema
                                     │
                       state machine + working clock  (Workflow.gs)
                                     │
                 ┌───────────────────┼───────────────────┐
                 ▼                   ▼                   ▼
          Gmail labels          state ledger         daily digest
        (every device)        (a spreadsheet)      (every device)
```

| File | Responsibility |
|---|---|
| `Main.gs` | Entry points — `setup`, `previewScan`, `status`, triggers |
| `Scanner.gs` | The run loop: dedupe, corrections, time budget, locking |
| `Workflow.gs` | Pure decision core — the clock, the state machine, label diffing |
| `Classifier.gs` | The only code that talks to the Anthropic API |
| `Prompt.gs` | The taxonomy, the rules, the response schema |
| `Transcript.gs` | Thread → smallest text that still tells the whole story |
| `Labels.gs` | Applying state to Gmail |
| `Digest.gs` | The morning email |
| `Store.gs` | The ledger: a Google Sheet |
| `Config.gs` | Every tunable, overridable from the sheet |
| `Tests.gs` | `selfTest` and `testApiConnection`, runnable after install |

### Why a spreadsheet is the database

Apps Script's properties store caps out around 500 KB — a few thousand threads.
A Sheet holds millions of rows, and it buys two things a database would not: the
office can *read* the system's memory, and the `config` tab lets them retune the
SLA, the office hours, the digest time and the model without opening the editor.
The specification says plainly *"we are not developers"*. That constraint drove
this choice.

---

## Not paying twice for the same email

Three mechanisms, in order of how much they save:

1. **Fingerprinting.** A thread's identity is its message count plus the identity
   of its last message. Unchanged means no model call — only the clock runs.
   On a typical mailbox this eliminates the large majority of would-be calls.
2. **Quote stripping.** A ten-message thread re-quotes itself ten times. Removing
   quoted history, signatures and legal footers typically removes 60–80% of the
   characters and loses nothing, because the transcript is assembled message by
   message anyway. Old middle messages are compressed to one line; the opening
   request and the recent messages — where the next step lives — are kept whole.
3. **Prompt caching.** The system prompt is byte-identical on every call and is
   marked cacheable, so it is billed at a tenth after the first call in each
   window. The correction history, which changes, is deliberately placed *after*
   it — a prefix cache is destroyed by any byte that moves before it.

Actual token usage is written to the `log` tab on every call, so the bill is
never a surprise.

---

## Corrections, and how the system learns

If the classification is wrong, change the label in Gmail. That is the whole
procedure, and it works from any device.

On the next scan the system notices that the label disagrees with its own record
while the thread itself has not moved. It then:

- records the correction in the `corrections` tab;
- adopts your label and recomputes the deadline from it;
- **stops overruling that thread** until a new message arrives;
- replays recent corrections to the model as binding precedent on later threads.

So correcting "this regulator is Official & Financial, not a New Enquiry" once
teaches the system about that regulator, with no retraining, no fine-tuning and
no developer involved.

---

## Testing

```bash
node test/run.js      # 126 assertions, no Google account required
```

The `.gs` sources are loaded into a Node sandbox with the Apps Script services
left undefined on purpose — anything reaching for `GmailApp` from what should be
pure logic fails loudly. Covered: the working-hours clock across weekends and
evenings, every state transition, the refusal to close on low confidence, label
diffing, quote stripping, HTML escaping of hostile subject lines, API retry
behaviour, and the exact JSON body sent to the API.

After installing, run `selfTest()` in the Apps Script editor. It re-checks the
clock through Apps Script's own date handling rather than Node's, because a
one-hour disagreement between the two would silently move every deadline.

---

## Install

See [INSTALL.md](INSTALL.md) — about fifteen minutes, no developer required.
The commercial and technical proposal the specification asks for is in
[PROPOSAL.md](PROPOSAL.md).
