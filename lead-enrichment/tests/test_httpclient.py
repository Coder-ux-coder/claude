"""Transient failure versus clean no-match -- the distinction the waterfall rests on."""
from __future__ import annotations

import pytest

from conftest import FakeResponse
from leadenrich.httpclient import HttpClient, PermanentError, TransientError


def test_retries_429_then_succeeds(session):
    session.always(FakeResponse(429, {}, {"Retry-After": "0"}),
                   FakeResponse(429, {}),
                   FakeResponse(200, {"ok": True}))
    slept = []
    c = HttpClient(max_attempts=4, base_delay=0.01, jitter=0.0,
                   session=session, sleep=slept.append)
    resp = c.get("https://api.example/x")
    assert resp.status == 200 and resp.json_body == {"ok": True}
    assert len(session.calls) == 3, "should have retried twice before succeeding"
    assert len(slept) == 2, "should have backed off between attempts"


def test_retry_after_header_is_respected(session):
    session.always(FakeResponse(429, {}, {"Retry-After": "7"}),
                   FakeResponse(200, {"ok": True}))
    slept = []
    c = HttpClient(max_attempts=3, base_delay=1.0, jitter=0.0,
                   session=session, sleep=slept.append)
    c.get("https://api.example/x")
    assert slept == [7.0], "server-specified delay should win over our backoff"


def test_backoff_grows_exponentially(session):
    session.always(*[FakeResponse(503, {}) for _ in range(4)])
    slept = []
    c = HttpClient(max_attempts=4, base_delay=1.0, max_delay=100, jitter=0.0,
                   session=session, sleep=slept.append)
    with pytest.raises(TransientError):
        c.get("https://api.example/x")
    assert slept == [1.0, 2.0, 4.0]


def test_exhausted_retries_raise_transient(session):
    session.always(*[FakeResponse(503, {}) for _ in range(5)])
    c = HttpClient(max_attempts=3, base_delay=0.001, jitter=0.0,
                   session=session, sleep=lambda _s: None)
    with pytest.raises(TransientError):
        c.get("https://api.example/x")
    assert len(session.calls) == 3, "must stop at max_attempts"


def test_4xx_is_permanent_and_never_retried(session):
    session.always(FakeResponse(401, {"error": "bad key"}, text='{"error":"bad key"}'))
    c = HttpClient(max_attempts=4, session=session, sleep=lambda _s: None)
    with pytest.raises(PermanentError):
        c.get("https://api.example/x")
    assert len(session.calls) == 1, "an auth failure must not be retried"


def test_404_is_returned_not_raised(session):
    """Many finders answer 404 for 'no match'. That is data, not a fault."""
    session.always(FakeResponse(404, {"error": "not found"}))
    c = HttpClient(session=session, sleep=lambda _s: None)
    resp = c.get("https://api.example/x")
    assert resp.status == 404
    assert len(session.calls) == 1


def test_connection_error_is_transient(session):
    def boom():
        raise ConnectionError("connection reset by peer")
    session.always(boom, boom, FakeResponse(200, {"ok": True}))
    c = HttpClient(max_attempts=4, base_delay=0.001, jitter=0.0,
                   session=session, sleep=lambda _s: None)
    assert c.get("https://api.example/x").json_body == {"ok": True}


def test_nested_get_helper():
    from leadenrich.httpclient import HttpResponse
    r = HttpResponse(200, {"data": {"email": "a@b.com", "verification": {"status": "valid"}}},
                     "", {})
    assert r.get("data", "email") == "a@b.com"
    assert r.get("data", "verification", "status") == "valid"
    assert r.get("data", "missing", default="fallback") == "fallback"
    assert r.get("nope", "deeper", default=None) is None
