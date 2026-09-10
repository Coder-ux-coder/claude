# The Google Sheet

One spreadsheet, three tabs. **Leads** is the working sheet — input queue and
audit trail in one. **Delivery** and **Review** are formulas over it, not
separate data, so they update the instant a row finishes and cost no Make
operations.

## 1 · Create the spreadsheet

Make a new Google Sheet. Rename the first tab to exactly `Leads` (capital L —
the blueprints look for that name), then **File → Import → Upload →
`sheet/Leads.csv`**, choosing *Replace current sheet*.

That gives you the 32 column headers plus three fictional example rows you can
run immediately, before loading real data.

> The blueprints read the sheet with *"table contains headers"* switched **off**
> and address columns by position, not by header text. That is deliberate:
> renaming a header cannot silently break every mapping. It does mean **column
> order is fixed** — insert a column in the middle and the mappings shift. Add
> new columns at the end only.

The header row is never processed: its status cell reads `status`, which no
filter matches.

## 2 · Add the Delivery tab

New tab named `Delivery`. Paste this into **A1** and nothing else — it fills the
whole tab by itself:

```
={"Name","Role","Clinic","Phone","Email","Source"; IFERROR(QUERY(Leads!A2:AF, "select H, I, J, AB, AC, AD where AE = 'yes'", 0), {"","","","","",""})}
```

This is the tab you share with the client. It shows only rows that passed the
quality gates, with the phone labelled by what kind of line it is.

## 3 · Add the Review tab

New tab named `Review`. Paste into **A1**:

```
={"Row ID","Name","Clinic","Why","What to do","LinkedIn URL"; IFERROR(QUERY(Leads!A2:AF, "select A, H, J, Z, AF, B where AE = 'no'", 0), {"","","","","",""})}
```

This is your worklist — every row that needs a human, with the reason and a
suggested next step. Work this before you deliver.

## 4 · Copy the spreadsheet ID

From the URL:

```
https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit#gid=0
```

You paste it into both scenarios during setup.

---

## Column map

`status` (column G) is what drives the pipeline. Scenario 1 picks up `pending`
rows and leaves them `email_done`; scenario 2 picks those up and leaves them
`complete`. To re-run a row, set its status back.

| Col | Field | Written by | Notes |
|---|---|---|---|
| A | row_id | you | Any stable id. |
| B | linkedin_url | you | The only genuinely required input. |
| C | input_name | you | Optional, but the single biggest lift on match rate. |
| D | input_clinic | you | Optional. Enables the phone lookup. |
| E | input_domain | you | Optional. The biggest lift on email discovery. |
| F | input_location | you | Optional. Disambiguates common clinic names. |
| G | **status** | both | `pending` → `email_done` → `complete`. |
| H–L | name, role, clinic, domain, identity_provider | scenario 1 | Client-supplied values win over the provider. |
| M–O | email, email_provider, email_source | scenario 1 | Which provider found it, and the public URL if there was one. |
| P–S | validator, status, sub_status, decision | scenario 2 | The full validator verdict, kept verbatim. |
| T–W | phone, type, source_url, decision | scenario 2 | A number never ships without its source URL. |
| X–Y | place_id, website | scenario 2 | For tracing a phone back to its listing. |
| Z | review_reason | scenario 2 | Machine-readable summary of both gates. |
| AA | checked_at | both | When this row was last touched. |
| AB–AD | delivery_phone, delivery_email, delivery_source | scenario 2 | Exactly what the client sees. Blank means refused. |
| AE | **deliverable** | scenario 2 | `yes` / `no` — what the two tabs filter on. |
| AF | review_action | scenario 2 | The suggested fix, in plain language. |

## Loading your real 2,000 rows

Paste them into columns A–F beneath the examples, set column G to `pending` for
every row, and delete the three example rows. Then run a **100-row pilot first**
— the `limit` field in each scenario's first module controls how many rows a run
picks up.
