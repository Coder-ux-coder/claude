"""Assemble the client-facing handover bundle from a finished run.

``export`` writes the operator's four files. This module turns those into
something that can be *sent*: client-named CSVs, a coverage note whose numbers
are computed from the run rather than typed by hand, and a data dictionary that
explains every column and every phone label.

The coverage note is deliberately arithmetical. It reports what was withheld and
why, alongside what was delivered, because a delivery that only reports its
successes invites the argument it was trying to avoid.
"""
from __future__ import annotations

import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from .models import (
    CONTACT_TYPE_LABELS,
    ContactType,
    Deliverability,
    LeadRecord,
)
from .io_csv import write_audit, write_delivery, write_review

#: Filenames inside the bundle. Client-facing names, not operator ones.
LEADS_CSV = "Leads.csv"
REVIEW_CSV = "Needs-review.csv"
AUDIT_CSV = "Audit-trail.csv"
COVER_MD = "README.md"
DICT_MD = "Data-dictionary.md"

_COLUMNS = (("Name", "name"), ("Role", "role"), ("Clinic", "clinic"),
            ("Phone", "phone"), ("Email", "email"))


@dataclass
class HandoverResult:
    """Where the bundle landed, and the numbers that went into its cover note."""

    directory: Path
    files: list[Path] = field(default_factory=list)
    zip_path: Path | None = None
    stats: dict = field(default_factory=dict)


# --------------------------------------------------------------------------
# Arithmetic
# --------------------------------------------------------------------------

def _email_withheld_reason(rec: LeadRecord) -> str:
    """Why this row's Email cell is blank. Bucketed for the summary table."""
    if not rec.email_candidates:
        return "no address found by any provider"
    if any(c.is_role_account for c in rec.email_candidates):
        return "only a shared mailbox was found (info@, contact@ ...)"
    dels = {c.deliverability for c in rec.email_candidates}
    if Deliverability.RISKY_CATCH_ALL.value in dels:
        return "catch-all domain -- the server accepts every address, so it proves nothing"
    if Deliverability.RISKY_UNKNOWN.value in dels:
        return "validator could not reach the mail server -- unproven"
    if Deliverability.DO_NOT_MAIL.value in dels:
        return "flagged do-not-mail (spam trap, disposable or abuse address)"
    if Deliverability.UNDELIVERABLE.value in dels:
        return "address does not exist"
    return "found, but failed the quality gate"


def _phone_withheld_reason(rec: LeadRecord) -> str:
    """Why this row's Phone cell is blank."""
    if not rec.phone_candidates:
        return "no published business number found"
    if any(c.contact_type == ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value
           for c in rec.phone_candidates):
        return ("a provider supplied a number with no public evidence -- withheld "
                "by policy, retained in the audit file")
    return "a number was found but carried no source URL to prove publication"


#: Demo fixtures name themselves so their output can never be mistaken for real.
DEMO_PROVIDER_PREFIX = "demo:"


def contains_demo_data(records: list[LeadRecord]) -> bool:
    """True if any delivered value came from a fixture rather than a provider.

    Read from the records, not from configuration. A config flag describes the
    process that is running now; this describes the data in front of you, and
    survives a re-export under different settings. Getting it wrong ships
    invented clinics to a paying client with nothing on the cover to say so.
    """
    for rec in records:
        for fv in rec.fields().values():
            if fv.provenance.provider.startswith(DEMO_PROVIDER_PREFIX):
                return True
        for call in rec.calls:
            if call.provider.startswith(DEMO_PROVIDER_PREFIX):
                return True
    return False


def compute_stats(records: list[LeadRecord]) -> dict:
    """Everything the cover note asserts, derived from the records themselves."""
    duplicates = [r for r in records if r.duplicate_of]
    live = [r for r in records if not r.duplicate_of]
    total = len(live) or 1

    fill: dict[str, dict] = {}
    for label, attr in _COLUMNS:
        n = sum(1 for r in live if getattr(r, attr).is_present())
        fill[label] = {"filled": n, "percent": round(100.0 * n / total, 1)}

    phone_types: dict[str, int] = {}
    for r in live:
        if not r.phone.is_present():
            continue
        key = r.phone.provenance.raw_status or ContactType.UNKNOWN.value
        phone_types[key] = phone_types.get(key, 0) + 1

    email_blanks: dict[str, int] = {}
    for r in live:
        if r.email.is_present():
            continue
        reason = _email_withheld_reason(r)
        email_blanks[reason] = email_blanks.get(reason, 0) + 1

    phone_blanks: dict[str, int] = {}
    for r in live:
        if r.phone.is_present():
            continue
        reason = _phone_withheld_reason(r)
        phone_blanks[reason] = phone_blanks.get(reason, 0) + 1

    return {
        "rows_supplied": len(records),
        "duplicates_removed": len(duplicates),
        "rows_delivered": len(live),
        "rows_needing_review": sum(1 for r in records if r.needs_review()),
        "fill": fill,
        "phone_contact_types": phone_types,
        "email_blank_reasons": email_blanks,
        "phone_blank_reasons": phone_blanks,
    }


# --------------------------------------------------------------------------
# Documents
# --------------------------------------------------------------------------

def _table(rows: list[tuple[str, str]], headers: tuple[str, str]) -> str:
    out = [f"| {headers[0]} | {headers[1]} |", "|---|---|"]
    out += [f"| {a} | {b} |" for a, b in rows]
    return "\n".join(out)


def _sorted_counts(d: dict[str, int]) -> list[tuple[str, str]]:
    return [(k, str(v)) for k, v in sorted(d.items(), key=lambda kv: -kv[1])]


def cover_note(stats: dict, *, run_id: str, client: str = "", operator: str = "",
               demo: bool = False, delivered_on: str = "") -> str:
    """The note that sits on top of the data. Numbers come from ``stats``."""
    date = delivered_on or time.strftime("%d %B %Y")
    who = f" for **{client}**" if client else ""
    sign = f"\n\nPrepared by {operator}." if operator else ""

    banner = ""
    if demo:
        banner = (
            "> **⚠ SAMPLE BUNDLE — FICTIONAL DATA.** This was produced from the\n"
            "> built-in demo fixtures. Every name, clinic, number and address below\n"
            "> is invented, and every `.example` domain is reserved by RFC 2606 and\n"
            "> cannot resolve. It shows the delivery *format*, nothing more.\n\n")

    d = stats["fill"]
    delivered = stats["rows_delivered"]
    fill_rows = [(label, f"{d[label]['filled']} of {delivered}  ({d[label]['percent']}%)")
                 for label, _ in _COLUMNS]

    phone_rows = [(CONTACT_TYPE_LABELS.get(k, k), str(v))
                  for k, v in sorted(stats["phone_contact_types"].items(),
                                     key=lambda kv: -kv[1])]

    parts = [
        f"# Lead delivery{who}",
        "",
        banner + f"**Run reference:** `{run_id}`  \n**Delivered:** {date}",
        "",
        "## What is in this folder",
        "",
        _table([
            (f"`{LEADS_CSV}`", "The deliverable. Six columns: Name, Role, Clinic, "
                               "Phone, Email, Source."),
            (f"`{REVIEW_CSV}`", "Rows a human should look at, each with the reason "
                                "and a suggested action."),
            (f"`{AUDIT_CSV}`", "Every field with its provider, source URL and check "
                               "timestamp. Your evidence file."),
            (f"`{DICT_MD}`", "What every column and every phone label means."),
        ], ("File", "What it is")),
        "",
        "## Coverage",
        "",
        _table([
            ("Rows supplied", str(stats["rows_supplied"])),
            ("Duplicates removed", str(stats["duplicates_removed"])),
            ("Rows delivered", str(delivered)),
            ("Rows flagged for review", str(stats["rows_needing_review"])),
        ], ("", "Count")),
        "",
        "### Fill rate by column",
        "",
        _table(fill_rows, ("Column", "Filled")),
        "",
    ]

    if phone_rows:
        parts += [
            "### What kind of number each Phone cell holds",
            "",
            _table(phone_rows, ("Type of line", "Rows")),
            "",
            "Every one of these was published by the business itself, and the URL "
            "that proves it is in the audit file against that row.",
            "",
        ]

    if stats["email_blank_reasons"]:
        parts += [
            "## Why some cells are blank",
            "",
            "A blank cell here is a decision, not a gap in effort. Each one below "
            "was found and then refused, or genuinely not found — and you can see "
            "which in the audit file.",
            "",
            "**Email**",
            "",
            _table(_sorted_counts(stats["email_blank_reasons"]), ("Reason", "Rows")),
            "",
        ]

    if stats["phone_blank_reasons"]:
        parts += [
            "**Phone**",
            "",
            _table(_sorted_counts(stats["phone_blank_reasons"]), ("Reason", "Rows")),
            "",
        ]

    parts += [
        "## The two rules this delivery was built on",
        "",
        "**1 · Deliverability is not ownership.** A validator answers one question: "
        "will mail sent here arrive? It cannot tell you whose mailbox it is. So an "
        "address on a catch-all domain — where the server accepts everything — is "
        "never counted as confirmed, and a shared `info@` box is never presented as "
        "a named person's address.",
        "",
        "**2 · Every phone number was published by the business.** Each is labelled "
        "as the clinic's main line, a direct line published for that individual, or "
        "a business mobile the clinic itself lists. Numbers supplied by a data "
        "vendor without public evidence are retained in the audit file, labelled as "
        "such, and withheld from the deliverable. Nothing in this bundle is "
        "presented as a verified personal mobile, because nothing in it is one.",
        "",
        "Under India's Digital Personal Data Protection Act 2023 and TRAI's TCCCPR "
        "rules, the liability for calling a harvested personal-mobile list sits with "
        "whoever makes the call. Published business numbers are also, in practice, "
        "the ones answered during working hours." + sign,
        "",
    ]
    return "\n".join(parts) + "\n"


DATA_DICTIONARY = """# Data dictionary

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
| `why_review` | Every reason this row was flagged, joined by `\\|\\|`. |
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
"""


# --------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------

def build_handover(records: list[LeadRecord], *, run_id: str,
                   outdir: str | Path, client: str = "", operator: str = "",
                   demo: bool = False, label_contact_type: bool = True,
                   make_zip: bool = True, delivered_on: str = "") -> HandoverResult:
    """Write the client bundle and, by default, zip it."""
    directory = Path(outdir) / f"{run_id}_handover"
    directory.mkdir(parents=True, exist_ok=True)

    stats = compute_stats(records)
    # The caller's flag can only add the banner, never remove it.
    demo = bool(demo) or contains_demo_data(records)

    write_delivery(directory / LEADS_CSV, records,
                   label_contact_type=label_contact_type)
    write_review(directory / REVIEW_CSV, records)
    write_audit(directory / AUDIT_CSV, records)
    (directory / COVER_MD).write_text(
        cover_note(stats, run_id=run_id, client=client, operator=operator,
                   demo=demo, delivered_on=delivered_on), encoding="utf-8")
    (directory / DICT_MD).write_text(DATA_DICTIONARY, encoding="utf-8")

    files = [directory / n for n in (LEADS_CSV, REVIEW_CSV, AUDIT_CSV,
                                     COVER_MD, DICT_MD)]

    zip_path = None
    if make_zip:
        zip_path = Path(outdir) / f"{run_id}_handover.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in files:
                z.write(f, arcname=f"{directory.name}/{f.name}")

    return HandoverResult(directory=directory, files=files,
                          zip_path=zip_path, stats=stats)
