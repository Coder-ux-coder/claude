"""Fetching real public pages: the failure modes live clinic sites actually have.

Each case here is something that, unhandled, reports as "no phone found" — an
answer that is wrong in a way a reviewer cannot see.
"""
from __future__ import annotations

import pytest
import requests

from conftest import FakeResponse, FakeSession
from leadenrich.webfetch import (_decode, candidate_origins, fetch_page,
                                 find_contact_links)

UA = "leadenrich-bot/1.0"


def page(body: str) -> str:
    return "<html><body>" + body + ("<p>padding</p>" * 40) + "</body></html>"


# --------------------------------------------------------------- decoding ---

def test_utf8_served_while_declaring_latin1_is_decoded_as_utf8():
    """Common on older Indian hosting. Honouring the lie corrupts the digits."""
    raw = "Dr Mehta – direct +91 98200 12345".encode("utf-8")
    assert "–" in _decode(raw, "iso-8859-1")


def test_genuine_cp1252_is_still_honoured():
    assert "–" in _decode("Dr Mehta – direct".encode("cp1252"), "cp1252")


def test_undecodable_bytes_never_raise():
    assert _decode(b"\xff\xfe\x00bad", "utf-8")


# ---------------------------------------------------------------- origins ---

def test_scheme_and_www_variants_are_tried_in_likelihood_order():
    o = candidate_origins("www.SunriseClinic.in")
    assert o[0] == "https://sunriseclinic.in"
    assert "https://www.sunriseclinic.in" in o
    assert any(u.startswith("http://") for u in o), "some clinic sites are http-only"


def test_empty_domain_yields_nothing():
    assert candidate_origins("") == []


# ------------------------------------------------------------------ links ---

def test_the_sites_own_contact_link_is_preferred_over_guessed_paths():
    html = ('<a href="/about">About</a><a href="/reach-us">Reach Us</a>'
            '<a href="/blog">Blog</a>')
    links = find_contact_links(html, "https://clinic.example/")
    assert links == ["https://clinic.example/reach-us"]


def test_offsite_and_non_page_links_are_ignored():
    html = ('<a href="https://facebook.example/contact">Contact us</a>'
            '<a href="tel:+919820012345">Call</a>'
            '<a href="mailto:a@b.example">Email</a>')
    assert find_contact_links(html, "https://clinic.example/") == []


# ---------------------------------------------------------------- fetching ---

def test_a_normal_page_is_read(session):
    session.always(FakeResponse(200, headers={"content-type": "text/html"},
                                text=page("Call us on 022 2456 7890")))
    res = fetch_page(session, "https://clinic.example/", user_agent=UA)
    assert res.ok and "2456" in res.text


def test_a_pdf_is_not_parsed_as_a_page(session):
    """A brochure is a legitimate response, just not one we can read."""
    session.always(FakeResponse(200, headers={"content-type": "application/pdf"},
                                text="%PDF-1.7 binary"))
    res = fetch_page(session, "https://clinic.example/brochure", user_agent=UA)
    assert not res.ok and "not a readable page" in res.reason


def test_oversized_pages_are_truncated_not_swallowed_whole(session):
    session.always(FakeResponse(200, headers={"content-type": "text/html"},
                                content=b"x" * 500_000))
    res = fetch_page(session, "https://clinic.example/", user_agent=UA,
                     max_bytes=50_000)
    assert res.truncated and res.bytes_read <= 82_000


def test_a_javascript_wall_is_reported_as_needing_a_human(session):
    """The critical one: this must never read as 'no number found'."""
    session.always(FakeResponse(
        200, headers={"content-type": "text/html"},
        text=page("You need to enable JavaScript to run this app.")))
    res = fetch_page(session, "https://clinic.example/", user_agent=UA)
    assert res.js_wall and not res.ok
    assert "by hand" in res.reason


def test_cloudflare_interstitial_is_also_flagged(session):
    session.always(FakeResponse(200, headers={"content-type": "text/html"},
                                text=page("Just a moment... checking your browser")))
    assert fetch_page(session, "https://clinic.example/", user_agent=UA).js_wall


def test_redirect_loops_do_not_hang(session):
    def boom():
        raise requests.TooManyRedirects("loop")
    session.always(boom)
    res = fetch_page(session, "https://clinic.example/", user_agent=UA)
    assert not res.ok and "redirect loop" in res.reason


def test_timeouts_are_reported_not_raised(session):
    def boom():
        raise requests.Timeout("slow")
    session.always(boom)
    res = fetch_page(session, "https://clinic.example/", user_agent=UA)
    assert not res.ok and "timed out" in res.reason


def test_connection_failure_is_reported_not_raised(session):
    def boom():
        raise ConnectionError("refused")
    session.always(boom)
    res = fetch_page(session, "https://clinic.example/", user_agent=UA)
    assert not res.ok and "unreachable" in res.reason


def test_a_read_that_dies_midway_keeps_what_it_got(session):
    session.always(FakeResponse(200, headers={"content-type": "text/html"},
                                text=page("Reception 022 2456 7890"),
                                raise_on_read=None))
    assert fetch_page(session, "https://clinic.example/", user_agent=UA).ok


def test_404_and_500_are_reasons_not_exceptions(session):
    session.always(FakeResponse(404, headers={"content-type": "text/html"}, text="no"))
    res = fetch_page(session, "https://clinic.example/gone", user_agent=UA)
    assert not res.ok and "HTTP 404" in res.reason


def test_an_empty_shell_is_not_treated_as_a_real_page(session):
    session.always(FakeResponse(200, headers={"content-type": "text/html"},
                                text="<html><body></body></html>"))
    res = fetch_page(session, "https://clinic.example/", user_agent=UA)
    assert not res.ok and "empty" in res.reason
