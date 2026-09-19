"""Test fixtures - every test runs against its own throwaway SQLite file."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def db_file(tmp_path, monkeypatch):
    path = tmp_path / "test_leads.db"
    monkeypatch.setenv("STREAMER_LEADS_DB", str(path))
    return path


@pytest.fixture()
def client(db_file):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
