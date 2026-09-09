"""Resumability: a killed run must not re-buy work it already paid for."""
from __future__ import annotations

import pytest

from conftest import lead, make_config, provider_cfg
from leadenrich.models import CallOutcome, EmailCandidate, Ownership
from leadenrich.pipeline import Pipeline, prepare_run
from leadenrich.providers.base import (IdentityResult, Provider, ProviderResult,
                                       ValidationResult, registry)

CALLS: dict[str, int] = {}


class _CountingIdentity(Provider):
    name = "counting_identity"
    stage = "identity"

    def available(self):
        return True

    def can_handle(self, rec, ctx=None):
        return True

    def _call(self, rec, ctx):
        CALLS[self.name] = CALLS.get(self.name, 0) + 1
        return ProviderResult(outcome=CallOutcome.HIT.value, identity=IdentityResult(
            full_name="Dr Anaya Varma", title="Founder", company="Meridian Skin Clinic",
            domain="meridianskin.example", confidence="high"))


class _CountingEmail(Provider):
    name = "counting_email"
    stage = "email"

    def available(self):
        return True

    def can_handle(self, rec, ctx=None):
        return True

    def _call(self, rec, ctx):
        CALLS[self.name] = CALLS.get(self.name, 0) + 1
        return ProviderResult(outcome=CallOutcome.HIT.value, emails=[
            EmailCandidate(address="anaya@meridianskin.example", provider=self.name,
                           ownership=Ownership.PROVIDER_ASSERTED.value)])


class _CountingValidator(Provider):
    name = "counting_validator"
    stage = "validation"

    def available(self):
        return True

    def can_handle(self, rec, ctx=None):
        return bool((ctx or {}).get("email"))

    def _call(self, rec, ctx):
        CALLS[self.name] = CALLS.get(self.name, 0) + 1
        return ProviderResult(outcome=CallOutcome.HIT.value,
                              validation=ValidationResult(status="valid"))


for cls in (_CountingIdentity, _CountingEmail, _CountingValidator):
    registry.register(cls)


@pytest.fixture(autouse=True)
def reset_counts():
    CALLS.clear()
    yield


def _cfg():
    cfg = make_config()
    cfg.waterfalls = {"identity": ["counting_identity"], "email": ["counting_email"],
                      "validation": ["counting_validator"], "phone": []}
    cfg.providers = {n: provider_cfg(n) for n in
                     ("counting_identity", "counting_email", "counting_validator")}
    return cfg


def test_completed_rows_are_not_reprocessed(store):
    """Re-running a finished run must make zero further provider calls."""
    cfg = _cfg()
    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/a").inp,
                                   lead(linkedin_url="https://linkedin.com/in/b").inp])
    Pipeline(cfg, store, rid).run()
    first_pass = dict(CALLS)
    assert first_pass["counting_email"] == 2

    assert store.pending_rows(rid) == [], "all rows should be marked done"
    Pipeline(cfg, store, rid).run()
    assert CALLS == first_pass, "a second run must not re-call any provider"


def test_interrupted_run_resumes_only_the_remaining_rows(store):
    """Process half, then resume: the finished half is never re-enriched."""
    cfg = _cfg()
    inputs = [lead(linkedin_url=f"https://linkedin.com/in/p{i}").inp for i in range(6)]
    rid = prepare_run(cfg, store, inputs)

    Pipeline(cfg, store, rid).run(limit=2)
    assert CALLS["counting_email"] == 2
    assert len(store.pending_rows(rid)) == 4

    Pipeline(cfg, store, rid).run()
    assert CALLS["counting_email"] == 6, "each row enriched exactly once overall"
    assert store.pending_rows(rid) == []


def test_reseeding_a_run_never_resets_finished_rows(store):
    """prepare_run is idempotent -- pointing at the same run keeps progress."""
    cfg = _cfg()
    inputs = [lead(linkedin_url="https://linkedin.com/in/a").inp]
    rid = prepare_run(cfg, store, inputs)
    Pipeline(cfg, store, rid).run()
    assert CALLS["counting_email"] == 1

    prepare_run(cfg, store, inputs, run_id=rid)
    assert store.pending_rows(rid) == []
    Pipeline(cfg, store, rid).run()
    assert CALLS["counting_email"] == 1


def test_partial_stage_progress_survives_a_crash(store):
    """A row that crashed mid-run resumes from its next unfinished stage."""
    cfg = _cfg()
    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/c").inp])
    pipe = Pipeline(cfg, store, rid)
    rec = store.pending_rows(rid)[0]

    # Complete just the identity stage, as an interrupted process would leave it.
    ctx = {}
    pipe.stage_identity(rec, ctx)
    rec.stages_done.append("identity")
    store.upsert_row(rid, rec, "in_progress")
    assert CALLS["counting_identity"] == 1

    Pipeline(cfg, store, rid).run()
    assert CALLS["counting_identity"] == 1, "identity must not run twice"
    assert CALLS["counting_email"] == 1, "the remaining stages must still run"
    assert store.all_rows(rid)[0].email.value == "anaya@meridianskin.example"


def test_budget_state_is_persisted_across_runs(store):
    cfg = _cfg()
    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/a").inp])
    Pipeline(cfg, store, rid).run()
    saved = store.load_budget(rid)
    assert saved["total_requests"] == 3
    assert saved["per_provider_requests"]["counting_email"] == 1
