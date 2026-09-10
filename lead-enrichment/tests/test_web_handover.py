"""The browser route that hands a client-facing zip to a non-technical operator.

The terminal is the wall most operators hit, so this route -- not the CLI -- is
how the bundle usually gets built. It needs the same partial-run guard, and the
same guarantee that a demo run is stamped as fictional.
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from leadenrich.handover import COVER_MD, LEADS_CSV
from leadenrich.web.app import create_app

CONFIG = Path(__file__).resolve().parents[1] / "config" / "pipeline.yml"
SAMPLE = Path(__file__).resolve().parents[1] / "samples" / "sample_input.csv"


@pytest.fixture
def client(tmp_path, monkeypatch):
    # output_dir in pipeline.yml is relative, so the cwd decides where the
    # bundle lands. Anchor it in tmp_path rather than the repo.
    monkeypatch.chdir(tmp_path)
    app = create_app(str(CONFIG), data_dir=str(tmp_path / "data"), demo=True,
                     env_path=str(tmp_path / ".env"))
    app.config.update(TESTING=True)
    with app.test_client() as c:
        yield c


def _finished_run(tmp_path, limit=None):
    """Drive a real demo run through the pipeline, then return its id."""
    from leadenrich.config import load_config
    from leadenrich.io_csv import read_inputs
    from leadenrich.pipeline import Pipeline, prepare_run
    from leadenrich.store import Store

    cfg = load_config(str(CONFIG), demo=True)
    store = Store(tmp_path / "data" / "runs.sqlite3")
    inputs, _ = read_inputs(SAMPLE)
    run_id = prepare_run(cfg, store, inputs, input_path=str(SAMPLE))
    Pipeline(cfg, store, run_id).run(limit=limit)
    store.close()
    return run_id


def test_finished_run_returns_a_zip_the_operator_can_send(client, tmp_path):
    run_id = _finished_run(tmp_path)
    r = client.post(f"/handover/{run_id}",
                    data={"client": "Acme Clinics", "operator": "Zeeshan"})

    assert r.status_code == 200
    assert f"{run_id}_handover.zip" in r.headers["Content-Disposition"]

    with zipfile.ZipFile(io.BytesIO(r.data)) as z:
        names = z.namelist()
        note = z.read(f"{run_id}_handover/{COVER_MD}").decode("utf-8")
    assert f"{run_id}_handover/{LEADS_CSV}" in names
    assert "Acme Clinics" in note
    assert "Prepared by Zeeshan." in note
    assert "FICTIONAL DATA" in note, "a demo run must be stamped, whatever built it"


def test_half_finished_run_is_refused_and_explains_why(client, tmp_path):
    run_id = _finished_run(tmp_path, limit=2)
    r = client.post(f"/handover/{run_id}", data={"client": "Acme"})

    assert r.status_code == 409
    body = r.get_data(as_text=True)
    assert "have not been processed yet" in body
    assert not list(tmp_path.rglob("*_handover.zip"))


def test_the_operator_can_override_the_guard_deliberately(client, tmp_path):
    run_id = _finished_run(tmp_path, limit=2)
    r = client.post(f"/handover/{run_id}", data={"client": "Acme", "force": "1"})
    assert r.status_code == 200
    with zipfile.ZipFile(io.BytesIO(r.data)) as z:
        assert f"{run_id}_handover/{LEADS_CSV}" in z.namelist()


def test_unknown_run_does_not_500(client):
    r = client.post("/handover/run-does-not-exist", data={})
    assert r.status_code in (302, 303)
