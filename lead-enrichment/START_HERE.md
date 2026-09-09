# Start here

Three steps. You do not need any API keys for step 1.

## 1. See it work (30 seconds, no accounts needed)

```bash
cd lead-enrichment
./run.sh
```

Your browser opens on `http://127.0.0.1:8000`. Press **Run the demo**.

It processes eight sample rows using fictional data and no network calls, and
shows you exactly what a real run produces — including the rows it *refuses* to
deliver and why. That refusal behaviour is the point of the system, so watch for
it.

Prefer the terminal? `python3 -m leadenrich.cli demo`

## 2. Add your keys, when you have them

```bash
cp .env.example .env      # run.sh does this for you on first launch
```

Open `.env`, paste a key next to the right name, save. Then:

```bash
python3 -m leadenrich.cli doctor
```

That prints exactly which providers are live, which are missing, and what each
one needs. **You do not need all of them.** One email finder plus one validator
already gives you a working system; every extra provider you add raises coverage
because it only sees the rows the previous one missed.

Minimum useful set to start with:

| Buy this | Why |
|---|---|
| **Hunter.io** | Email finder *and* verifier in one key, and it returns the public source URLs your Source column needs. |
| **Google Maps API key** | Published clinic phone numbers, first-party and licensed. Free tier covers roughly 1,000 lookups a month. |

Add Prospeo, Findymail or Apollo later purely to lift the hit rate.

## 3. Run your real list

Drop your CSV on the page and press **Run enrichment**.

Your file needs a `LinkedIn URL` column. Any of these also help a great deal and
are worth asking the client for:

| Column | Effect |
|---|---|
| `Name` | Large lift. A bare profile URL often will not resolve on its own. |
| `Clinic` | Enables the phone lookup and most email finders. |
| `Domain` | The single biggest lift for email discovery. |
| `Location` | Disambiguates clinics with common names. |

**Always run a pilot first.** Put `100` in the "only process the first N rows"
box. Look at the fill rates. *Then* decide what to quote — see
[`docs/OPERATOR_PLAYBOOK.md`](docs/OPERATOR_PLAYBOOK.md).

---

## What you get back

Three files, every time:

| File | What it is | Who sees it |
|---|---|---|
| `*_delivery.csv` | `Name, Role, Clinic, Phone, Email, Source` | **The client.** |
| `*_audit.csv` | Every source URL, provider, timestamp, validator verdict, contact type | You. Your proof if anything is queried. |
| `*_review.csv` | Rows that need a human, each with a suggested action | You, before you deliver. |

## Two things to know before you sell this

**1. A LinkedIn URL alone is a weak input.** Proxycurl — the tool everyone used
for "URL in, data out" — was sued by LinkedIn and shut down on 4 July 2025. What
remains is *matching* against providers who already hold a record, and a miss is
a normal outcome. Ask the client for names and clinic names alongside the URLs.
It costs them nothing and transforms your hit rate.

**2. The brief says "verified mobile number". This system delivers published
business contacts instead, correctly labelled.** That is deliberate, and
[`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) explains why in terms you can put in
front of a client: India's DPDP Act 2023 and TRAI's TCCCPR rules make a scraped
personal-mobile list a liability, with penalties running to ₹10 lakh per
instance. A published clinic line with a source URL is the deliverable you can
actually stand behind — and it is the number that gets answered during business
hours anyway.

## Everything else

| | |
|---|---|
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Provider-by-provider research, verified API contracts, costs, sources |
| [`docs/OPERATOR_PLAYBOOK.md`](docs/OPERATOR_PLAYBOOK.md) | How to run this as a service: pilot, price, deliver, QA |
| [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) | DPDP, TCCCPR, and what this system will and will not do |
| [`docs/CLIENT_REPLY.md`](docs/CLIENT_REPLY.md) | A ready-to-send reply to the job post, with a sample |
| [`README.md`](README.md) | Architecture, commands, configuration reference |
