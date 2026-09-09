# Compliance: what this system will and will not do

*Not legal advice. This is the reasoning behind the software's defaults, written
so you can explain those defaults to a client and so a lawyer can check them.*

---

## The request, and the substitution

The brief asks for a **"verified mobile number (+91)"** for 2,000 clinic
decision-makers in India. Read literally, that is a personal-mobile list,
assembled at scale, for cold outreach to Indian citizens.

This system does not build that. It builds something adjacent and defensible:

> **Published business contacts, each carrying the URL that proves publication,
> and each labelled with what kind of line it actually is.**

That substitution is not squeamishness. It is the difference between a
deliverable a client can use and one that transfers a regulatory liability to
them the moment they dial it.

---

## Why: the two Indian regimes that bite

### 1. Digital Personal Data Protection Act, 2023

The Act carves out personal data **the data principal themselves made public**
(s.3(c)(ii)). The carve-out is narrower than the industry treats it:

* Claiming it requires you to be able to **verify the source** of each datum.
  A number scraped from an aggregator, with no record of where it came from, is
  not defensibly within the exemption.
* Legal commentary is consistent that it does **not** authorise indiscriminate
  scraping, and that web crawlers and telemarketing operations cannot assume
  their activity is exempt.
* **Direct marketing requires prior opt-in consent, including in B2B.** Implied
  consent is not a lawful basis under the Act.

The design consequence, which is also just good engineering: **every delivered
field carries its source URL and a check timestamp.** Provenance is not a
nicety here; it is the thing that makes a source-verification claim possible at
all.

### 2. TCCCPR 2018, as amended 12 February 2025

Commercial calling in India is a registration regime, not an open market:

| Requirement | Detail |
|---|---|
| Registration | Principal Entities and telemarketers must pre-register, with physical verification and biometric authentication |
| Numbering | Promotional calls must originate from the **140** series |
| Hours | Calling confined to **09:00–21:00** |
| DND | The Do Not Disturb registry is binding; calling a registered number is a direct violation |
| Penalties | **₹2 lakh** first instance, **₹5 lakh** second, **₹10 lakh** per instance thereafter |

A harvested personal mobile is precisely the artefact this regime exists to
suppress. Handing a client 2,000 of them, described as "verified", hands them
the exposure too.

---

## What the system delivers instead

| Class | Definition | Delivered? |
|---|---|---|
| `clinic_main_line` | The clinic's own published number — Google Business Profile, or its website contact page | **Yes**, labelled |
| `published_direct_line` | A number the clinic itself publishes *against the named individual* ("Dr Mehta — direct: …") | **Yes**, labelled, with evidence URL |
| `published_business_mobile` | A mobile the business publishes as its own business contact — very common for Indian clinics, where the practice mobile *is* the business line | **Yes**, labelled, with evidence URL |
| `provider_supplied_unpublished` | A data provider's `mobile_phone` field, with no public evidence behind it | **No.** Off by default. |

### The rule that is enforced in code

`allow_provider_personal_mobile` defaults to **false**. If an operator switches
it on under their own legal basis, three things still hold, and all three are
covered by tests in `tests/test_phone_policy.py`:

1. The number keeps the label `provider_supplied_unpublished`.
2. Its human-readable label reads
   *"provider-supplied, no public evidence — NOT a verified personal mobile"*.
3. Its row goes to the review queue.

**There is no code path that turns an unevidenced number into a "verified
mobile".** That was the single hardest constraint in the brief and it is the one
most worth keeping.

---

## What this system does not do

* **No LinkedIn access-control bypass.** No session cookies, no `li_at` token
  reuse, no headless logins, no fake accounts. Proxycurl was sued by LinkedIn in
  January 2025 over exactly that pattern, settled, shut down on 4 July 2025, and
  a permanent injunction followed. The only LinkedIn data this system touches is
  the URL string the client already gave you.
* **No robots.txt violations.** The website reader checks `robots.txt` before
  every fetch and skips disallowed paths.
* **No outreach.** This software reads and enriches. It sends nothing — no
  email, no SMS, no calls. Whatever the client does next is theirs, under their
  own registration.
* **No purchases.** It never buys credits or signs anything up.

---

## What to tell your client

Short version, usable verbatim:

> For every contact I deliver a business phone number that the clinic itself has
> published — on its Google Business listing or its own website — together with
> the source URL and the date I checked it, and a label saying whether it is the
> main clinic line or a direct line published for that individual.
>
> I do not supply harvested personal mobile numbers. Under the DPDP Act 2023 and
> TRAI's TCCCPR rules, a scraped personal-mobile list is a compliance liability
> for whoever calls it, with penalties up to ₹10 lakh per instance — and every
> number I give you comes with proof of where it was published, which is what
> makes lawful use possible in the first place.
>
> In practice the published clinic line is also the number that actually gets
> answered in working hours.

Clients who came expecting a mobile list usually accept this, because it is a
better answer to the problem they actually have: reaching the decision-maker.

---

## Retention

The audit file (`*_audit.csv`) holds, per row: source URL, provider, check
timestamp, contact type, validator verdict and sub-status, ownership class, and
every provider call attempted. Keep it for as long as you keep the delivery
file — it is the evidence behind every cell you shipped. Delete both together
when the engagement ends.

*Sources for the legal position are cited in [`RESEARCH.md`](RESEARCH.md) §3.4.*
