# Make.com build — setup

Two scenarios, one Google Sheet, six API keys. About 40 minutes end to end,
most of it spent creating provider accounts.

Everything in `blueprints/` has been validated against Make's live schema API
and passes a link-checker that verifies every `{{module.field}}` reference
points at a module that actually exists and runs earlier on the same route.
What that does **not** prove is that the provider APIs behave as documented —
see [What is verified](#what-is-verified) at the end.

---

## What you are importing

| Scenario | What it does | Reads | Leaves |
|---|---|---|---|
| **1 · Identity + Email waterfall** | Apollo resolves the person, then Prospeo → Findymail → Hunter are tried in order until one returns an address | rows marked `pending` | `email_done` |
| **2 · Validate, Phone & Deliver** | ZeroBounce validates, Google Places finds the clinic's published number, both gates run, the delivery decision is written | rows marked `email_done` | `complete` |

**Why two scenarios rather than one.** Make has a constraint that shapes this
design: a filter that fails stops the entire route for that row — it cannot skip
a single module — and router branches cannot merge back together. A waterfall
that stops paying after the first hit therefore *has* to branch, and everything
downstream of the branch would have to be duplicated in every branch. Splitting
where the email is resolved keeps each branch to a single sheet write.

It also buys you something valuable: the sheet is a checkpoint. If you change a
validator setting, re-run scenario 2 alone. You do not re-buy email discovery.

---

## Step 1 · Build the sheet

Follow [`sheet/README.md`](sheet/README.md). Five minutes: create the
spreadsheet, import `Leads.csv`, paste two formulas into two new tabs, copy the
spreadsheet ID out of the URL.

Keep that ID to hand — you paste it four times in step 4.

## Step 2 · Connect Google Sheets in Make

In Make: **Connections → Add → Google Sheets**, and sign in with the Google
account that owns the spreadsheet. Do this once now; both scenarios reuse it.

## Step 3 · Import the scenarios

For each file in `blueprints/`:

1. **Scenarios → Create a new scenario**
2. Click the **⋯** menu (bottom bar) → **Import Blueprint**
3. Upload the `.json`
4. Save

Import scenario 1 first — the module numbering in this guide assumes it.

## Step 4 · Fill in the placeholders

The blueprints ship with `{{PLACEHOLDER}}` markers instead of secrets. Nothing
sensitive is in the files, which is why they are safe to store in a repo or send
to a colleague.

Open each module listed and replace the marker with the real value.

### Scenario 1

| Module | Field | Replace |
|---|---|---|
| 1 · Search Rows | Spreadsheet ID | `{{SPREADSHEET_ID}}` |
| 3 · Apollo | header `x-api-key` | `{{APOLLO_API_KEY}}` |
| 5 · Prospeo | header `X-KEY` | `{{PROSPEO_API_KEY}}` |
| 7 · Update a Row | Spreadsheet ID | `{{SPREADSHEET_ID}}` |
| 8 · Findymail | header `Authorization` | `{{FINDYMAIL_API_KEY}}` (keep `Bearer `) |
| 10 · Update a Row | Spreadsheet ID | `{{SPREADSHEET_ID}}` |
| 11 · Hunter | query `api_key` | `{{HUNTER_API_KEY}}` |
| 12 · Update a Row | Spreadsheet ID | `{{SPREADSHEET_ID}}` |

### Scenario 2

| Module | Field | Replace |
|---|---|---|
| 1 · Search Rows | Spreadsheet ID | `{{SPREADSHEET_ID}}` |
| 3 · ZeroBounce | query `api_key` | `{{ZEROBOUNCE_API_KEY}}` |
| 5 · Places search | header `X-Goog-Api-Key` | `{{GOOGLE_MAPS_API_KEY}}` |
| 6 · Places details | header `X-Goog-Api-Key` | `{{GOOGLE_MAPS_API_KEY}}` |
| 8 · Update a Row | Spreadsheet ID | `{{SPREADSHEET_ID}}` |

On every **Search Rows** and **Update a Row** module, also pick your Google
Sheets connection from the dropdown at the top. Make cannot carry a connection
across accounts, so this is always a manual step for any imported blueprint.

Then confirm on each Sheets module: **Sheet Name** `Leads`, **Table contains
headers** `No`, **Column range** `A1:BZ1`. The importer should have set these —
check anyway, because getting *headers* wrong shifts every column mapping.

## Step 5 · Get the keys

You do **not** need all six to start. A provider with no key simply fails and
the error handler moves on. The honest minimum is **Hunter + Google Maps**:
that gives you email discovery, email validation and published phone numbers.

| Key | Where | Why it matters |
|---|---|---|
| `HUNTER_API_KEY` | hunter.io | Finder **and** verifier on one key, and it returns the public URLs where an address was seen — the evidence your Source column is built from. |
| `GOOGLE_MAPS_API_KEY` | Google Cloud Console → enable **Places API (New)** | Published clinic phone numbers. Phone and website are Enterprise-SKU fields (~$20/1,000, roughly 1,000 free Enterprise calls a month). |
| `ZEROBOUNCE_API_KEY` | zerobounce.net | Proper validation. Costs nothing on an `unknown` result. |
| `PROSPEO_API_KEY` | prospeo.io | Takes the LinkedIn URL directly, so it can run before a domain is known. |
| `FINDYMAIL_API_KEY` | findymail.com | Charges only on a hit, so a miss is free — which is why it sits second. |
| `APOLLO_API_KEY` | apollo.io | Identity resolution. Paid plan required for API access. |

If you skip Prospeo and Findymail, scenario 1 still works: those two modules
error, Resume catches it, and Hunter does the finding.

## Step 6 · Run a pilot

In each scenario, module 1 has a **Limit** field. Set it to `5`, click **Run
once**, and watch the Leads sheet fill in.

Check three things before scaling up:

1. Columns H–O populate on scenario 1 (name, role, clinic, email).
2. Columns P–AF populate on scenario 2, and **AE `deliverable`** says `yes` or
   `no` rather than being blank.
3. The Delivery and Review tabs are showing rows.

Then raise the limit to `100` and run a real pilot. **Price the job from that
pilot, not from anyone's published hit rate** — no vendor benchmark was measured
on Indian clinic data.

## Step 7 · Schedule

Set each scenario's schedule to run every 15 minutes. Scenario 1 drains
`pending`; scenario 2 drains `email_done` behind it. With a limit of 100, a
2,000-row job clears in about ten hours unattended.

---

## What it costs to run

**Make operations.** One module execution is one operation. Routers are free.

| | Per row |
|---|---|
| Scenario 1 | 5 (email found first try) to 7 (all three tried) |
| Scenario 2 | 7 |
| **Total** | **~12–14** |

For 2,000 rows that is roughly **26,000 operations**. Make's Core plan is
$16/month for 10,000, so budget for extra operations or a higher tier — call it
**$45–60 for the month** you run the job. Verify against Make's current pricing
page before quoting; the numbers above were checked in September 2026.

**Provider costs** are separate and depend on your per-credit rates. The
structural points: email discovery cost is dominated by misses (except at
Findymail, which charges only on success — the reason it sits second), and
Places calls that request phone or website bill at the Enterprise SKU.

---

## The quality gates, and why cells come back blank

A blank Email cell is a decision, not a failure. Three different rules produce
one, and all three are in **module 4** of scenario 2:

* **Catch-all** — the domain accepts every address, so a "valid" verdict proves
  nothing about *this* mailbox. Refused.
* **Role mailbox** — `info@`, `reception@` and the like are deliverable but are
  not the decision-maker's inbox. Refused. (The test is comma-wrapped on both
  sides, so `salesh@` is not mistaken for `sales@`.)
* **Unknown / not validated** — the gate fails closed. Anything the validator
  could not settle is refused rather than assumed.

Phones have their own rule, in **module 7**: a number ships only with the URL
proving the clinic published it. No source, no delivery.

**To loosen a gate** (your call, and document it to the client): in scenario 2
module 4, edit `email_accepted`. Removing the role-mailbox branch will raise
your apparent fill rate and lower the real one.

---

## What is verified

**Verified against Make's live API** — module names, parameter shapes, and both
complete blueprints against the schema validator. Three real bugs were caught
that way and fixed: the search module is `filterRows` not `searchRows`;
`builtin:Resume` rejects an `output` field; and Sheets **filters address columns
by letter (`"G"`) while values and output references use zero-based indices
(`"6"`, `{{1.6}}`)** — a mismatch that imports cleanly and then returns empty
cells on every row.

**Verified locally** — a link-checker (`lint_blueprints.py`, with its own tests
in `test_lint.py`) proves every module reference resolves to a module that
exists and runs earlier on the same route, that no HTTP call lacks an error
handler, and that no numeric column reference sits inside a formula where Make
cannot tell `1.12` from a decimal number.

**Not verified** — the provider APIs themselves. No account exists here, so
nothing has been executed live. Request shapes follow current documentation
(cited in [`../docs/RESEARCH.md`](../docs/RESEARCH.md)), but the first 5-row
pilot is what turns "documented" into "working". Run it before you promise a
date.

**Also not verified** — the Google Sheets modules could not be parameter-checked
without a live Sheets connection in the account. Their field names come from
Make's own module schema, but step 6's pilot is where you confirm them.

---

## Files

| | |
|---|---|
| `blueprints/01-identity-and-email-waterfall.json` | Import into Make first |
| `blueprints/02-validate-phone-and-deliver.json` | Import second |
| `sheet/Leads.csv` | Import as the `Leads` tab |
| `sheet/README.md` | Sheet setup and the full column map |
| `build_blueprints.py` | Regenerates both blueprints — edit here, not the JSON |
| `lint_blueprints.py` | Checks references, error handlers and formula safety |
| `test_lint.py` | Proves the linter catches the bugs it claims to |

To change a provider or a column: edit `build_blueprints.py`, then

```bash
python3 build_blueprints.py && python3 lint_blueprints.py
```

Hand-editing the JSON works too, but re-run the linter afterwards — it catches
the reference breakage that is otherwise invisible until row 1 fails.
