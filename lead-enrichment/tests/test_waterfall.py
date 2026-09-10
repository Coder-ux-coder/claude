"""The waterfall itself: A -> B -> C, and every reason a provider is skipped."""
from __future__ import annotations

import pytest

from conftest import lead, make_config, provider_cfg
from leadenrich.models import (CallOutcome, Deliverability, EmailCandidate,
                               FieldStatus, Ownership)
from leadenrich.pipeline import Pipeline, prepare_run
from leadenrich.providers.base import Provider, ProviderResult, registry


def _email_provider(name: str, *, hit: bool, address: str = "",
                    credentials: bool = True, outcome: str | None = None):
    """Build and register a scripted email provider for one test."""
    class _P(Provider):
        stage = "email"
        NOTE = "test double"

        def available(self):
            return credentials

        def can_handle(self, rec, ctx=None):
            return True

        def _call(self, rec, ctx):
            if outcome:
                return ProviderResult(outcome=outcome, detail=f"{name} scripted")
            if not hit:
                return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                      detail=f"{name} had nothing")
            return ProviderResult(
                outcome=CallOutcome.HIT.value,
                emails=[EmailCandidate(address=address, provider=name,
                                       ownership=Ownership.PROVIDER_ASSERTED.value)])
    _P.name = name
    registry.register(_P)
    return _P


class _AlwaysValid(Provider):
    name = "always_valid"
    stage = "validation"

    def available(self):
        return True

    def can_handle(self, rec, ctx=None):
        return bool((ctx or {}).get("email"))

    def _call(self, rec, ctx):
        from leadenrich.providers.base import ValidationResult
        return ProviderResult(outcome=CallOutcome.HIT.value,
                              validation=ValidationResult(status="valid"))


registry.register(_AlwaysValid)


def _cfg(email_chain, providers):
    cfg = make_config()
    cfg.waterfalls = {"identity": [], "email": email_chain,
                      "validation": ["always_valid"], "phone": []}
    cfg.providers = {n: provider_cfg(n) for n in list(providers) + ["always_valid"]}
    return cfg


def test_third_provider_wins_when_first_two_miss(store):
    """A misses, B misses, C answers -- the classic reason waterfalls exist."""
    _email_provider("wf_a", hit=False)
    _email_provider("wf_b", hit=False)
    _email_provider("wf_c", hit=True, address="found@clinic.example")

    cfg = _cfg(["wf_a", "wf_b", "wf_c"], ["wf_a", "wf_b", "wf_c"])
    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/x").inp])
    Pipeline(cfg, store, rid).run()

    rec = store.all_rows(rid)[0]
    assert rec.email.value == "found@clinic.example"
    assert rec.email.provenance.provider == "wf_c"
    outcomes = {c.provider: c.outcome for c in rec.calls}
    assert outcomes["wf_a"] == CallOutcome.NO_MATCH.value
    assert outcomes["wf_b"] == CallOutcome.NO_MATCH.value
    assert outcomes["wf_c"] == CallOutcome.HIT.value


def test_first_hit_short_circuits_the_rest(store):
    """Once an address is found, later providers must not be paid for."""
    _email_provider("sc_a", hit=True, address="first@clinic.example")
    _email_provider("sc_b", hit=True, address="second@clinic.example")

    cfg = _cfg(["sc_a", "sc_b"], ["sc_a", "sc_b"])
    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/y").inp])
    Pipeline(cfg, store, rid).run()

    rec = store.all_rows(rid)[0]
    assert rec.email.value == "first@clinic.example"
    called = [c.provider for c in rec.calls if c.stage == "email"]
    assert "sc_b" not in called, "second provider should never have been called"


def test_missing_credentials_skips_not_fails(store):
    """A provider with no key is stepped over; the chain still delivers."""
    _email_provider("nc_a", hit=True, address="a@x.example", credentials=False)
    _email_provider("nc_b", hit=True, address="b@x.example")

    cfg = _cfg(["nc_a", "nc_b"], ["nc_a", "nc_b"])
    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/z").inp])
    Pipeline(cfg, store, rid).run()

    rec = store.all_rows(rid)[0]
    assert rec.email.value == "b@x.example"
    skipped = [c for c in rec.calls if c.provider == "nc_a"]
    assert skipped[0].outcome == CallOutcome.SKIPPED_NO_CREDENTIALS.value
    assert skipped[0].estimated_credits == 0.0, "a skip must never be billed"


def test_transient_failure_advances_to_next_provider(store):
    """Provider A dies on transport; B still gets its turn in the same row."""
    _email_provider("tr_a", hit=False, outcome=CallOutcome.TRANSIENT_ERROR.value)
    _email_provider("tr_b", hit=True, address="rescued@clinic.example")

    cfg = _cfg(["tr_a", "tr_b"], ["tr_a", "tr_b"])
    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/q").inp])
    Pipeline(cfg, store, rid).run()

    rec = store.all_rows(rid)[0]
    assert rec.email.value == "rescued@clinic.example"
    a_call = next(c for c in rec.calls if c.provider == "tr_a")
    assert a_call.outcome == CallOutcome.TRANSIENT_ERROR.value
    assert a_call.estimated_credits == 0.0, "a failed call must not be billed"


def test_budget_cap_skips_provider_without_failing_row(store):
    """A tripped cap is a skip, so the row continues down cheaper providers."""
    _email_provider("bg_a", hit=True, address="expensive@x.example")
    _email_provider("bg_b", hit=True, address="cheap@x.example")

    cfg = _cfg(["bg_a", "bg_b"], ["bg_a", "bg_b"])
    cfg.budget.per_provider = {"bg_a": 1}
    rid = prepare_run(cfg, store, [
        lead(linkedin_url="https://linkedin.com/in/p1").inp,
        lead(linkedin_url="https://linkedin.com/in/p2").inp])
    Pipeline(cfg, store, rid).run()

    rows = store.all_rows(rid)
    assert rows[0].email.value == "expensive@x.example"
    assert rows[1].email.value == "cheap@x.example", "second row falls through to B"
    skip = next(c for c in rows[1].calls if c.provider == "bg_a")
    assert skip.outcome == CallOutcome.SKIPPED_BUDGET.value


def test_no_provider_finds_anything_is_a_clean_no_match(store):
    """Nothing found is a recorded outcome with a review reason, not an error."""
    _email_provider("nm_a", hit=False)
    _email_provider("nm_b", hit=False)

    cfg = _cfg(["nm_a", "nm_b"], ["nm_a", "nm_b"])
    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/n").inp])
    Pipeline(cfg, store, rid).run()

    rec = store.all_rows(rid)[0]
    assert rec.email.value is None
    assert rec.email.status == FieldStatus.NO_MATCH.value
    assert any("no email found" in r for r in rec.review_reasons)


def test_insufficient_input_is_skipped_before_spending(store):
    """A provider that needs a domain is not paid to fail on a row without one."""
    class _NeedsDomain(Provider):
        name = "needs_domain"
        stage = "email"

        def available(self):
            return True

        def can_handle(self, rec, ctx=None):
            return bool((ctx or {}).get("domain"))

        def missing_input_reason(self, rec, ctx=None):
            return "needs a company domain"

        def _call(self, rec, ctx):
            raise AssertionError("must not be called without a domain")

    registry.register(_NeedsDomain)
    cfg = _cfg(["needs_domain"], ["needs_domain"])
    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/d").inp])
    Pipeline(cfg, store, rid).run()

    rec = store.all_rows(rid)[0]
    call = next(c for c in rec.calls if c.provider == "needs_domain")
    assert call.outcome == CallOutcome.SKIPPED_INSUFFICIENT_INPUT.value
    assert "domain" in call.detail
