"""The acceptance tests named in the build brief, run for real.

Each test below maps to one of the ten required checks; a handful of extra
tests cover the behaviour those ten depend on.
"""

from __future__ import annotations

import csv
import io
import socket
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app.csv_export import HEADERS, build_csv, guard_cell
from app.main import app

WHATNOT = "https://www.whatnot.com/user/cardvault"


def make_lead(client, url, followers="1250", email="contact@example.shop"):
    return client.post(
        "/api/leads",
        json={"profile_url": url, "follower_count": followers, "email_address": email},
    )


# -- Test 1 ---------------------------------------------------------------
def test_1_complete_lead_survives_a_refresh(client, db_file):
    response = make_lead(client, WHATNOT)
    assert response.status_code == 201, response.text
    lead = response.json()["lead"]
    assert lead["profile_url"] == WHATNOT
    assert lead["follower_count"] == 1250
    assert lead["email_address"] == "contact@example.shop"
    assert lead["status"] == "ready"

    # A browser refresh re-reads from the API; the record must still be there.
    reloaded = client.get("/api/leads").json()["leads"]
    assert [item["id"] for item in reloaded] == [lead["id"]]
    assert client.get(f"/api/leads/{lead['id']}").json()["profile_url"] == WHATNOT


# -- Test 2 ---------------------------------------------------------------
def test_2_missing_email_is_incomplete_and_unexportable(client):
    lead = make_lead(client, WHATNOT, email="").json()["lead"]
    assert lead["status"] == "incomplete"
    assert lead["email_address"] is None

    refused = client.post(f"/api/leads/{lead['id']}/approve")
    assert refused.status_code == 400
    assert "email address" in refused.json()["message"]

    assert client.get("/api/export/preview").json()["rows"] == []
    assert client.get("/api/stats").json()["incomplete"] == 1


# -- Test 3 ---------------------------------------------------------------
def test_3_duplicate_profile_is_detected(client):
    first = make_lead(client, WHATNOT).json()["lead"]

    again = make_lead(client, WHATNOT)
    assert again.status_code == 409
    body = again.json()
    assert body["message"] == "This profile is already in your leads."
    assert body["lead"]["id"] == first["id"]          # powers "Open Existing Lead"

    # Same profile, cosmetically different link: still one lead.
    variants = [
        "https://whatnot.com/user/cardvault",
        "https://www.whatnot.com/user/CardVault/",
        "www.whatnot.com/user/cardvault?utm_source=newsletter&ref=abc",
        "  https://www.whatnot.com/user/cardvault  ",
    ]
    for variant in variants:
        assert make_lead(client, variant).status_code == 409, variant

    check = client.post(
        "/api/leads/check-duplicate", json={"profile_url": "whatnot.com/user/cardvault"}
    ).json()
    assert check["duplicate"] is True and check["lead"]["id"] == first["id"]

    assert client.get("/api/stats").json()["total"] == 1


def test_3b_similar_usernames_are_not_treated_as_the_same_streamer(client):
    assert make_lead(client, "https://www.whatnot.com/user/cardvault").status_code == 201
    assert make_lead(client, "https://www.whatnot.com/user/cardvault1").status_code == 201
    assert make_lead(client, "https://www.whatnot.com/user/card_vault").status_code == 201
    assert client.get("/api/stats").json()["total"] == 3


# -- Test 4 ---------------------------------------------------------------
@pytest.mark.parametrize(
    "entered,value,approximate",
    [
        ("1250", 1250, False),
        ("1,250", 1250, False),
        ("1.2K", 1200, True),
        ("15K", 15000, True),
        ("1.25M", 1250000, True),
        ("2,000 followers", 2000, False),
    ],
)
def test_4_follower_counts_normalise_and_keep_their_approximate_flag(
    client, entered, value, approximate
):
    lead = make_lead(client, WHATNOT, followers=entered).json()["lead"]
    assert lead["follower_count"] == value
    # The abbreviation the operator saw is kept, and the rounding is flagged,
    # so an approximate reading is never presented as an exact one.
    assert lead["follower_approximate"] is approximate
    assert lead["follower_raw"] == entered


def test_4b_unreadable_follower_counts_are_refused_not_guessed(client):
    for bad in ["abc", "12.5", "-5", "1 2 3"]:
        response = make_lead(client, WHATNOT, followers=bad)
        assert response.status_code == 400, bad
        assert response.json()["field"] == "follower_count"
    assert client.get("/api/stats").json()["total"] == 0


# -- Test 5 ---------------------------------------------------------------
@pytest.mark.parametrize("bad", ["not-an-email", "two@@at.com", "missing@domain", "a@b"])
def test_5_invalid_email_is_warned_about(client, bad):
    response = make_lead(client, WHATNOT, email=bad)
    assert response.status_code == 400
    body = response.json()
    assert body["field"] == "email_address"
    assert "not a valid email address" in body["message"]

    live = client.post("/api/validate", json={"email_address": bad}).json()
    assert live["email_address"]["ok"] is False
    assert live["email_address"]["message"]


# -- Test 6 ---------------------------------------------------------------
def test_6_approved_lead_exports_as_exactly_three_columns(client):
    lead = make_lead(client, WHATNOT).json()["lead"]
    approved = client.post(f"/api/leads/{lead['id']}/approve").json()["lead"]
    assert approved["status"] == "approved"

    response = client.get("/api/export/csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "streamer_leads_" in response.headers["content-disposition"]

    text = response.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[0] == ["Profile Link", "Follower Count", "Email Address"]
    assert len(rows[0]) == 3
    assert rows[1] == [WHATNOT, "1250", "contact@example.shop"]
    assert all(len(row) == 3 for row in rows)
    assert len(rows) == 2


# -- Test 7 ---------------------------------------------------------------
def test_7_only_approved_leads_are_exported(client):
    approved_urls = [f"https://www.whatnot.com/user/seller{n}" for n in (1, 2, 3)]
    for url in approved_urls:
        lead = make_lead(client, url).json()["lead"]
        client.post(f"/api/leads/{lead['id']}/approve")

    make_lead(client, "https://www.whatnot.com/user/nomail", email="")      # incomplete
    make_lead(client, "https://www.whatnot.com/user/waiting")               # ready

    counts = client.get("/api/stats").json()
    assert counts == {"total": 5, "incomplete": 1, "ready": 1, "approved": 3, "complete": 4}

    rows = list(csv.reader(io.StringIO(client.get("/api/export/csv").content.decode("utf-8-sig"))))
    assert len(rows) == 4                                   # header + 3 approved
    assert [row[0] for row in rows[1:]] == approved_urls

    preview = client.get("/api/export/preview").json()
    assert len(preview["rows"]) == 3
    assert preview["headers"] == HEADERS


# -- Test 8 ---------------------------------------------------------------
def test_8_search_links_are_ordinary_google_urls_and_nothing_is_fetched(client, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the application must not make outbound network calls")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)

    payload = client.get("/api/searches", params={"platform": "whatnot", "topic": "trading_cards"}).json()
    assert len(payload["searches"]) >= 4
    assert payload["platform"]["home_url"] == "https://www.whatnot.com/"

    for search in payload["searches"]:
        parts = urlsplit(search["url"])
        assert (parts.scheme, parts.netloc, parts.path) == ("https", "www.google.com", "/search")
        assert parse_qs(parts.query)["q"] == [search["query"]]   # correctly encoded
        assert "trading cards" in search["query"]

    ebay = client.get("/api/searches", params={"platform": "ebay_live", "topic": "sneakers"}).json()
    assert ebay["platform"]["home_url"] == "https://www.ebay.com/eBayLive"
    assert any('"eBay Live"' in s["query"] for s in ebay["searches"])

    email_hunt = client.post("/api/searches/email", json={"profile_url": WHATNOT}).json()
    assert email_hunt["identifier"] == "cardvault"
    assert all(s["url"].startswith("https://www.google.com/search?q=") for s in email_hunt["searches"])
    assert all("cardvault" in s["query"] for s in email_hunt["searches"])


# -- Test 9 ---------------------------------------------------------------
def test_9_leads_survive_a_backend_restart(client, db_file):
    lead = make_lead(client, WHATNOT).json()["lead"]
    client.post(f"/api/leads/{lead['id']}/approve")
    make_lead(client, "https://www.whatnot.com/user/second", email="")

    client.close()                                   # shut the backend down

    with TestClient(app) as restarted:                # start it again, same file
        assert restarted.get("/api/health").json()["ok"] is True
        leads = restarted.get("/api/leads").json()["leads"]
        assert {item["profile_url"] for item in leads} == {
            WHATNOT, "https://www.whatnot.com/user/second",
        }
        assert restarted.get("/api/stats").json() == {
            "total": 2, "incomplete": 1, "ready": 0, "approved": 1, "complete": 1,
        }
        rows = list(csv.reader(io.StringIO(
            restarted.get("/api/export/csv").content.decode("utf-8-sig"))))
        assert rows[1][0] == WHATNOT


# -- Test 10 --------------------------------------------------------------
def test_10_csv_formula_injection_is_neutralised():
    hostile = [
        {"url_key": "a", "profile_url": '=HYPERLINK("http://evil.test","click")',
         "follower_count": 10, "email_address": "+cmd|'/c calc'!A0"},
        {"url_key": "b", "profile_url": "@SUM(1+1)", "follower_count": 20,
         "email_address": "-2+3+cmd|' /C calc'!A0"},
        {"url_key": "c", "profile_url": "\tTAB", "follower_count": 30, "email_address": "\rCR"},
    ]
    rows = list(csv.reader(io.StringIO(build_csv(hostile))))
    for row in rows[1:]:
        for cell in row:
            assert not cell.startswith(("=", "+", "-", "@", "\t", "\r")), cell
            if cell:
                assert cell.startswith("'") or cell[0].isalnum(), cell

    # Genuine values pass through untouched.
    assert guard_cell("https://www.whatnot.com/user/x") == "https://www.whatnot.com/user/x"
    assert guard_cell("contact@shop.example") == "contact@shop.example"
    assert guard_cell(1250) == "1250"


def test_10b_hostile_values_survive_a_real_export(client):
    client.post("/api/leads", json={
        "profile_url": "https://www.whatnot.com/user/=SUM(A1:A9)",
        "follower_count": "500", "email_address": "sales@shop.example",
    })
    lead = client.get("/api/leads").json()["leads"][0]
    client.post(f"/api/leads/{lead['id']}/approve")
    rows = list(csv.reader(io.StringIO(client.get("/api/export/csv").content.decode("utf-8-sig"))))
    assert len(rows[1]) == 3
    assert rows[1][0].startswith("https://")          # no risky prefix to guard
