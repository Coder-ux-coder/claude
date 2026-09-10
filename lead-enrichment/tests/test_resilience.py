"""Rate limiting and circuit breaking — what a 2,000-row run needs to survive.

These are the two failures that do not show up on eight demo rows and then
dominate a real run: getting 429-stormed because nothing paced the calls, and
re-proving a dead provider two thousand times.
"""
from __future__ import annotations

import pytest

from conftest import lead, make_config, provider_cfg
from leadenrich.breaker import FATAL_STATUSES, CircuitBreaker
from leadenrich.models import CallOutcome
from leadenrich.pipeline import Pipeline, prepare_run
from leadenrich.providers.base import Provider, ProviderResult, registry
from leadenrich.ratelimit import LimiterRegistry, RateLimiter


@pytest.fixture
def clock():
    """A fake clock so pacing is asserted exactly, and instantly."""
    now = [0.0]
    slept = []

    def tick():
        return now[0]

    def sleep(s):
        slept.append(s)
        now[0] += s

    return tick, sleep, slept, now


# ------------------------------------------------------------ rate limiting --

def test_a_burst_up_to_capacity_is_allowed(clock):
    tick, sleep, slept, _ = clock
    rl = RateLimiter("hunter", per_second=15, sleep=sleep, clock=tick)
    for _ in range(15):
        rl.acquire()
    assert slept == [], "the first second's worth should not wait at all"


def test_exceeding_the_per_second_limit_waits_exactly_one_interval(clock):
    tick, sleep, slept, _ = clock
    rl = RateLimiter("hunter", per_second=15, sleep=sleep, clock=tick)
    for _ in range(15):
        rl.acquire()
    waited = rl.acquire()
    assert waited == pytest.approx(1 / 15, rel=1e-3)


def test_the_per_minute_ceiling_binds_as_well(clock):
    """Hunter documents 15/s AND 500/min. Both must hold."""
    tick, sleep, _slept, _ = clock
    rl = RateLimiter("hunter", per_second=15, per_minute=500, sleep=sleep, clock=tick)
    for _ in range(500):
        rl.acquire()
    assert rl.acquire() > 0, "the minute bucket should now be the binding one"


def test_a_provider_with_no_documented_limit_never_waits(clock):
    tick, sleep, slept, _ = clock
    rl = RateLimiter("website", sleep=sleep, clock=tick)
    assert rl.unlimited
    for _ in range(50):
        rl.acquire()
    assert slept == []


def test_the_limiter_refills_over_time(clock):
    tick, sleep, _slept, now = clock
    rl = RateLimiter("x", per_second=10, sleep=sleep, clock=tick)
    for _ in range(10):
        rl.acquire()
    now[0] += 1.0                      # a second passes
    assert rl.acquire() == 0.0


def test_an_impossible_wait_surfaces_rather_than_hanging(clock):
    tick, sleep, _slept, _ = clock
    rl = RateLimiter("x", per_minute=1, sleep=sleep, clock=tick)
    rl.acquire()
    with pytest.raises(TimeoutError):
        rl.acquire(timeout=5.0)


def test_limits_come_from_provider_config(clock):
    tick, sleep, _s, _ = clock
    reg = LimiterRegistry(sleep=sleep, clock=tick)
    a = reg.for_provider("hunter", {"rate_per_second": 15, "rate_per_minute": 500})
    assert reg.for_provider("hunter", {}) is a, "one limiter per provider, shared"
    assert reg.for_provider("website", {}).unlimited


# ---------------------------------------------------------- circuit breaker --

def test_the_breaker_opens_after_repeated_permanent_failures():
    cb = CircuitBreaker(threshold=3)
    assert [cb.record_permanent_failure("p", "HTTP 500") for _ in range(3)] \
        == [False, False, True]
    assert cb.is_open("p")


def test_a_success_resets_the_count():
    cb = CircuitBreaker(threshold=3)
    cb.record_permanent_failure("p", "x")
    cb.record_permanent_failure("p", "x")
    cb.record_success("p")
    cb.record_permanent_failure("p", "x")
    assert not cb.is_open("p"), "two failures either side of a success is not a run"


def test_a_clean_no_match_counts_as_success():
    """Nobody having the record is a healthy answer, not a fault."""
    cb = CircuitBreaker(threshold=2)
    cb.record_permanent_failure("p", "x")
    cb.record_success("p")
    assert not cb.is_open("p")


@pytest.mark.parametrize("status", sorted(FATAL_STATUSES))
def test_unrecoverable_statuses_trip_immediately(status):
    """A wrong key will not become right on row 2."""
    cb = CircuitBreaker(threshold=99)
    cb.open_now("p", FATAL_STATUSES[status])
    assert cb.is_open("p") and cb.reason("p")


def test_breakers_are_independent_per_provider():
    cb = CircuitBreaker(threshold=1)
    cb.record_permanent_failure("apollo", "bad")
    assert cb.is_open("apollo") and not cb.is_open("hunter")


# -------------------------------------------------- end to end in a run ------

def _failing_provider(name: str, status: int | None, outcome: str):
    class _P(Provider):
        stage = "email"

        def available(self):
            return True

        def can_handle(self, rec, ctx=None):
            return True

        def _call(self, rec, ctx):
            return ProviderResult(outcome=outcome, http_status=status,
                                  detail=f"{name} scripted {status}")
    _P.name = name
    registry.register(_P)
    return _P


def _cfg(chain, providers, threshold=5):
    cfg = make_config()
    cfg.breaker_threshold = threshold
    cfg.waterfalls = {"identity": [], "email": chain, "validation": [], "phone": []}
    cfg.providers = {n: provider_cfg(n) for n in providers}
    return cfg


def test_a_bad_key_disables_the_provider_after_one_row(store):
    """The expensive bug this prevents: 2,000 identical 401s."""
    _failing_provider("br_401", 401, CallOutcome.PERMANENT_ERROR.value)
    cfg = _cfg(["br_401"], ["br_401"])
    rid = prepare_run(cfg, store, [
        lead(linkedin_url=f"https://linkedin.com/in/p{i}").inp for i in range(6)])
    pipe = Pipeline(cfg, store, rid)
    pipe.run()

    rows = store.all_rows(rid)
    first = [c for c in rows[0].calls if c.provider == "br_401"]
    assert first[0].outcome == CallOutcome.PERMANENT_ERROR.value
    later = [c for c in rows[3].calls if c.provider == "br_401"]
    assert later[0].outcome == CallOutcome.SKIPPED_PROVIDER_DOWN.value
    assert "authentication failed" in later[0].detail
    assert "br_401" in pipe.run_summary()["disabled_providers"]


def test_transient_failures_never_disable_a_healthy_provider(store):
    """A bad minute is what retries are for; it must not cost you the provider."""
    _failing_provider("br_flaky", 503, CallOutcome.TRANSIENT_ERROR.value)
    cfg = _cfg(["br_flaky"], ["br_flaky"], threshold=2)
    rid = prepare_run(cfg, store, [
        lead(linkedin_url=f"https://linkedin.com/in/t{i}").inp for i in range(5)])
    pipe = Pipeline(cfg, store, rid)
    pipe.run()

    outcomes = {c.outcome for r in store.all_rows(rid) for c in r.calls
                if c.provider == "br_flaky"}
    assert outcomes == {CallOutcome.TRANSIENT_ERROR.value}
    assert not pipe.breaker.is_open("br_flaky")


def test_a_disabled_provider_does_not_stop_the_waterfall(store):
    """The row still gets its answer from the next provider down."""
    from leadenrich.models import EmailCandidate, Ownership

    _failing_provider("br_dead", 402, CallOutcome.PERMANENT_ERROR.value)

    class _Good(Provider):
        name = "br_good"
        stage = "email"

        def available(self):
            return True

        def can_handle(self, rec, ctx=None):
            return True

        def _call(self, rec, ctx):
            return ProviderResult(outcome=CallOutcome.HIT.value, emails=[
                EmailCandidate(address="found@clinic.example", provider=self.name,
                               ownership=Ownership.PROVIDER_ASSERTED.value)])

    registry.register(_Good)
    cfg = _cfg(["br_dead", "br_good"], ["br_dead", "br_good"])
    rid = prepare_run(cfg, store, [
        lead(linkedin_url=f"https://linkedin.com/in/w{i}").inp for i in range(4)])
    Pipeline(cfg, store, rid).run()

    rows = store.all_rows(rid)
    assert all(r.email_candidates for r in rows)
    last = [c for c in rows[-1].calls if c.provider == "br_dead"]
    assert last[0].outcome == CallOutcome.SKIPPED_PROVIDER_DOWN.value
    assert last[0].estimated_credits == 0.0, "a skip is never billed"
