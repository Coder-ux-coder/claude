"""Shared test fixtures.

Everything here is deterministic and offline. ``FakeSession`` stands in for
``requests.Session`` so an adapter can be driven through the exact response
shapes its vendor documents -- including 429s, 5xx and empty-but-successful
answers -- without a network or an account.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from leadenrich.config import (BudgetConfig, Config, EmailPolicy, PhonePolicy,
                               ProviderConfig, RetryPolicy)
from leadenrich.httpclient import HttpClient
from leadenrich.models import LeadInput, LeadRecord
from leadenrich.store import Store


class FakeResponse:
    def __init__(self, status: int = 200, body=None, headers=None, text=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = text if text is not None else json.dumps(body or {})

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class FakeSession:
    """Scripted transport. Queue responses per URL substring, or one global queue."""

    def __init__(self):
        self.routes: dict[str, list] = {}
        self.default: list = []
        self.calls: list[dict] = []

    def route(self, fragment: str, *responses) -> "FakeSession":
        self.routes.setdefault(fragment, []).extend(responses)
        return self

    def always(self, *responses) -> "FakeSession":
        self.default.extend(responses)
        return self

    def request(self, method, url, headers=None, params=None, json=None,
                data=None, timeout=None):
        self.calls.append({"method": method, "url": url, "headers": headers or {},
                           "params": params or {}, "json": json, "data": data})
        for fragment, queue in self.routes.items():
            if fragment in url and queue:
                resp = queue.pop(0)
                return resp() if callable(resp) else resp
        if self.default:
            resp = self.default.pop(0)
            return resp() if callable(resp) else resp
        return FakeResponse(200, {})

    def count_for(self, fragment: str) -> int:
        return sum(1 for c in self.calls if fragment in c["url"])


@pytest.fixture
def no_sleep(monkeypatch):
    """Make backoff instant so retry tests stay fast."""
    slept: list[float] = []
    monkeypatch.setattr("time.sleep", lambda s: slept.append(s))
    return slept


@pytest.fixture
def session():
    return FakeSession()


@pytest.fixture
def client(session):
    return HttpClient(max_attempts=4, base_delay=0.001, max_delay=0.01,
                      jitter=0.0, session=session, sleep=lambda _s: None)


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "runs.sqlite3")
    yield s
    s.close()


def make_config(**overrides) -> Config:
    """A minimal config whose providers all 'have credentials' by default."""
    cfg = Config(
        providers={},
        waterfalls={"identity": [], "email": [], "validation": [], "phone": []},
        phone_policy=PhonePolicy(), email_policy=EmailPolicy(),
        retry=RetryPolicy(max_attempts=2, base_delay=0.001, max_delay=0.01),
        budget=BudgetConfig(), output_dir="out", raw={})
    for k, v in overrides.items():
        setattr(cfg, k, v)
    return cfg


def provider_cfg(name: str, **kw) -> ProviderConfig:
    kw.setdefault("credits_per_call", 1.0)
    return ProviderConfig(name=name, **kw)


def lead(**kw) -> LeadRecord:
    return LeadRecord(inp=LeadInput(**kw))


@pytest.fixture
def cfg_factory():
    return make_config


@pytest.fixture
def pcfg():
    return provider_cfg


@pytest.fixture
def lead_factory():
    return lead
