"""End-to-end over a real socket: no mocked transport anywhere in this file.

The unit tests prove each guard in isolation. This proves the whole path --
sockets, redirects, robots.txt, charset, link-following, phone classification --
works together against a site shaped like the ones this job actually targets.
"""
from __future__ import annotations

import pytest
import requests

from fixtures.clinic_site import ClinicSite
from leadenrich.config import ProviderConfig
from leadenrich.httpclient import HttpClient
from leadenrich.models import ContactType
from leadenrich.providers import registry
from leadenrich.webfetch import fetch_page

from conftest import lead

UA = "leadenrich-bot/1.0 (+public business contact lookup)"


@pytest.fixture(scope="module")
def site():
    with ClinicSite() as s:
        yield s


def build_provider(origin_timeout: float = 8.0, **options):
    cfg = ProviderConfig(name="website", timeout=origin_timeout, options=options)
    return registry.build("website", cfg, HttpClient(timeout=origin_timeout))


# ------------------------------------------------------------- raw fetching --

def test_a_real_page_is_fetched_and_decoded(site):
    res = fetch_page(requests.Session(), site.origin + "/", user_agent=UA)
    assert res.ok and res.status == 200
    assert "Lotus Wellness Polyclinic" in res.text
    assert res.bytes_read > 0


def test_a_lying_charset_still_decodes_correctly(site):
    """/reach-us declares iso-8859-1 but serves UTF-8, as many clinic sites do."""
    res = fetch_page(requests.Session(), site.origin + "/reach-us", user_agent=UA)
    assert res.ok
    assert "Reception" in res.text and "99999 10011" in res.text


def test_a_pdf_is_declined_rather_than_mined_for_digits(site):
    res = fetch_page(requests.Session(), site.origin + "/brochure.pdf", user_agent=UA)
    assert not res.ok and "not a readable page" in res.reason


def test_the_sites_own_navigation_is_discovered(site):
    res = fetch_page(requests.Session(), site.origin + "/", user_agent=UA)
    hrefs = [u for u, _ in res.links]
    assert any(u.endswith("/reach-us") for u in hrefs), \
        "the site calls it 'Reach Us', not '/contact'"


# ----------------------------------------------------- the provider, live ----

def test_the_provider_finds_published_numbers_on_a_real_site(site):
    prov = build_provider(max_pages=4)
    result, call = prov.execute(
        lead(domain=site.origin),
        {"website": site.origin, "full_name": "Dr Meera Joshi"})

    assert result.outcome == "hit", result.detail
    assert result.phones, "should have found at least the reception number"
    for p in result.phones:
        assert p.source_url.startswith(site.origin), \
            "every number must cite the page it came from"
    assert call.duration_ms >= 0


def test_robots_disallowed_pages_are_not_read(site):
    """/internal is disallowed and carries a number that must never appear."""
    prov = build_provider(max_pages=6)
    result, _ = prov.execute(lead(domain=site.origin), {"website": site.origin})
    numbers = {p.number_e164 for p in result.phones}
    assert "+911419990000" not in numbers
    assert not any("/internal" in u for u in result.raw.get("pages_checked", []))


def test_a_doctors_published_direct_line_beats_the_switchboard(site):
    """The whole point: the number captioned for her, not the reception line."""
    prov = build_provider(max_pages=6)
    result, _ = prov.execute(
        lead(domain=site.origin),
        {"website": site.origin, "full_name": "Dr Meera Joshi"})

    by_number = {p.number_e164: p for p in result.phones}
    direct = by_number.get("+919999910005")
    assert direct is not None, f"direct line not found in {sorted(by_number)}"
    assert direct.contact_type == ContactType.PUBLISHED_DIRECT_LINE.value
    assert "/team" in direct.source_url

    reception = by_number.get("+911414567890")
    if reception:
        assert reception.contact_type == ContactType.CLINIC_MAIN_LINE.value


def test_a_dead_host_is_a_clean_no_match_not_a_crash():
    prov = build_provider(origin_timeout=3.0)
    result, _ = prov.execute(lead(domain="no-such-clinic-8h2x.invalid"),
                             {"domain": "no-such-clinic-8h2x.invalid"})
    assert result.outcome == "no_match"
    assert "did not answer" in result.detail


def test_the_page_budget_is_respected(site):
    prov = build_provider(max_pages=2)
    result, _ = prov.execute(lead(domain=site.origin), {"website": site.origin})
    assert len(result.raw.get("pages_checked", [])) <= 2
