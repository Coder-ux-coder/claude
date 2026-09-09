"""Dedupe, the six delivered columns, and everything retained behind them."""
from __future__ import annotations

import csv
from pathlib import Path

import pytest

from conftest import lead, make_config, provider_cfg
from leadenrich.io_csv import (DELIVERY_COLUMNS, audit_row, delivery_row,
                               read_inputs, review_row, write_audit,
                               write_delivery, write_review, write_run_report)
from leadenrich.models import CallOutcome, ContactType, EmailCandidate, Ownership
from leadenrich.normalize import dedupe_key
from leadenrich.pipeline import Pipeline, prepare_run
from leadenrich.providers.base import (IdentityResult, Provider, ProviderResult,
                                       ValidationResult, registry)


# ----------------------------------------------------------------- dedupe ---

def test_linkedin_slug_is_the_strongest_key():
    a = dedupe_key("https://www.linkedin.com/in/dr-anaya-varma-8b41a2/")
    b = dedupe_key("http://linkedin.com/in/dr-anaya-varma-8b41a2?trk=xyz")
    assert a == b == "li:dr-anaya-varma-8b41a2"


def test_name_and_domain_key_when_no_profile_url():
    a = dedupe_key("", "Dr Anaya Varma", "Meridian Skin", "meridianskin.example")
    b = dedupe_key("", "Anaya Varma", "Meridian", "https://www.meridianskin.example/")
    assert a == b, "honorifics and URL noise must not split one person into two"


def test_rows_with_no_identifying_signal_are_not_merged():
    assert dedupe_key("") == ""
    assert dedupe_key("", "", "Some Clinic") == ""


def test_pipeline_marks_duplicates_and_excludes_them_from_delivery(store):
    class _Ident(Provider):
        name = "dedupe_ident"
        stage = "identity"

        def available(self):
            return True

        def can_handle(self, rec, ctx=None):
            return True

        def _call(self, rec, ctx):
            return ProviderResult(outcome=CallOutcome.HIT.value,
                                  identity=IdentityResult(full_name="Dr Anaya Varma",
                                                          title="Founder",
                                                          company="Meridian Skin Clinic",
                                                          confidence="high"))

    registry.register(_Ident)
    cfg = make_config()
    cfg.waterfalls = {"identity": ["dedupe_ident"], "email": [],
                      "validation": [], "phone": []}
    cfg.providers = {"dedupe_ident": provider_cfg("dedupe_ident")}

    url = "https://www.linkedin.com/in/dr-anaya-varma-demo1"
    rid = prepare_run(cfg, store, [lead(linkedin_url=url).inp,
                                   lead(linkedin_url=url + "?trk=copy").inp])
    stats = Pipeline(cfg, store, rid).run()

    assert stats.skipped_duplicates == 1
    rows = store.all_rows(rid)
    dupes = [r for r in rows if r.duplicate_of]
    assert len(dupes) == 1 and dupes[0].needs_review()


# ----------------------------------------------------------------- export ---

def _enriched_record():
    rec = lead(linkedin_url="https://www.linkedin.com/in/dr-anaya-varma-demo1")
    rec.name.set("Dr Anaya Varma", "pdl", source_url="https://linkedin.com/in/x",
                 confidence="high")
    rec.role.set("Founder & Medical Director", "pdl")
    rec.clinic.set("Meridian Skin Clinic", "pdl")
    rec.domain.set("meridianskin.example", "pdl")
    rec.email.set("anaya@meridianskin.example", "hunter",
                  source_url="https://meridianskin.example/team",
                  evidence="deliverability=deliverable; ownership=provider_asserted",
                  raw_status="zerobounce:valid")
    rec.phone.set("+919820012345", "google_places",
                  source_url="https://maps.example/place/meridian",
                  raw_status=ContactType.CLINIC_MAIN_LINE.value,
                  evidence="clinic main line (published)")
    rec.email_candidates.append(EmailCandidate(
        address="anaya@meridianskin.example", provider="hunter",
        ownership=Ownership.PROVIDER_ASSERTED.value, deliverability="deliverable",
        validator="zerobounce", validator_status="valid"))
    return rec


def test_delivery_has_exactly_the_six_requested_columns():
    row = delivery_row(_enriched_record())
    assert list(row.keys()) == DELIVERY_COLUMNS == \
        ["Name", "Role", "Clinic", "Phone", "Email", "Source"]


def test_phone_column_states_what_kind_of_line_it_is():
    row = delivery_row(_enriched_record())
    assert "+919820012345" in row["Phone"]
    assert "clinic main line (published)" in row["Phone"]
    assert "personal" not in row["Phone"].lower()


def test_source_column_names_the_provider_and_the_url():
    src = delivery_row(_enriched_record())["Source"]
    assert "Email: hunter" in src and "meridianskin.example/team" in src
    assert "Phone: google_places" in src and "maps.example" in src


def test_audit_retains_url_provider_timestamp_contact_type_and_status():
    """The brief's explicit retention requirement."""
    a = audit_row(_enriched_record())
    assert a["email_source_url"] == "https://meridianskin.example/team"
    assert a["email_provider"] == "hunter"
    assert a["email_validator"] == "zerobounce"
    assert a["email_validator_status"] == "valid"
    assert a["email_deliverability"] == "deliverable"
    assert a["email_ownership"] == "provider_asserted"
    assert a["email_checked_at"], "a check timestamp must be retained"
    assert a["phone_source_url"] == "https://maps.example/place/meridian"
    assert a["phone_contact_type"] == ContactType.CLINIC_MAIN_LINE.value
    assert a["phone_checked_at"]


def test_audit_columns_are_not_leaked_into_the_delivery_file():
    delivery = set(delivery_row(_enriched_record()).keys())
    audit = set(audit_row(_enriched_record()).keys())
    assert not (delivery & audit), "internal fields must stay out of the client file"


def test_files_are_written_with_the_right_shapes(tmp_path):
    rec = _enriched_record()
    flagged = lead(linkedin_url="https://linkedin.com/in/unresolved")
    flagged.flag_review("identity unresolved: no provider matched this profile URL")

    d = write_delivery(tmp_path / "d.csv", [rec, flagged])
    write_audit(tmp_path / "a.csv", [rec, flagged])
    r = write_review(tmp_path / "r.csv", [rec, flagged])
    assert d == 2 and r == 1

    delivered = list(csv.DictReader((tmp_path / "d.csv").open()))
    assert list(delivered[0].keys()) == DELIVERY_COLUMNS
    reviewed = list(csv.DictReader((tmp_path / "r.csv").open()))
    assert "identity unresolved" in reviewed[0]["why_review"]
    assert reviewed[0]["suggested_action"], "review rows must be actionable"


def test_duplicates_are_omitted_from_the_client_file(tmp_path):
    rec = _enriched_record()
    dup = _enriched_record()
    dup.duplicate_of = "row-1"
    assert write_delivery(tmp_path / "d.csv", [rec, dup]) == 1


def test_run_report_measures_fill_rate(tmp_path):
    rec = _enriched_record()
    empty = lead(linkedin_url="https://linkedin.com/in/none")
    report = write_run_report(tmp_path / "rep.json", run_id="r1", stats={},
                              budget={}, records=[rec, empty])
    assert report["fill_rate_percent"]["Email"] == 50.0
    assert report["fill_rate_percent"]["Name"] == 50.0


# ------------------------------------------------------------------ ingest ---

def test_header_aliases_are_forgiving(tmp_path):
    p = tmp_path / "in.csv"
    p.write_text("LinkedIn URL,Full Name,Clinic Name,Website\n"
                 "https://linkedin.com/in/a,Dr A B,Sunrise Clinic,sunrise.example\n",
                 encoding="utf-8")
    inputs, warnings = read_inputs(p)
    assert len(inputs) == 1
    assert inputs[0].linkedin_url and inputs[0].full_name == "Dr A B"
    assert inputs[0].company == "Sunrise Clinic"
    assert inputs[0].domain == "sunrise.example"


def test_rows_with_content_but_no_identifier_are_reported_not_silently_dropped(tmp_path):
    """A clinic name with no person attached cannot be enriched -- say so."""
    p = tmp_path / "in.csv"
    p.write_text("LinkedIn URL,Name,Clinic\n"
                 "https://linkedin.com/in/a,,Sunrise Clinic\n"
                 ",,Orphan Clinic With No Person\n", encoding="utf-8")
    inputs, warnings = read_inputs(p)
    assert len(inputs) == 1, "only the row with an identifier is usable"
    assert any("row 3" in w and "skipped" in w for w in warnings)


def test_blank_trailing_lines_are_ignored_without_noise(tmp_path):
    """Spreadsheets export trailing empty rows; those are not worth warning about."""
    p = tmp_path / "in.csv"
    p.write_text("LinkedIn URL,Name\nhttps://linkedin.com/in/a,Dr A B\n,\n,\n",
                 encoding="utf-8")
    inputs, warnings = read_inputs(p)
    assert len(inputs) == 1
    assert not any("skipped" in w for w in warnings)


def test_unrecognised_columns_are_flagged(tmp_path):
    p = tmp_path / "in.csv"
    p.write_text("LinkedIn URL,Astrological Sign\nhttps://linkedin.com/in/a,Leo\n",
                 encoding="utf-8")
    _inputs, warnings = read_inputs(p)
    assert any("Astrological Sign" in w for w in warnings)
