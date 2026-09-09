"""Normalisation, slug parsing and the similarity measures behind identity checks."""
from __future__ import annotations

import pytest

from leadenrich.normalize import (canonical_linkedin_url, company_similarity,
                                  email_domain, is_free_webmail, is_role_account,
                                  linkedin_slug, looks_like_clinic,
                                  name_similarity, normalise_domain,
                                  normalise_role, parse_slug, split_name,
                                  valid_email_syntax)


@pytest.mark.parametrize("url,slug", [
    ("https://www.linkedin.com/in/dr-anjali-mehta-8b41a2/", "dr-anjali-mehta-8b41a2"),
    ("http://linkedin.com/in/rohan-desai?trk=abc", "rohan-desai"),
    ("linkedin.com/in/Kavya-Nair", "kavya-nair"),
    ("https://in.linkedin.com/in/arjun-menon", "arjun-menon"),
    ("https://www.linkedin.com/company/some-clinic", ""),
    ("https://example.com/in/not-linkedin", ""),
    ("", ""),
])
def test_slug_extraction(url, slug):
    assert linkedin_slug(url) == slug


def test_canonical_url_strips_tracking_noise():
    assert canonical_linkedin_url("http://linkedin.com/in/rohan-desai?trk=x") == \
        "https://www.linkedin.com/in/rohan-desai"


def test_slug_parse_drops_honorifics_and_hex_noise():
    p = parse_slug("https://linkedin.com/in/dr-anjali-mehta-8b41a2")
    assert (p.honorific, p.probable_first, p.probable_last) == ("Dr", "Anjali", "Mehta")
    assert p.confidence == "low", "a slug is never strong evidence"


def test_slug_parse_drops_post_nominals():
    p = parse_slug("linkedin.com/in/kavya-nair-mbbs-md")
    assert p.probable_first == "Kavya" and p.probable_last == "Nair"


def test_slug_parse_handles_a_single_token():
    p = parse_slug("linkedin.com/in/drmehta")
    assert p.probable_first == "Drmehta" and p.confidence == "low"


@pytest.mark.parametrize("full,first,last", [
    ("Dr. Anjali Mehta", "Anjali", "Mehta"),
    ("Anjali Mehta MBBS", "Anjali", "Mehta"),
    ("Prof Sanjay Kumar Iyer", "Sanjay", "Iyer"),
    ("Meera", "Meera", ""),
])
def test_name_splitting(full, first, last):
    assert split_name(full) == (first, last)


def test_name_similarity_ignores_titles_and_qualifications():
    assert name_similarity("Dr. Anjali Mehta", "Anjali Mehta MBBS") == 1.0
    assert name_similarity("Anjali Mehta", "Rohan Desai") == 0.0


def test_company_similarity_ignores_legal_suffixes():
    assert company_similarity("Meridian Skin Clinic Pvt Ltd",
                              "Meridian Skin Clinic") > 0.6


def test_company_similarity_is_not_fooled_by_generic_clinic_words():
    """'Clinic' in both names is not evidence they are the same clinic."""
    assert company_similarity("Meridian Skin Clinic", "Aurora Eye Clinic") == 0.0


@pytest.mark.parametrize("raw,expected", [
    ("https://www.SunriseClinic.in/contact", "sunriseclinic.in"),
    ("www.aurora.example", "aurora.example"),
    ("dr@meridianskin.example", "meridianskin.example"),
    ("not a domain", ""),
    ("", ""),
])
def test_domain_normalisation(raw, expected):
    assert normalise_domain(raw) == expected


@pytest.mark.parametrize("title,expected", [
    ("Founder & Medical Director", "Founder"),
    ("Managing Director", "Managing Director"),
    ("Chief Executive Officer", "CEO"),
    ("Owner, Sunrise Dental", "Owner"),
])
def test_role_normalisation(title, expected):
    assert normalise_role(title) == expected


def test_unknown_titles_pass_through_unchanged():
    assert normalise_role("Ayurvedic Practitioner") == "Ayurvedic Practitioner"


@pytest.mark.parametrize("name,is_clinic", [
    ("Meridian Skin Clinic", True), ("Aurora Eye Care", True),
    ("Lotus Wellness Polyclinic", True), ("Silverline Diagnostics", True),
    ("Northgate Physiotherapy", True), ("Acme Software Pvt Ltd", False),
])
def test_clinic_detection(name, is_clinic):
    assert looks_like_clinic(name) is is_clinic


@pytest.mark.parametrize("addr,role", [
    ("info@clinic.example", True), ("contact@clinic.example", True),
    ("appointments@clinic.example", True), ("anjali@clinic.example", False),
    ("a.mehta@clinic.example", False),
])
def test_role_account_detection(addr, role):
    assert is_role_account(addr) is role


def test_indian_webmail_domains_are_recognised():
    assert is_free_webmail("dr@rediffmail.com")
    assert is_free_webmail("dr@yahoo.co.in")
    assert not is_free_webmail("dr@meridianskin.example")


@pytest.mark.parametrize("addr,ok", [
    ("a@b.co", True), ("first.last+tag@sub.domain.in", True),
    ("no-at-sign", False), ("a@b", False), ("", False),
])
def test_email_syntax(addr, ok):
    assert valid_email_syntax(addr) is ok


def test_email_domain_extraction():
    assert email_domain("Dr@Meridian.Example") == "meridian.example"
    assert email_domain("bad") == ""
