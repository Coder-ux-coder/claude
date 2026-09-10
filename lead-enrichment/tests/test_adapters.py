"""Real provider adapters, driven through their documented response shapes.

These do not prove the vendors behave as documented -- only a live call does
that, which is what ``leadenrich smoke`` is for. What they do prove is that
*given* the documented shape, the adapter builds the right request and reads the
right fields, and that an empty-but-successful answer becomes a clean no-match
rather than an exception.
"""
from __future__ import annotations

import pytest

from conftest import FakeResponse, lead, provider_cfg
from leadenrich.models import CallOutcome, ContactType, Deliverability, Ownership
from leadenrich.providers import registry
from leadenrich.validation import map_status


def build(name, client, **cfg_kw):
    return registry.build(name, provider_cfg(name, **cfg_kw), client)


# ---------------------------------------------------------------- identity ---

def test_apollo_sends_linkedin_url_and_reads_person(session, client):
    session.route("people/match", FakeResponse(200, {"person": {
        "name": "Dr Anaya Varma", "first_name": "Anaya", "last_name": "Varma",
        "title": "Founder & Medical Director", "email": "anaya@meridianskin.example",
        "email_status": "verified", "linkedin_url": "https://linkedin.com/in/anaya",
        "city": "Bengaluru", "country": "India",
        "organization": {"name": "Meridian Skin Clinic",
                         "website_url": "https://meridianskin.example",
                         "phone": "+91 80 4123 4567"},
        "phone_numbers": [{"sanitized_number": "+919820012345", "type": "mobile"}],
    }}))
    p = build("apollo", client, api_key_env="X")
    rec = lead(linkedin_url="https://www.linkedin.com/in/anaya-varma-1a2b")
    result, call = p.execute(rec, {})

    assert result.outcome == CallOutcome.HIT.value
    sent = session.calls[0]
    assert sent["json"]["linkedin_url"] == "https://www.linkedin.com/in/anaya-varma-1a2b"
    assert sent["headers"]["x-api-key"] == ""    # env unset in tests
    assert result.identity.company == "Meridian Skin Clinic"
    assert result.identity.domain == "meridianskin.example"
    assert result.identity.title == "Founder & Medical Director"
    assert ("anaya@meridianskin.example", "verified") in result.identity.emails
    kinds = dict(result.identity.phones)
    assert kinds["+919820012345"] == "mobile"
    assert kinds["+91 80 4123 4567"] == "organization_phone"


def test_apollo_withholds_reveal_flags_unless_configured(session, client):
    session.route("people/match", FakeResponse(200, {"person": {"name": "X"}}))
    build("apollo", client, api_key_env="X").execute(
        lead(linkedin_url="https://linkedin.com/in/x"), {})
    body = session.calls[0]["json"]
    assert "reveal_personal_emails" not in body
    assert "reveal_phone_number" not in body


def test_apollo_masked_email_sentinel_is_not_treated_as_an_address(session, client):
    session.route("people/match", FakeResponse(200, {"person": {
        "name": "X", "email": "email_not_unlocked@domain.com"}}))
    result, _ = build("apollo", client, api_key_env="X").execute(
        lead(linkedin_url="https://linkedin.com/in/x"), {})
    assert result.identity.emails == []


def test_apollo_empty_person_is_a_clean_no_match(session, client):
    session.route("people/match", FakeResponse(200, {"person": None}))
    result, call = build("apollo", client, api_key_env="X").execute(
        lead(linkedin_url="https://linkedin.com/in/x"), {})
    assert result.outcome == CallOutcome.NO_MATCH.value
    assert call.estimated_credits == 1.0, "a no-match still consumes the lookup"


def test_pdl_uses_profile_param_and_min_likelihood(session, client):
    session.route("person/enrich", FakeResponse(200, {"data": {
        "full_name": "Dr Kavya Nair", "first_name": "Kavya", "last_name": "Nair",
        "likelihood": 9, "linkedin_url": "https://linkedin.com/in/kavya",
        "location_name": "Kochi, Kerala, India",
        "work_email": "kavya@auroraeyecare.example",
        "mobile_phone": "+919820011111",
        "experience": [{"is_primary": True, "title": {"name": "Clinic Owner"},
                        "company": {"name": "Aurora Eye Care",
                                    "website": "auroraeyecare.example"}}],
    }}))
    p = build("pdl", client, api_key_env="X", options={"min_likelihood": 8})
    result, _ = p.execute(lead(linkedin_url="https://linkedin.com/in/kavya-nair"), {})

    params = session.calls[0]["params"]
    assert params["profile"] == "https://www.linkedin.com/in/kavya-nair"
    assert params["min_likelihood"] == 8
    assert result.identity.title == "Clinic Owner"
    assert result.identity.company == "Aurora Eye Care"
    assert result.identity.confidence == "high"
    assert ("+919820011111", "mobile_phone") in result.identity.phones


def test_pdl_404_means_no_match_at_that_likelihood(session, client):
    session.route("person/enrich", FakeResponse(404, {"error": "no match"}))
    result, _ = build("pdl", client, api_key_env="X").execute(
        lead(linkedin_url="https://linkedin.com/in/nobody"), {})
    assert result.outcome == CallOutcome.NO_MATCH.value
    assert "likelihood" in result.detail


def test_pdl_refuses_rows_below_its_documented_minimum_input():
    p = build("pdl", None, api_key_env="X")
    assert not p.can_handle(lead(full_name="Anjali Mehta"), {})
    assert p.can_handle(lead(full_name="Anjali Mehta", company="Sunrise Clinic"), {})
    assert p.can_handle(lead(linkedin_url="https://linkedin.com/in/x"), {})


def test_slug_parser_needs_no_key_and_yields_low_confidence():
    p = build("linkedin_slug", None)
    assert p.available()
    result, _ = p.execute(lead(linkedin_url="https://linkedin.com/in/dr-anjali-mehta-8b41a2"), {})
    assert result.identity.full_name == "Anjali Mehta"
    assert result.identity.confidence == "low"


def test_enrichlayer_is_registered_but_gated_off_in_shipped_config():
    from leadenrich.config import load_config
    cfg = load_config()
    assert cfg.provider("enrichlayer").enabled is False
    assert "enrichlayer" not in cfg.enabled_in("identity")


# ------------------------------------------------------------------- email ---

def test_prospeo_posts_the_linkedin_url_with_x_key_header(session, client):
    session.route("linkedin-email-finder", FakeResponse(200, {
        "error": False, "response": {"email": "anaya@meridianskin.example",
                                     "email_status": "VALID"}}))
    result, _ = build("prospeo", client, api_key_env="X").execute(
        lead(linkedin_url="https://linkedin.com/in/anaya"), {})
    assert "X-KEY" in session.calls[0]["headers"]
    assert result.emails[0].address == "anaya@meridianskin.example"
    assert result.emails[0].ownership == Ownership.PROVIDER_ASSERTED.value
    assert result.emails[0].deliverability == Deliverability.NOT_CHECKED.value, \
        "a finder must never set deliverability itself"


def test_prospeo_error_flag_is_a_no_match(session, client):
    session.route("linkedin-email-finder",
                  FakeResponse(200, {"error": True, "message": "not found"}))
    result, _ = build("prospeo", client, api_key_env="X").execute(
        lead(linkedin_url="https://linkedin.com/in/x"), {})
    assert result.outcome == CallOutcome.NO_MATCH.value


def test_findymail_reads_the_contact_object(session, client):
    session.route("search/name", FakeResponse(200, {
        "contact": {"email": "rohan@blueharbour.example", "name": "Rohan Desai"}}))
    result, _ = build("findymail", client, api_key_env="X").execute(
        lead(full_name="Rohan Desai", domain="blueharbour.example"),
        {"full_name": "Rohan Desai", "domain": "blueharbour.example"})
    assert session.calls[0]["json"]["domain"] == "blueharbour.example"
    assert result.emails[0].address == "rohan@blueharbour.example"


def test_hunter_keeps_public_sources_and_upgrades_ownership(session, client):
    """Hunter's source URLs are the evidence the Source column needs."""
    session.route("email-finder", FakeResponse(200, {"data": {
        "email": "kavya@auroraeyecare.example", "score": 94,
        "verification": {"status": "valid"},
        "sources": [{"uri": "https://auroraeyecare.example/team"},
                    {"uri": "https://directory.example/kavya"}]}}))
    result, _ = build("hunter", client, api_key_env="X").execute(
        lead(full_name="Kavya Nair", domain="auroraeyecare.example"),
        {"full_name": "Kavya Nair", "domain": "auroraeyecare.example"})
    cand = result.emails[0]
    assert cand.score == 94
    assert cand.ownership == Ownership.PUBLISHED_ON_COMPANY_SITE.value
    assert "https://auroraeyecare.example/team" in cand.source_urls


def test_hunter_without_sources_stays_merely_provider_asserted(session, client):
    session.route("email-finder", FakeResponse(200, {"data": {
        "email": "x@clinic.example", "score": 60, "sources": []}}))
    result, _ = build("hunter", client, api_key_env="X").execute(
        lead(full_name="A B", domain="clinic.example"),
        {"full_name": "A B", "domain": "clinic.example"})
    assert result.emails[0].ownership == Ownership.PROVIDER_ASSERTED.value


def test_hunter_falls_back_to_the_linkedin_handle(session, client):
    session.route("email-finder", FakeResponse(200, {"data": {"email": "a@b.example"}}))
    build("hunter", client, api_key_env="X").execute(
        lead(linkedin_url="https://linkedin.com/in/dr-anaya-varma-demo1"), {})
    assert session.calls[0]["params"]["linkedin_handle"] == "dr-anaya-varma-demo1"


def test_anymailfinder_404_is_not_found_not_an_error(session, client):
    session.route("find-email/person", FakeResponse(404, {"error": "not found"}))
    result, _ = build("anymailfinder", client, api_key_env="X").execute(
        lead(full_name="A B", domain="clinic.example"),
        {"full_name": "A B", "domain": "clinic.example"})
    assert result.outcome == CallOutcome.NO_MATCH.value


def test_dropcontact_polls_its_async_batch(session, client):
    session.route("batch", FakeResponse(200, {"request_id": "req-1"}))
    session.route("batch/req-1", FakeResponse(200, {"success": False}),
                  FakeResponse(200, {"success": True, "data": [
                      {"email": [{"email": "meera@lotus.example",
                                  "qualification": "nominative@pro"}]}]}))
    p = build("dropcontact", client, api_key_env="X",
              options={"max_polls": 3, "poll_interval": 0})
    result, _ = p.execute(lead(full_name="Meera Joshi", domain="lotus.example"),
                          {"full_name": "Meera Joshi", "domain": "lotus.example"})
    assert result.emails[0].address == "meera@lotus.example"
    assert session.count_for("batch/req-1") == 2, "should have polled twice"


def test_dropcontact_gives_up_transiently_rather_than_claiming_no_match(session, client):
    session.route("batch", FakeResponse(200, {"request_id": "req-2"}))
    session.route("batch/req-2", *[FakeResponse(200, {"success": False})
                                   for _ in range(5)])
    p = build("dropcontact", client, api_key_env="X",
              options={"max_polls": 2, "poll_interval": 0})
    result, _ = p.execute(lead(full_name="A B", domain="x.example"),
                          {"full_name": "A B", "domain": "x.example"})
    assert result.outcome == CallOutcome.TRANSIENT_ERROR.value


def test_snov_exchanges_credentials_then_caches_the_token(session, client, monkeypatch):
    monkeypatch.setenv("SNOV_ID", "id"); monkeypatch.setenv("SNOV_SECRET", "secret")
    session.route("oauth/access_token",
                  FakeResponse(200, {"access_token": "tok", "expires_in": 3600}))
    session.route("get-emails-from-names", FakeResponse(200, {
        "data": {"emails": [{"email": "a@b.example", "emailStatus": "valid"}]}}),
                  FakeResponse(200, {"data": {"emails": [
                      {"email": "c@d.example", "emailStatus": "valid"}]}}))
    p = registry.build("snov", provider_cfg(
        "snov", extra_env={"client_id": "SNOV_ID", "client_secret": "SNOV_SECRET"}),
        client)
    assert p.available()
    ctx = {"full_name": "A B", "domain": "b.example"}
    p.execute(lead(full_name="A B", domain="b.example"), ctx)
    p.execute(lead(full_name="C D", domain="d.example"),
              {"full_name": "C D", "domain": "d.example"})
    assert session.count_for("oauth/access_token") == 1, "token should be cached"


# -------------------------------------------------------------- validators ---

def test_zerobounce_status_and_sub_status_are_carried_through(session, client):
    session.route("v2/validate", FakeResponse(200, {
        "address": "a@b.example", "status": "catch-all", "sub_status": "",
        "free_email": False, "mx_found": "true", "smtp_provider": "google"}))
    result, _ = build("zerobounce", client, api_key_env="X").execute(
        lead(), {"email": "a@b.example"})
    assert result.validation.status == "catch-all"
    assert result.validation.catch_all is True
    assert map_status(result.validation.status) == Deliverability.RISKY_CATCH_ALL.value


def test_zerobounce_do_not_mail_is_preserved(session, client):
    session.route("v2/validate", FakeResponse(200, {
        "status": "do_not_mail", "sub_status": "toxic"}))
    result, _ = build("zerobounce", client, api_key_env="X").execute(
        lead(), {"email": "a@b.example"})
    assert map_status(result.validation.status,
                      result.validation.sub_status) == Deliverability.DO_NOT_MAIL.value


def test_hunter_verifier_polls_202_then_reads_the_result(session, client):
    session.route("email-verifier", FakeResponse(202, {}),
                  FakeResponse(200, {"data": {"status": "valid", "score": 92,
                                              "accept_all": False}}))
    p = build("hunter_verifier", client, api_key_env="X",
              options={"max_polls": 3, "poll_interval": 0})
    result, _ = p.execute(lead(), {"email": "a@b.example"})
    assert result.validation.status == "valid" and result.validation.score == 92


def test_hunter_accept_all_flag_downgrades_a_valid_verdict(session, client):
    """Hunter can report status=valid with accept_all=true. That is a catch-all."""
    session.route("email-verifier", FakeResponse(200, {"data": {
        "status": "valid", "score": 80, "accept_all": True}}))
    result, _ = build("hunter_verifier", client, api_key_env="X").execute(
        lead(), {"email": "a@b.example"})
    assert result.validation.status == "accept_all"
    assert map_status(result.validation.status) == Deliverability.RISKY_CATCH_ALL.value


# ------------------------------------------------------------------- phone ---

def test_google_places_sends_a_field_mask_and_reads_the_published_number(session, client):
    session.route("places:searchText", FakeResponse(200, {"places": [
        {"id": "PLACE1", "displayName": {"text": "Meridian Skin Clinic"},
         "formattedAddress": "Bengaluru"}]}))
    session.route("v1/places/PLACE1", FakeResponse(200, {
        "id": "PLACE1", "displayName": {"text": "Meridian Skin Clinic"},
        "internationalPhoneNumber": "+91 80 4123 4567",
        "websiteUri": "https://meridianskin.example",
        "googleMapsUri": "https://maps.google.com/?cid=1"}))
    p = build("google_places", client, api_key_env="X")
    result, _ = p.execute(lead(company="Meridian Skin Clinic"),
                          {"company": "Meridian Skin Clinic", "location": "Bengaluru"})

    search_headers = session.calls[0]["headers"]
    assert "X-Goog-FieldMask" in search_headers, "field mask is mandatory"
    assert "internationalPhoneNumber" not in search_headers["X-Goog-FieldMask"], \
        "the cheap search call must not request Enterprise fields"
    assert "internationalPhoneNumber" in session.calls[1]["headers"]["X-Goog-FieldMask"]

    phone = result.phones[0]
    assert phone.number_e164 == "+918041234567"
    assert phone.contact_type == ContactType.CLINIC_MAIN_LINE.value
    assert phone.source_url.startswith("https://maps.google")
    assert result.raw["website"] == "https://meridianskin.example"


def test_google_places_no_match_when_nothing_is_listed(session, client):
    session.route("places:searchText", FakeResponse(200, {"places": []}))
    result, _ = build("google_places", client, api_key_env="X").execute(
        lead(company="Nonexistent Clinic"), {"company": "Nonexistent Clinic"})
    assert result.outcome == CallOutcome.NO_MATCH.value


def test_website_reader_respects_robots_and_keeps_the_page_url(
        session, client, monkeypatch):
    """A disallowed page is skipped; a delivered number cites the page it came from."""
    monkeypatch.setattr(
        "leadenrich.providers.phone_sources.WebsiteContactProvider._robots_allows",
        lambda self, url, ua: "/about" not in url)
    html = ('<html><body>Meridian Skin Clinic. '
            '<a href="tel:+918041234567">Reception</a>'
            + "<p>pad</p>" * 40 + '</body></html>')
    session.always(FakeResponse(200, headers={"content-type": "text/html"}, text=html))
    p = build("website", client, options={"max_pages": 2})
    result, _ = p.execute(lead(domain="meridianskin.example"),
                          {"domain": "meridianskin.example",
                           "full_name": "Dr Anaya Varma"})
    assert result.outcome == CallOutcome.HIT.value
    assert result.phones[0].source_url.startswith("https://meridianskin.example")
    assert not any("/about" in c["url"] for c in session.calls), \
        "robots.txt disallow must be honoured"


def test_website_reader_falls_back_to_www_and_http(session, client):
    """Clinic sites are inconsistent about scheme and www; the first that answers wins."""
    dead = FakeResponse(0, headers={}, text="")
    good = FakeResponse(200, headers={"content-type": "text/html"},
                        text="<html><body>Call 022 2456 7890"
                             + "<p>pad</p>" * 40 + "</body></html>")
    session.route("https://clinic.example", dead)
    session.route("https://www.clinic.example", good, good, good, good)
    p = build("website", client, options={"max_pages": 1})
    result, _ = p.execute(lead(domain="clinic.example"), {"domain": "clinic.example"})
    assert result.outcome == CallOutcome.HIT.value
    assert "www.clinic.example" in result.raw["site"]


def test_website_reader_reports_a_javascript_wall_rather_than_no_number(
        session, client):
    """The false negative that matters: we never saw the page, so say so."""
    session.always(FakeResponse(
        200, headers={"content-type": "text/html"},
        text="<html><body>Please enable JavaScript to run this app."
             + "<p>pad</p>" * 40 + "</body></html>"))
    p = build("website", client)
    result, _ = p.execute(lead(domain="clinic.example"), {"domain": "clinic.example"})
    assert result.outcome == CallOutcome.NO_MATCH.value
    assert result.raw.get("needs_human") is True
    assert "by hand" in result.detail


def test_website_reader_follows_the_sites_own_contact_link(session, client):
    home = FakeResponse(200, headers={"content-type": "text/html"},
                        text='<html><body><a href="/reach-us">Reach Us</a>'
                             + "<p>pad</p>" * 40 + "</body></html>")
    contact = FakeResponse(200, headers={"content-type": "text/html"},
                           text="<html><body>Dr Nair, direct line "
                                "+91 98200 12345" + "<p>pad</p>" * 40 + "</body></html>")
    session.route("/reach-us", contact)
    session.always(home)
    p = build("website", client, options={"max_pages": 3})
    result, _ = p.execute(lead(domain="clinic.example"),
                          {"domain": "clinic.example", "full_name": "Dr Kavya Nair"})
    assert result.outcome == CallOutcome.HIT.value
    assert any("/reach-us" in u for u in result.raw["pages_checked"])


def test_website_reader_reports_a_dead_site_cleanly(session, client):
    session.always(FakeResponse(500, headers={"content-type": "text/html"}, text="err"))
    p = build("website", client)
    result, _ = p.execute(lead(domain="gone.example"), {"domain": "gone.example"})
    assert result.outcome == CallOutcome.NO_MATCH.value
    assert "did not answer" in result.detail


def test_website_reader_needs_no_credentials():
    assert build("website", None).available()


# ------------------------------------------------------- contract metadata ---

@pytest.mark.parametrize("name", ["apollo", "pdl", "hunter", "prospeo", "findymail",
                                  "anymailfinder", "dropcontact", "snov",
                                  "zerobounce", "hunter_verifier", "google_places"])
def test_every_paid_adapter_records_the_doc_it_was_built_from(name):
    """So any contract can be re-verified before a paid run."""
    cls = registry.get(name)
    assert cls.DOC_URL.startswith("http"), f"{name} must cite its documentation"
