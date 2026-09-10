# Lead delivery for **Sample Client**

> **⚠ SAMPLE BUNDLE — FICTIONAL DATA.** This was produced from the
> built-in demo fixtures. Every name, clinic, number and address below
> is invented, and every `.example` domain is reserved by RFC 2606 and
> cannot resolve. It shows the delivery *format*, nothing more.

**Run reference:** `run-EXAMPLE`  
**Delivered:** (date of your run)

## What is in this folder

| File | What it is |
|---|---|
| `Leads.csv` | The deliverable. Six columns: Name, Role, Clinic, Phone, Email, Source. |
| `Needs-review.csv` | Rows a human should look at, each with the reason and a suggested action. |
| `Audit-trail.csv` | Every field with its provider, source URL and check timestamp. Your evidence file. |
| `Data-dictionary.md` | What every column and every phone label means. |

## Coverage

|  | Count |
|---|---|
| Rows supplied | 8 |
| Duplicates removed | 1 |
| Rows delivered | 7 |
| Rows flagged for review | 5 |

### Fill rate by column

| Column | Filled |
|---|---|
| Name | 7 of 7  (100.0%) |
| Role | 6 of 7  (85.7%) |
| Clinic | 6 of 7  (85.7%) |
| Phone | 6 of 7  (85.7%) |
| Email | 3 of 7  (42.9%) |

### What kind of number each Phone cell holds

| Type of line | Rows |
|---|---|
| business mobile (published) | 5 |
| direct business line (published) | 1 |

Every one of these was published by the business itself, and the URL that proves it is in the audit file against that row.

## Why some cells are blank

A blank cell here is a decision, not a gap in effort. Each one below was found and then refused, or genuinely not found — and you can see which in the audit file.

**Email**

| Reason | Rows |
|---|---|
| no address found by any provider | 2 |
| catch-all domain -- the server accepts every address, so it proves nothing | 1 |
| only a shared mailbox was found (info@, contact@ ...) | 1 |

**Phone**

| Reason | Rows |
|---|---|
| no published business number found | 1 |

## The two rules this delivery was built on

**1 · Deliverability is not ownership.** A validator answers one question: will mail sent here arrive? It cannot tell you whose mailbox it is. So an address on a catch-all domain — where the server accepts everything — is never counted as confirmed, and a shared `info@` box is never presented as a named person's address.

**2 · Every phone number was published by the business.** Each is labelled as the clinic's main line, a direct line published for that individual, or a business mobile the clinic itself lists. Numbers supplied by a data vendor without public evidence are retained in the audit file, labelled as such, and withheld from the deliverable. Nothing in this bundle is presented as a verified personal mobile, because nothing in it is one.

Under India's Digital Personal Data Protection Act 2023 and TRAI's TCCCPR rules, the liability for calling a harvested personal-mobile list sits with whoever makes the call. Published business numbers are also, in practice, the ones answered during working hours.

