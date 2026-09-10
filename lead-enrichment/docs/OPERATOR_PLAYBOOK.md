# Operator playbook — running this as a service

The system is built. This is how you turn it into repeatable paid work without
guessing at your own margins.

The single rule underneath all of it: **measure before you quote.** Every
published figure about enrichment hit rates comes from a vendor's own blog, and
none of it was measured on Indian clinic data. Your pilot is the only number
that is actually about your job.

---

## The five-step loop

### 1 · Intake — ask for more than the URLs

The client offers 2,000 LinkedIn URLs. Ask for four columns, not one:

```
LinkedIn URL, Name, Clinic, Domain
```

Say why, plainly: *"A profile URL on its own often doesn't resolve — LinkedIn's
data licensing changed after they shut down the main provider in 2025. If you
can add the person's name and clinic, my match rate roughly doubles and your
price goes down."*

This is the highest-leverage two minutes in the whole engagement. Clients almost
always have those columns already, sitting in the sheet they built the URL list
from.

### 2 · Pilot — 100 rows, always

```bash
./run.sh            # then put 100 in the "first N rows" box
```

Or: `python3 -m leadenrich.cli run leads.csv --limit 100`

Read `out/<run-id>_report.json`. It gives you the fill rate per column, which
providers hit and which missed, and what you spent. That file is your quote.

**Never skip the pilot to look responsive.** A quote built on a vendor's 90%
marketing figure is how a fixed-price job turns into unpaid manual work.

### 3 · Tune — the pilot tells you the order

Open `config/pipeline.yml` and reorder `waterfalls.email` by what actually hit
in *your* pilot. Two rules that hold generally:

* Put a **success-only biller** early (Findymail charges only when it finds
  something, so a miss costs nothing — asking it is free).
* Put a provider that returns **public source URLs** early too (Hunter does);
  those URLs populate your Source column, which is what makes the deliverable
  defensible rather than just a list.

Then set your caps in the `budget:` block so a runaway run cannot happen.

### 4 · Run and QA

```bash
python3 -m leadenrich.cli run leads.csv
```

Interrupted? `python3 -m leadenrich.cli resume <run-id>` picks up exactly where
it stopped. Nothing already paid for is bought twice.

Then work the review queue — that is the job the client is really paying for:

```bash
python3 -m leadenrich.cli review <run-id>
```

Each row names the problem and suggests the fix. Budget **1–2 minutes per review
row**. On a 2,000-row job expect 200–500 review rows depending on input quality.
That is your real labour cost, and it is why input columns matter so much.

### 5 · Deliver

```bash
python3 -m leadenrich.cli deliver <run-id> --client "Acme Clinics" --operator "Your Name"
```

That writes `out/<run-id>_handover/` and a zip beside it, holding five files:
`Leads.csv`, `Needs-review.csv`, `Audit-trail.csv`, a cover `README.md` and a
`Data-dictionary.md`. Send the folder. Nothing else needs writing.

Two decisions are already made for you inside it, and both are worth
understanding before a client asks.

**The audit file goes with the delivery, not in your drawer.** The older advice
— keep the evidence, send only the list — protects you and nobody else. Handing
over the source URL, provider and check date against every value converts a
spreadsheet anyone could have bought into a defensible record, and it makes the
one question that ends most freelance relationships ("where did this come
from?") answerable by the client themselves, in ten seconds.

**The cover note reports the blanks, not just the fills.** It lists how many
Email cells are empty because the domain was catch-all, how many because only a
shared `info@` existed, and how many numbers were withheld for having no public
evidence. Volunteering that reads as confidence, because a supplier who is
hiding a weak fill rate does not itemise it. It also forecloses the argument
where a client reads a blank cell as work not done.

Add one paragraph in the covering email, every time:

> *N rows delivered. Email filled on X%, phone on Y%. Phone numbers are business
> lines published by each clinic, with the source URL and check date recorded
> against every one. M rows are listed as unresolved — a profile URL alone did
> not identify them; send me names or clinic names for those and I'll re-run
> them at no charge.*

That last clause costs you almost nothing and reliably turns a complaint into a
second batch.

If the engagement is for the *pipeline* rather than a list, `./package.sh` builds
`dist/lead-enrichment-<date>.zip` — code, tests, blueprints and documentation,
with `.env`, run databases and caches excluded and a credential scan that refuses
to seal the archive if anything key-shaped survived.

---

## Pricing this honestly

Three components. Work them out from *your* pilot, not from a template.

**1 · Data cost.** `report.json` gives estimated credits per provider. Multiply
by your actual per-credit rate. Two structural facts that will not change:

* Email discovery cost is dominated by **misses**, not hits — except at
  success-only billers. That is the whole argument for waterfall ordering.
* Google Places calls requesting phone or website bill at the **Enterprise**
  SKU (≈$20/1,000, with roughly 1,000 free Enterprise calls a month since
  Google retired the shared $200 credit in March 2025). A 2,000-row job
  straddles that free tier: split it across two billing months, or budget for
  roughly one Enterprise-rate thousand.

**2 · Your time.** Review-queue minutes × your rate. This is usually the biggest
line, and it is the one people forget when they quote.

**3 · Margin.** Yours.

### Quote the structure, not just a number

A flat "₹X for 2,000 records" invites a fight about the rows that did not
resolve. Quote in two parts instead:

* A **setup/pilot fee** covering the first 100 rows and the tuning pass.
* A **per-delivered-row price** for rows that clear the quality gate, with
  unresolved rows listed but not charged.

You are paid for what you deliver; the client pays only for what they can use.
Both sides can defend that, and it removes the only argument this kind of work
reliably produces.

---

## What raises coverage, in order of effect

1. **Ask for `Domain`.** Most email finders are domain-first. Nothing else comes
   close to this for lift.
2. **Ask for `Name`.** A slug is a guess; a name is a key.
3. **Add a third email provider.** Each one only sees what the previous ones
   missed, so a third provider costs little and adds real coverage.
4. **Add `Location`.** Disambiguates common clinic names in Places lookups —
   there are a lot of "Sunrise Clinic"s in India.
5. **Loosen the gate only deliberately.** Setting `export_risky: true` raises the
   apparent fill rate and lowers the real one. If you use it, tell the client
   which rows were risky — they are flagged in the review file.

## What to refuse

* **"Just give us their personal mobile."** See [`COMPLIANCE.md`](COMPLIANCE.md).
  Offer the published business line and the reasoning; it is a better answer to
  what they actually want, which is to reach the decision-maker.
* **"Can you export from Sales Navigator?"** Not without breaching LinkedIn's
  terms. Sales Navigator is a discovery aid; it is not an export API, and it is
  unnecessary when the client is supplying the URLs anyway.
* **"Guarantee 95% coverage."** Nobody can guarantee that on Indian clinic SMB
  data, and the people quoting it are quoting a US tech-B2B benchmark. Guarantee
  your *process* and your *transparency* instead — a measured pilot, a stated
  fill rate, and a source URL behind every cell. That is a stronger sales
  position than a number you cannot hit, and it survives contact with the data.

---

## Command reference

| Command | Does |
|---|---|
| `./run.sh` | Browser interface on port 8000 |
| `leadenrich demo` | Fictional sample run, no keys, no network |
| `leadenrich doctor` | What is configured, what is missing |
| `leadenrich smoke --provider hunter --name "A B" --domain x.com` | One live call, raw response beside the parse |
| `leadenrich run leads.csv --limit 100` | Pilot |
| `leadenrich run leads.csv` | Full run |
| `leadenrich resume <run-id>` | Continue after an interruption |
| `leadenrich review <run-id>` | Work the review queue |
| `leadenrich export <run-id> --sheet --sheet-id <ID>` | Re-export, push to Sheets |
| `leadenrich deliver <run-id> --client "Name"` | Build the client handover folder and zip |
| `./package.sh` | Package the system itself for handover |
| `leadenrich runs` | List previous runs |

Prefix with `python3 -m leadenrich.cli` (or install the package and use
`leadenrich` directly).
