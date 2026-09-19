"""Editing, approval demotion, guided prompts and the paste-text assistant."""

from __future__ import annotations

WHATNOT = "https://www.whatnot.com/user/cardvault"


def make_lead(client, url=WHATNOT, followers="1250", email="contact@example.shop"):
    return client.post(
        "/api/leads",
        json={"profile_url": url, "follower_count": followers, "email_address": email},
    )


def test_incomplete_lead_can_be_completed_later(client):
    lead = make_lead(client, followers="", email="").json()["lead"]
    assert lead["status"] == "incomplete"

    step = client.patch(f"/api/leads/{lead['id']}", json={"follower_count": "3.4K"}).json()
    assert step["lead"]["status"] == "incomplete"          # email still missing
    assert step["lead"]["follower_count"] == 3400
    assert step["lead"]["follower_approximate"] is True
    assert step["next_action"]["state"] == "need_email"

    done = client.patch(f"/api/leads/{lead['id']}", json={"email_address": "hi@shop.example"}).json()
    assert done["lead"]["status"] == "ready"
    assert done["next_action"]["state"] == "review"


def test_editing_an_approved_lead_returns_it_to_review(client):
    lead = make_lead(client).json()["lead"]
    client.post(f"/api/leads/{lead['id']}/approve")

    # A cosmetic re-save of identical values keeps the approval.
    same = client.patch(f"/api/leads/{lead['id']}", json={"follower_count": "1250"}).json()
    assert same["lead"]["status"] == "approved"
    assert same["demoted"] is False

    changed = client.patch(f"/api/leads/{lead['id']}", json={"email_address": "new@shop.example"}).json()
    assert changed["lead"]["status"] == "ready"
    assert changed["demoted"] is True
    assert "back to Ready for review" in changed["message"]
    assert client.get("/api/export/preview").json()["rows"] == []


def test_clearing_a_field_on_an_approved_lead_makes_it_incomplete(client):
    lead = make_lead(client).json()["lead"]
    client.post(f"/api/leads/{lead['id']}/approve")
    result = client.patch(f"/api/leads/{lead['id']}", json={"email_address": ""}).json()
    assert result["lead"]["status"] == "incomplete"
    assert result["demoted"] is True


def test_editing_into_an_existing_profile_url_is_blocked(client):
    first = make_lead(client).json()["lead"]
    second = make_lead(client, "https://www.whatnot.com/user/other").json()["lead"]
    clash = client.patch(f"/api/leads/{second['id']}", json={"profile_url": WHATNOT})
    assert clash.status_code == 409
    assert clash.json()["lead"]["id"] == first["id"]


def test_unapprove_returns_a_lead_to_review(client):
    lead = make_lead(client).json()["lead"]
    client.post(f"/api/leads/{lead['id']}/approve")
    back = client.post(f"/api/leads/{lead['id']}/unapprove").json()["lead"]
    assert back["status"] == "ready"


def test_delete_and_bulk_delete(client):
    ids = [
        make_lead(client, f"https://www.whatnot.com/user/s{n}").json()["lead"]["id"]
        for n in range(4)
    ]
    assert client.delete(f"/api/leads/{ids[0]}").json()["deleted"] == 1
    assert client.delete(f"/api/leads/{ids[0]}").status_code == 404

    assert client.post("/api/leads/bulk-delete", json={"ids": ids[1:3]}).json()["deleted"] == 2
    assert client.post("/api/leads/bulk-delete", json={"ids": []}).json()["deleted"] == 0
    assert client.get("/api/stats").json()["total"] == 1


def test_search_and_status_filters(client):
    a = make_lead(client, "https://www.whatnot.com/user/alpha", email="alpha@shop.example").json()["lead"]
    make_lead(client, "https://www.whatnot.com/user/beta", email="")
    client.post(f"/api/leads/{a['id']}/approve")

    assert len(client.get("/api/leads", params={"q": "alpha"}).json()["leads"]) == 1
    assert len(client.get("/api/leads", params={"q": "alpha@shop"}).json()["leads"]) == 1
    assert len(client.get("/api/leads", params={"status": "incomplete"}).json()["leads"]) == 1
    assert len(client.get("/api/leads", params={"status": "approved"}).json()["leads"]) == 1
    assert len(client.get("/api/leads", params={"status": "ready"}).json()["leads"]) == 0


def test_guided_next_action_for_an_unsaved_form(client):
    def ask(**fields):
        payload = {"profile_url": "", "follower_count": "", "email_address": "", **fields}
        return client.post("/api/next-action", json=payload).json()

    assert ask()["state"] == "need_profile"
    assert "paste the profile URL" in ask()["message"]
    assert ask(profile_url=WHATNOT)["state"] == "need_followers"
    assert ask(profile_url=WHATNOT, follower_count="1.2K")["state"] == "need_email"
    assert ask(profile_url=WHATNOT, follower_count="1.2K", email_address="a@b.example")["state"] == "review"


def test_validate_reports_normalised_values_and_hints(client):
    result = client.post("/api/validate", json={
        "profile_url": "whatnot.com/user/Example/?utm_source=x",
        "follower_count": "1.2K",
        "email_address": "  Contact@Example.SHOP ",
    }).json()

    assert result["profile_url"]["value"] == "https://whatnot.com/user/Example"
    assert "Tracking parameters were removed" in result["profile_url"]["hints"][0]
    assert result["profile_url"]["identifier"] == "Example"
    assert result["follower_count"] == {"ok": True, "value": 1200, "approximate": True, "message": None}
    assert result["email_address"]["value"] == "Contact@example.shop"


def test_homepage_url_gets_a_hint_but_is_still_allowed(client):
    result = client.post("/api/validate", json={"profile_url": "https://www.whatnot.com"}).json()
    assert result["profile_url"]["ok"] is True
    assert "homepage" in result["profile_url"]["hints"][0]


def test_paste_text_assistant_suggests_only_labelled_values(client):
    text = (
        "LIVE NOW - 412 viewers. Sold 1,840 items. Feedback score 9,912.\n"
        "cardvault . 12.5K followers . Business: Sales@CardVault.example "
        "(press: noreply@mailer.example)"
    )
    result = client.post("/api/extract", json={"text": text}).json()

    assert [c["value"] for c in result["follower_candidates"]] == [12500]
    assert result["follower_candidates"][0]["approximate"] is True
    assert [c["email"] for c in result["email_candidates"]] == ["Sales@cardvault.example"]


def test_paste_text_assistant_refuses_to_guess_unlabelled_numbers(client):
    result = client.post("/api/extract", json={
        "text": "412 viewers watching now. 9,912 feedback. 1,840 sold."
    }).json()
    assert result["follower_candidates"] == []
    assert any("none were labelled as followers" in note for note in result["notes"])

    empty = client.post("/api/extract", json={"text": ""}).json()
    assert empty["follower_candidates"] == [] and empty["email_candidates"] == []


def test_errors_are_readable_sentences_not_tracebacks(client):
    body = client.post("/api/leads", json={"profile_url": "not a url"}).json()
    assert body["field"] == "profile_url"
    assert "Traceback" not in body["message"] and "Error" not in body["message"]
    assert body["message"].endswith(".")

    assert client.get("/api/leads/9999").status_code == 404
    assert "no longer exists" in client.get("/api/leads/9999").json()["message"]
