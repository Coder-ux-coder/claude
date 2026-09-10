"""CSV ingest and the three output files.

The client receives six columns. Everything needed to *defend* those six columns
is retained alongside them in an audit file, and everything that failed a gate
goes to a review file. Nothing is silently dropped and nothing is silently
upgraded.
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Iterable

from .models import (CONTACT_TYPE_LABELS, FieldStatus, LeadInput, LeadRecord)

#: Accepted input header spellings -> our canonical field.
INPUT_ALIASES: dict[str, str] = {
    "linkedin": "linkedin_url", "linkedin_url": "linkedin_url",
    "linkedin profile": "linkedin_url", "profile": "linkedin_url",
    "profile_url": "linkedin_url", "url": "linkedin_url",
    "linkedin profile url": "linkedin_url", "li_url": "linkedin_url",

    "name": "full_name", "full_name": "full_name", "full name": "full_name",
    "contact name": "full_name", "person": "full_name",
    "first_name": "first_name", "first name": "first_name", "first": "first_name",
    "last_name": "last_name", "last name": "last_name", "last": "last_name",
    "surname": "last_name",

    "company": "company", "clinic": "company", "organisation": "company",
    "organization": "company", "company_name": "company", "clinic name": "company",
    "hospital": "company", "practice": "company",

    "domain": "domain", "website": "domain", "company_domain": "domain",
    "web": "domain", "site": "domain",

    "location": "location", "city": "location", "region": "location",
    "state": "location", "notes": "notes", "note": "notes",
    "row_id": "row_id", "id": "row_id",
}

#: The delivered columns, exactly as the client asked for them.
DELIVERY_COLUMNS = ["Name", "Role", "Clinic", "Phone", "Email", "Source"]


def _canonical_column(col: str) -> str:
    """Match a header regardless of spacing, punctuation or case.

    ``LinkedIn URL``, ``linkedin_url``, ``LINKEDIN-URL`` and ``linkedinurl`` all
    resolve to the same field, so a client's spreadsheet imports untouched.
    """
    raw = (col or "").strip().lower()
    if not raw:
        return ""
    spaced = re.sub(r"[\s_\-]+", " ", raw).strip()
    for key in (raw, spaced, spaced.replace(" ", "_"), spaced.replace(" ", "")):
        if key in INPUT_ALIASES:
            return INPUT_ALIASES[key]
    return ""


def read_inputs(path: str | Path) -> tuple[list[LeadInput], list[str]]:
    """Read a CSV of leads. Returns ``(inputs, warnings)``.

    Header matching is forgiving: ``LinkedIn URL``, ``linkedin_url`` and
    ``Profile`` all mean the same thing, so a client's spreadsheet usually
    imports untouched.
    """
    p = Path(path)
    warnings: list[str] = []
    inputs: list[LeadInput] = []

    with p.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            return [], ["input file has no header row"]

        mapping: dict[str, str] = {}
        for col in reader.fieldnames:
            canon = _canonical_column(col)
            if canon:
                mapping[col] = canon
        if "linkedin_url" not in mapping.values():
            warnings.append(
                "no LinkedIn URL column recognised -- rows will rely on "
                "name/company/domain instead")

        unmapped = [c for c in reader.fieldnames if c not in mapping]
        if unmapped:
            warnings.append(f"ignored unrecognised column(s): {', '.join(unmapped)}")

        for n, row in enumerate(reader, start=2):
            kwargs = {}
            for col, canon in mapping.items():
                val = (row.get(col) or "").strip()
                if val:
                    kwargs[canon] = val
            if not kwargs:
                continue
            if not (kwargs.get("linkedin_url") or kwargs.get("full_name")
                    or (kwargs.get("first_name") and kwargs.get("last_name"))):
                warnings.append(f"row {n}: no LinkedIn URL and no name -- skipped")
                continue
            inputs.append(LeadInput(**kwargs))

    return inputs, warnings


# --------------------------------------------------------------------- rows

def delivery_row(rec: LeadRecord, *, label_contact_type: bool = True) -> dict[str, str]:
    """Build the six delivered columns for one record."""
    phone = rec.phone.value or ""
    if phone and label_contact_type and rec.phone.provenance.raw_status:
        label = CONTACT_TYPE_LABELS.get(rec.phone.provenance.raw_status, "")
        if label:
            phone = f"{phone} ({label})"

    sources: list[str] = []
    for field_label, fv in (("Name", rec.name), ("Role", rec.role),
                            ("Clinic", rec.clinic), ("Phone", rec.phone),
                            ("Email", rec.email)):
        if fv.is_present() and fv.provenance.provider:
            url = fv.provenance.source_url
            sources.append(f"{field_label}: {fv.provenance.provider}"
                           + (f" <{url}>" if url else ""))

    return {
        "Name": rec.name.value or "",
        "Role": rec.role.value or "",
        "Clinic": rec.clinic.value or "",
        "Phone": phone,
        "Email": rec.email.value or "",
        "Source": " | ".join(sources),
    }


def audit_row(rec: LeadRecord) -> dict[str, str]:
    """Everything retained internally to defend a delivered row."""
    best = rec.best_email()
    chosen_phone = next((p for p in rec.phone_candidates
                         if p.number_e164 == (rec.phone.value or "")), None)
    return {
        "row_id": rec.inp.row_id,
        "input_linkedin_url": rec.inp.linkedin_url,
        "name": rec.name.value or "",
        "name_status": rec.name.status,
        "name_provider": rec.name.provenance.provider,
        "name_confidence": rec.name.provenance.confidence,
        "role": rec.role.value or "",
        "role_provider": rec.role.provenance.provider,
        "clinic": rec.clinic.value or "",
        "clinic_provider": rec.clinic.provenance.provider,
        "domain": rec.domain.value or "",
        "email": rec.email.value or "",
        "email_status": rec.email.status,
        "email_provider": rec.email.provenance.provider,
        "email_source_url": rec.email.provenance.source_url,
        "email_deliverability": (best.deliverability if best else ""),
        "email_ownership": (best.ownership if best else ""),
        "email_validator": (best.validator if best else ""),
        "email_validator_status": (best.validator_status if best else ""),
        "email_validator_sub_status": (best.validator_sub_status if best else ""),
        "email_checked_at": _ts(rec.email.provenance.checked_at),
        "email_candidates_considered": len(rec.email_candidates),
        "phone": rec.phone.value or "",
        "phone_status": rec.phone.status,
        "phone_contact_type": rec.phone.provenance.raw_status,
        "phone_contact_type_label": CONTACT_TYPE_LABELS.get(
            rec.phone.provenance.raw_status, ""),
        "phone_provider": rec.phone.provenance.provider,
        "phone_source_url": rec.phone.provenance.source_url,
        "phone_evidence": (chosen_phone.evidence if chosen_phone
                           else rec.phone.provenance.evidence),
        "phone_checked_at": _ts(rec.phone.provenance.checked_at),
        "phone_candidates_considered": len(rec.phone_candidates),
        "identity_check": rec.identity_check,
        "identity_notes": " || ".join(rec.identity_notes),
        "review_reasons": " || ".join(rec.review_reasons),
        "duplicate_of": rec.duplicate_of,
        "providers_called": ";".join(
            f"{c.provider}:{c.outcome}" for c in rec.calls),
        "estimated_credits": round(sum(c.estimated_credits for c in rec.calls), 3),
    }


def review_row(rec: LeadRecord) -> dict[str, str]:
    """One line per row that a human needs to look at, and why."""
    return {
        "row_id": rec.inp.row_id,
        "linkedin_url": rec.inp.linkedin_url,
        "name": rec.name.value or "",
        "clinic": rec.clinic.value or "",
        "email": rec.email.value or "",
        "phone": rec.phone.value or "",
        "identity_check": rec.identity_check,
        "why_review": " || ".join(rec.review_reasons),
        "notes": " || ".join(rec.identity_notes),
        "suggested_action": _suggest(rec),
    }


def _suggest(rec: LeadRecord) -> str:
    """A concrete next step, so the review queue is actionable, not just a list."""
    if rec.duplicate_of:
        return "Confirm this is the same person, then delete one row."
    if not rec.name.is_present():
        return ("Add the person's name and clinic (or company domain) to the "
                "input row and re-run -- a bare profile URL did not resolve.")
    if not rec.clinic.is_present():
        return "Add the clinic name or website to the input row and re-run."
    if rec.email.status == FieldStatus.REJECTED.value:
        return ("Email found but failed the gate (catch-all, unknown, or a role "
                "mailbox). Verify manually or leave the cell blank.")
    if not rec.email.is_present():
        return "No email from any provider. Check the clinic website manually."
    if not rec.phone.is_present():
        return ("No published business number found. Check the clinic's Google "
                "listing or website by hand.")
    return "Spot-check the values against the source URLs in the audit file."


def _ts(epoch: float) -> str:
    import datetime as _dt
    if not epoch:
        return ""
    return _dt.datetime.fromtimestamp(epoch).isoformat(timespec="seconds")


# ------------------------------------------------------------------ writers

def _write(path: Path, columns: list[str], rows: Iterable[dict]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)
            n += 1
    return n


def write_delivery(path: str | Path, records: list[LeadRecord],
                   *, label_contact_type: bool = True,
                   include_empty: bool = True) -> int:
    rows = [delivery_row(r, label_contact_type=label_contact_type)
            for r in records if not r.duplicate_of]
    if not include_empty:
        rows = [r for r in rows if r["Email"] or r["Phone"]]
    return _write(Path(path), DELIVERY_COLUMNS, rows)


def write_audit(path: str | Path, records: list[LeadRecord]) -> int:
    rows = [audit_row(r) for r in records]
    cols = list(rows[0].keys()) if rows else list(audit_row(
        LeadRecord(inp=LeadInput())).keys())
    return _write(Path(path), cols, rows)


def write_review(path: str | Path, records: list[LeadRecord]) -> int:
    rows = [review_row(r) for r in records if r.needs_review()]
    cols = list(review_row(LeadRecord(inp=LeadInput())).keys())
    return _write(Path(path), cols, rows)


def write_run_report(path: str | Path, *, run_id: str, stats: dict,
                     budget: dict, records: list[LeadRecord],
                     warnings: list[str] | None = None) -> dict:
    """A machine-readable summary: fill rates, provider outcomes, spend."""
    total = len([r for r in records if not r.duplicate_of]) or 1
    fill = {
        col: round(100.0 * sum(
            1 for r in records if not r.duplicate_of
            and getattr(r, attr).is_present()) / total, 1)
        for col, attr in (("Name", "name"), ("Role", "role"), ("Clinic", "clinic"),
                          ("Phone", "phone"), ("Email", "email"))
    }
    outcomes: dict[str, dict[str, int]] = {}
    for r in records:
        for c in r.calls:
            outcomes.setdefault(c.provider, {})
            outcomes[c.provider][c.outcome] = outcomes[c.provider].get(c.outcome, 0) + 1

    report = {
        "run_id": run_id,
        "stats": stats,
        "fill_rate_percent": fill,
        "provider_outcomes": outcomes,
        "budget": budget,
        "input_warnings": warnings or [],
        "review_queue_size": sum(1 for r in records if r.needs_review()),
    }
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report
