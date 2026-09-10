"""The phone policy -- the compliance control for the whole build.

These tests exist to make two rules impossible to relax by accident:
a number with no public evidence is not exported, and a provider-supplied
number is never relabelled as a verified personal or direct mobile.
"""
from __future__ import annotations

import pytest

from leadenrich.models import (CONTACT_TYPE_LABELS, ContactType,
                               EXPORTABLE_CONTACT_TYPES, PhoneCandidate)
from leadenrich.phone import (classify_contact_type, extract_numbers_from_html,
                              make_candidate, parse_phone, select_exportable)


# ------------------------------------------------------------------ parsing --

@pytest.mark.parametrize("raw,e164,mobile", [
    ("+91 98200 12345", "+919820012345", True),
    ("+91-9820012345", "+919820012345", True),
    ("09820012345", "+919820012345", True),
    ("022-24567890", "+912224567890", False),
    ("+91 141 4567890", "+911414567890", False),
])
def test_indian_formats_normalise_to_e164(raw, e164, mobile):
    p = parse_phone(raw, "IN")
    assert p.valid and p.e164 == e164
    assert p.is_mobile is mobile


@pytest.mark.parametrize("raw", ["", "12345", "not a number", "+91 000"])
def test_invalid_numbers_are_rejected(raw):
    assert not parse_phone(raw, "IN").valid


def test_invalid_number_yields_no_candidate():
    assert make_candidate("12345", provider="x", source_url="https://u") is None


# ----------------------------------------------------------- classification --

def test_business_listing_number_is_a_clinic_line():
    c = make_candidate("022-24567890", provider="google_places",
                       source_url="https://maps.example/x", from_business_listing=True)
    assert c.contact_type == ContactType.CLINIC_MAIN_LINE.value


def test_reception_caption_is_a_clinic_line_not_a_direct_line():
    page = '<a href="tel:+912224567890">Reception</a>'
    raw, ctx = extract_numbers_from_html(page)[0]
    assert classify_contact_type(ctx, person_name="Dr Kavya Nair") == \
        ContactType.CLINIC_MAIN_LINE.value


def test_number_published_against_the_named_person_is_a_direct_line():
    page = ("Aurora Eye Care. Reception: 0484 2345678. "
            "Dr Kavya Nair, Director -- direct line +91 98200 12345.")
    found = dict(extract_numbers_from_html(page))
    types = {raw: classify_contact_type(ctx, person_name="Dr Kavya Nair")
             for raw, ctx in found.items()}
    direct = [k for k, v in types.items() if v == ContactType.PUBLISHED_DIRECT_LINE.value]
    assert len(direct) == 1
    assert "98200" in direct[0], "the doctor's line, not the reception line"


def test_a_distant_doctor_name_does_not_create_a_direct_line():
    """Proximity matters: a name elsewhere on the page is not a caption."""
    page = ("Dr Kavya Nair founded the clinic in 2009 and has practised for "
            "fifteen years across three cities, with a particular interest in "
            "paediatric ophthalmology and community outreach programmes run "
            "throughout Kerala every winter season. Call us on 0484 2345678.")
    raw, ctx = extract_numbers_from_html(page)[0]
    assert classify_contact_type(ctx, person_name="Dr Kavya Nair") == \
        ContactType.CLINIC_MAIN_LINE.value


def test_unlabelled_number_defaults_to_clinic_line():
    """With no caption either way, the conservative label is the honest one."""
    assert classify_contact_type("{{022 24567890}}", person_name="Dr X") == \
        ContactType.CLINIC_MAIN_LINE.value


def test_five_plus_five_indian_mobile_grouping_is_found():
    """+91 99999 10005 is the standard way Indian mobiles are printed."""
    found = extract_numbers_from_html("Direct: +91 99999 10005")
    assert found and "99999" in found[0][0]


# ------------------------------------------------------------- export gate --

def test_provider_supplied_mobile_is_withheld_by_default():
    """The single most important rule in this build."""
    c = PhoneCandidate(number_e164="+919820012345", number_raw="x",
                       contact_type=ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value,
                       provider="pdl")
    chosen, reasons = select_exportable([c])
    assert chosen is None
    assert any("no publication evidence" in r for r in reasons)


def test_provider_supplied_mobile_is_never_relabelled_even_when_opted_in():
    """An operator may opt in under their own legal basis. The label still holds."""
    c = PhoneCandidate(number_e164="+919820012345", number_raw="x",
                       contact_type=ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value,
                       provider="pdl")
    chosen, reasons = select_exportable([c], allow_provider_personal_mobile=True)
    assert chosen is not None
    assert chosen.contact_type == ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value
    assert chosen.contact_type not in EXPORTABLE_CONTACT_TYPES
    assert "NOT a verified personal mobile" in CONTACT_TYPE_LABELS[chosen.contact_type]
    assert any("NOT labelled as a verified personal mobile" in r for r in reasons)


def test_published_number_without_a_source_url_is_withheld():
    c = PhoneCandidate(number_e164="+912224567890", number_raw="x",
                       contact_type=ContactType.CLINIC_MAIN_LINE.value,
                       provider="website", source_url="")
    chosen, reasons = select_exportable([c])
    assert chosen is None
    assert any("no public source URL" in r for r in reasons)


def test_evidence_requirement_can_be_relaxed_deliberately():
    c = PhoneCandidate(number_e164="+912224567890", number_raw="x",
                       contact_type=ContactType.CLINIC_MAIN_LINE.value,
                       provider="website", source_url="")
    chosen, _ = select_exportable([c], require_public_evidence=False)
    assert chosen is not None


def test_direct_line_is_preferred_over_the_switchboard():
    main = PhoneCandidate(number_e164="+912224567890", number_raw="a",
                          contact_type=ContactType.CLINIC_MAIN_LINE.value,
                          provider="places", source_url="https://maps.example")
    direct = PhoneCandidate(number_e164="+919820012345", number_raw="b",
                            contact_type=ContactType.PUBLISHED_DIRECT_LINE.value,
                            provider="website", source_url="https://clinic.example/team")
    chosen, _ = select_exportable([main, direct])
    assert chosen.number_e164 == "+919820012345"


def test_published_candidates_always_beat_provider_supplied_ones():
    provider_num = PhoneCandidate(
        number_e164="+919820011111", number_raw="a",
        contact_type=ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value, provider="pdl")
    published = PhoneCandidate(
        number_e164="+912224567890", number_raw="b",
        contact_type=ContactType.CLINIC_MAIN_LINE.value,
        provider="places", source_url="https://maps.example")
    chosen, _ = select_exportable([provider_num, published],
                                  allow_provider_personal_mobile=True)
    assert chosen.number_e164 == "+912224567890"


def test_every_exportable_type_has_an_honest_label():
    for t in EXPORTABLE_CONTACT_TYPES:
        label = CONTACT_TYPE_LABELS[t]
        assert "published" in label
        assert "personal" not in label.lower()


def test_pipeline_labels_provider_mobiles_and_withholds_them(store):
    """End to end: a PDL-style mobile_phone must not reach the Phone column."""
    from conftest import lead, make_config, provider_cfg
    from leadenrich.models import CallOutcome
    from leadenrich.pipeline import Pipeline, prepare_run
    from leadenrich.providers.base import (IdentityResult, Provider,
                                           ProviderResult, registry)

    class _MobileLeaker(Provider):
        name = "mobile_leaker"
        stage = "identity"

        def available(self):
            return True

        def can_handle(self, rec, ctx=None):
            return True

        def _call(self, rec, ctx):
            return ProviderResult(outcome=CallOutcome.HIT.value, identity=IdentityResult(
                full_name="Dr Kavya Nair", title="Owner", company="Aurora Eye Care",
                domain="auroraeyecare.example", confidence="high",
                phones=[("+91 98200 12345", "mobile_phone")]))

    registry.register(_MobileLeaker)
    cfg = make_config()
    cfg.waterfalls = {"identity": ["mobile_leaker"], "email": [],
                      "validation": [], "phone": []}
    cfg.providers = {"mobile_leaker": provider_cfg("mobile_leaker")}

    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/k").inp])
    Pipeline(cfg, store, rid).run()
    rec = store.all_rows(rid)[0]

    assert rec.phone.value is None, "an unpublished mobile must not be delivered"
    assert rec.phone_candidates, "but it must still be recorded internally"
    assert rec.phone_candidates[0].contact_type == \
        ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value
    assert any("provider-supplied" in n for n in rec.identity_notes)
