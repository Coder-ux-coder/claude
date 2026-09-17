"""API, job lifecycle, version graph and security tests.

These run against the real FastAPI app with a temporary database. They do not
need Blender except where explicitly marked.
"""
import os
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("AFRI_MAX_JOBS", "1")


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from fastapi.testclient import TestClient
    import backend.app.core.config as cfgmod
    from backend.app.database import db

    tmp = tmp_path_factory.mktemp("afri-db")
    db.DB_PATH = str(tmp / "test.db")
    cfgmod.DB_PATH = db.DB_PATH
    db._local.__dict__.clear()

    from backend.app.main import app
    with TestClient(app) as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_system_reports_real_environment(client):
    d = client.get("/api/system").json()
    assert d["app"] == "AFRi Studio"
    assert d["cpu_count"] >= 1
    assert isinstance(d["blender"]["available"], bool)
    assert d["hat_stage_two_started"] is False, "Stage Two must not have started"
    assert any(p["name"] == "manual_handoff" and p["available"]
               for p in d["ai_providers"]), "manual fallback must always be available"


def test_schema_drives_the_parameter_editor(client):
    d = client.get("/api/schema").json()
    assert set(d["sections"]) == {"flower", "split", "hat", "placement",
                                  "material", "render"}
    flower = {f["name"]: f for f in d["sections"]["flower"]}
    assert "petal_density" in flower
    f = flower["petal_density"]
    assert f["min"] is not None and f["max"] is not None and f["description"]


def test_concept_and_version_lifecycle(client):
    c = client.post("/api/concepts", json={"name": "Lifecycle Test",
                                           "description": "d"}).json()
    cid = c["id"]
    assert c["head"]["number"] == 1

    cfg = c["head"]["config"]
    cfg["flower"]["petal_density"] = 1.5
    v2 = client.post(f"/api/concepts/{cid}/versions",
                     json={"config": cfg, "description": "denser"}).json()
    assert v2["number"] == 2

    versions = client.get(f"/api/concepts/{cid}/versions").json()["versions"]
    assert [v["number"] for v in versions] == [1, 2]

    diff = client.get(f"/api/versions/{versions[0]['id']}/diff/{v2['id']}").json()
    assert diff["changes"]["flower.petal_density"]["to"] == 1.5

    # Restore appends; it never rewrites history.
    r = client.post(f"/api/versions/{versions[0]['id']}/restore").json()
    assert r["number"] == 3
    assert len(client.get(f"/api/concepts/{cid}/versions").json()["versions"]) == 3


def test_invalid_config_is_rejected(client):
    c = client.post("/api/concepts", json={"name": "Bad Config"}).json()
    cfg = c["head"]["config"]
    cfg["flower"]["petal_density"] = 999
    r = client.post(f"/api/concepts/{c['id']}/versions",
                    json={"config": cfg, "description": "bad"})
    assert r.status_code == 422


def test_unknown_parameter_is_rejected(client):
    c = client.post("/api/concepts", json={"name": "Extra Field"}).json()
    cfg = c["head"]["config"]
    cfg["flower"]["nonsense"] = 1
    assert client.post(f"/api/concepts/{c['id']}/versions",
                       json={"config": cfg, "description": "x"}).status_code == 422


def test_bad_concept_name_is_rejected(client):
    assert client.post("/api/concepts", json={"name": "../../etc/passwd"}).status_code == 422
    assert client.post("/api/concepts", json={"name": ""}).status_code == 422


def test_approved_version_is_write_locked(client):
    c = client.post("/api/concepts", json={"name": "Approval Lock"}).json()
    vid = c["head"]["id"]
    client.post(f"/api/versions/{vid}/approve", json={"approved": True})
    assert client.get(f"/api/versions/{vid}").json()["approved"] == 1

    r = client.post("/api/jobs", json={"type": "GENERATE", "version_id": vid})
    if r.status_code == 200:
        import time
        from backend.app.jobs import manager
        jid = r.json()["id"]
        for _ in range(100):
            j = manager.get_job(jid)
            if j["status"] in ("failed", "completed", "cancelled"):
                break
            time.sleep(0.2)
        assert j["status"] == "failed"
        assert "approved" in j["error"] and "write-locked" in j["error"]


def test_asset_path_traversal_is_blocked(client):
    c = client.post("/api/concepts", json={"name": "Traversal"}).json()
    vid = c["head"]["id"]
    for evil in ["..%2F..%2F..%2Fetc%2Fpasswd", "....//....//etc/passwd"]:
        r = client.get(f"/api/assets/{vid}/{evil}")
        assert r.status_code in (400, 404), f"traversal not blocked: {evil}"


def test_safe_asset_path_rejects_escapes():
    from backend.app.core.security import UnsafePath, safe_asset_path
    for bad in ("../secret", "/etc/passwd", "a/../../b"):
        with pytest.raises(UnsafePath):
            safe_asset_path(bad)
    ok = safe_asset_path("projects", "afri_marigold")
    assert "afri_marigold" in str(ok)


def test_job_for_missing_version_404s(client):
    assert client.post("/api/jobs", json={"type": "GENERATE",
                                          "version_id": "ver_nope"}).status_code == 404


def test_unknown_routes_404(client):
    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/api/concepts/nope").status_code == 404


def test_measurements_endpoint(client):
    c = client.post("/api/concepts", json={"name": "Measure Me"}).json()
    m = client.get(f"/api/refine/measure/{c['head']['id']}").json()["measurements"]
    for key in ("petal_count", "piece_balance", "silhouette_raggedness",
                "relief_ratio", "diameter_mm"):
        assert key in m
    assert 0 < m["piece_balance"] <= 1.0


def test_assistant_prompt_is_available_without_ai(client):
    c = client.post("/api/concepts", json={"name": "Prompt Only"}).json()
    r = client.post("/api/assistant/prompt",
                    json={"concept_id": c["id"], "instruction": "fuller"}).json()
    assert "petal_density" in r["combined"]
    assert "JSON" in r["system"]


def test_manual_handoff_applies_a_pasted_plan(client):
    """The no-AI path must still make a real change."""
    c = client.post("/api/concepts", json={"name": "Manual Plan"}).json()
    reply = ('{"explanation":"denser","commands":[{"type":"UPDATE_FLOWER_PARAMETER",'
             '"parameter":"petal_density","value":1.8,"reason":"fuller"}]}')
    r = client.post("/api/assistant/manual",
                    json={"concept_id": c["id"], "reply": reply,
                          "auto_run": False}).json()
    assert r["applied"] == ["flower.petal_density = 1.8"]
    assert r["new_version"]["config"]["flower"]["petal_density"] == 1.8
    assert r["rejected"] == []


def test_manual_handoff_rejects_bad_commands(client):
    c = client.post("/api/concepts", json={"name": "Manual Bad"}).json()
    reply = ('{"explanation":"x","commands":[{"type":"UPDATE_FLOWER_PARAMETER",'
             '"parameter":"petal_density","value":500}]}')
    r = client.post("/api/assistant/manual",
                    json={"concept_id": c["id"], "reply": reply,
                          "auto_run": False}).json()
    assert r["applied"] == []
    assert len(r["rejected"]) == 1


def test_event_bus_fans_out_to_subscribers():
    """Exercise the SSE generator directly.

    The HTTP endpoint is an endless stream by design, so consuming it through
    the test client would simply never return. The behaviour worth testing is
    the bus itself: that it assigns monotonic sequence numbers, fans out to
    every subscriber, and emits a replayable prelude.
    """
    from backend.app.events.bus import EventBus

    bus = EventBus()
    q1, q2 = bus.subscribe(), bus.subscribe()
    a = bus.publish("job.stage", {"stage": "SPLIT", "message": "clipping"}, "job_1")
    b = bus.publish("job.completed", {"ok": True}, "job_1")

    assert b["seq"] == a["seq"] + 1, "sequence numbers must be monotonic"
    for q in (q1, q2):
        assert q.get_nowait()["type"] == "job.stage"
        assert q.get_nowait()["type"] == "job.completed"

    assert [e["type"] for e in bus.history()] == ["job.stage", "job.completed"]

    gen = bus.stream()
    assert next(gen).startswith("retry:")
    replayed = next(gen)
    assert replayed.startswith("data: ") and "job.stage" in replayed
    gen.close()

    bus.unsubscribe(q1)
    bus.publish("job.failed", {}, "job_1")
    with pytest.raises(Exception):
        q1.get_nowait()
    assert q2.get_nowait()["type"] == "job.failed"


def test_events_endpoint_is_registered(client):
    """The route exists and is declared as an event stream."""
    spec = client.get("/openapi.json").json()
    assert "/api/events" in spec["paths"]


def test_milestones_reflect_real_state(client):
    projects = client.get("/api/projects").json()["projects"]
    p = client.get(f"/api/projects/{projects[0]['id']}").json()
    keys = {m["key"] for m in p["milestones"]}
    assert "ENVIRONMENT_READY" in keys and "USER_REVIEW" in keys
    arch = next(m for m in p["milestones"] if m["key"] == "ARCHITECTURE")
    assert arch["done"] is True, "ARCHITECTURE.md should exist"
