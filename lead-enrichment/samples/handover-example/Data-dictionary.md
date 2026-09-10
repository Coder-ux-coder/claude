# Data dictionary

## `Leads.csv` — the deliverable

| Column | Meaning |
|---|---|
| **Name** | The decision-maker's name as published. Blank when the profile could not be resolved to a real person. |
| **Role** | Job title, normalised to the most senior title held (`Founder & Medical Director` → `Founder`). |
| **Clinic** | The organisation, as the organisation writes it. |
| **Phone** | A number the business itself published, followed by a label saying what kind of line it is. See below. |
| **Email** | A work address that passed both gates: deliverable, and attributable to this named person. |
| **Source** | Per field: which provider supplied it and the URL that proves it, in the form `Email: hunter <https://…>`. |

## Phone labels

| Label | What it means |
|---|---|
| `clinic main line (published)` | The clinic's general or reception number, from its own site or Google Business listing. |
| `direct business line (published)` | A number the clinic publishes *next to this person's name* — a direct line, not the switchboard. |
| `business mobile (published)` | A mobile number the business itself lists as a business contact. Published, not harvested. |

One label you will not see in this column:

| Label | Why it is absent |
|---|---|
| `provider-supplied, no public evidence` | A data vendor returned a number but nothing shows the business published it. These are kept in the audit file, labelled honestly, and withheld from the deliverable. There is no setting that relabels one as a verified mobile. |

## `Needs-review.csv`

| Column | Meaning |
|---|---|
| `row_id` | Matches the same row in the audit file. |
| `linkedin_url` | The URL you supplied. |
| `identity_check` | `pass`, `weak`, `conflict` or `unresolved` — how confident we are this is the right person. |
| `why_review` | Every reason this row was flagged, joined by `\|\|`. |
| `notes` | The specific finding, e.g. which address failed which gate. |
| `suggested_action` | What to do about it. |

## `Audit-trail.csv`

One row per input row, 37 columns. The ones that settle an argument:

| Column | Meaning |
|---|---|
| `email_deliverability` | `deliverable`, `risky_catch_all`, `risky_unknown`, `undeliverable`, `do_not_mail`. |
| `email_ownership` | `published_on_company_site`, `provider_asserted`, `pattern_guess`, `unconfirmed`. Independent of the column above. |
| `email_validator` / `email_validator_status` | Who checked, and the verbatim status they returned. |
| `email_checked_at` / `phone_checked_at` | When, in UTC. Deliverability decays; this tells you how old the answer is. |
| `phone_contact_type` | The machine-readable form of the Phone label. |
| `phone_source_url` | The page that proves publication. |
| `phone_evidence` | The surrounding text the classification was made from. |
| `providers_called` | Every provider tried for this row, in order. |
| `duplicate_of` | Set when this row was folded into another. |

## How to check any single value

Take the `row_id` from `Leads.csv`'s neighbouring row in `Audit-trail.csv`, open
the `_source_url` for the field in question, and read it. Every delivered value
is defensible this way, or it would not have been delivered.
