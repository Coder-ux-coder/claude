"""Cross-provider identity checking -- catching a wrong match before it ships."""
from __future__ import annotations

from conftest import lead, make_config, provider_cfg
from leadenrich.models import CallOutcome, IdentityCheck
from leadenrich.pipeline import Pipeline, prepare_run
from leadenrich.providers.base import (IdentityResult, Provider, ProviderResult,
                                       registry)


def _identity_provider(name: str, **identity_kw):
    class _P(Provider):
        stage = "identity"

        def available(self):
            return True

        def can_handle(self, rec, ctx=None):
            return True

        def _call(self, rec, ctx):
            return ProviderResult(outcome=CallOutcome.HIT.value,
                                  identity=IdentityResult(**identity_kw))
    _P.name = name
    registry.register(_P)
    return _P


def _run(store, chain, providers, corroborate=True, **lead_kw):
    cfg = make_config()
    # These tests are about cross-provider agreement, so every provider is asked.
    cfg.identity_corroboration = corroborate
    cfg.waterfalls = {"identity": chain, "email": [], "validation": [], "phone": []}
    cfg.providers = {n: provider_cfg(n) for n in providers}
    rid = prepare_run(cfg, store, [lead(**lead_kw).inp])
    Pipeline(cfg, store, rid).run()
    return store.all_rows(rid)[0]


def test_agreeing_providers_pass(store):
    _identity_provider("ic_a1", full_name="Dr Anaya Varma", title="Founder",
                       company="Meridian Skin Clinic", confidence="high")
    _identity_provider("ic_b1", full_name="Anaya Varma MBBS",
                       company="Meridian Skin Clinic Pvt Ltd", confidence="high")
    rec = _run(store, ["ic_a1", "ic_b1"], ["ic_a1", "ic_b1"],
               linkedin_url="https://linkedin.com/in/a")
    assert rec.identity_check == IdentityCheck.PASS.value
    assert not any("identity" in r or "disagreement" in r
                   for r in rec.review_reasons), \
        "agreement must not raise an identity flag"


def test_disagreeing_names_raise_a_conflict(store):
    _identity_provider("ic_a2", full_name="Dr Anaya Varma", title="Founder",
                       company="Meridian Skin Clinic", confidence="high")
    _identity_provider("ic_b2", full_name="Rohan Desai",
                       company="Meridian Skin Clinic", confidence="high")
    rec = _run(store, ["ic_a2", "ic_b2"], ["ic_a2", "ic_b2"],
               linkedin_url="https://linkedin.com/in/b")
    assert rec.identity_check == IdentityCheck.CONFLICT.value
    assert rec.needs_review()
    assert any("name disagreement" in n for n in rec.identity_notes)


def test_disagreeing_employers_raise_a_conflict(store):
    _identity_provider("ic_a3", full_name="Dr Anaya Varma", title="Founder",
                       company="Meridian Skin Clinic", confidence="high")
    _identity_provider("ic_b3", full_name="Dr Anaya Varma",
                       company="Aurora Eye Care", confidence="high")
    rec = _run(store, ["ic_a3", "ic_b3"], ["ic_a3", "ic_b3"],
               linkedin_url="https://linkedin.com/in/c")
    assert rec.identity_check == IdentityCheck.CONFLICT.value
    assert any("employer disagreement" in n for n in rec.identity_notes)


def test_a_name_from_the_slug_alone_is_only_weak_evidence(store):
    """The free fallback must never masquerade as a confirmed identity."""
    rec = _run(store, ["linkedin_slug"], ["linkedin_slug"],
               linkedin_url="https://linkedin.com/in/dr-anjali-mehta-8b41a2")
    assert rec.name.value == "Anjali Mehta"
    assert rec.identity_check == IdentityCheck.WEAK.value
    assert rec.needs_review()
    assert any("derived only from the profile handle" in n for n in rec.identity_notes)


def test_non_clinic_employer_is_flagged_as_out_of_scope(store):
    _identity_provider("ic_soft", full_name="Arjun Menon", title="CEO",
                       company="Acme Software Pvt Ltd", confidence="high")
    rec = _run(store, ["ic_soft"], ["ic_soft"], linkedin_url="https://linkedin.com/in/d")
    assert rec.identity_check == IdentityCheck.WEAK.value
    assert any("does not read as a clinic" in n for n in rec.identity_notes)


def test_unresolvable_profile_is_queued_not_invented(store):
    class _Miss(Provider):
        name = "ic_miss"
        stage = "identity"

        def available(self):
            return True

        def can_handle(self, rec, ctx=None):
            return True

        def _call(self, rec, ctx):
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value)

    registry.register(_Miss)
    rec = _run(store, ["ic_miss"], ["ic_miss"], linkedin_url="https://linkedin.com/in/")
    assert rec.name.value is None
    assert rec.identity_check == IdentityCheck.UNRESOLVED.value
    assert any("identity unresolved" in r for r in rec.review_reasons)


def test_client_supplied_values_are_trusted_and_never_overwritten(store):
    _identity_provider("ic_wrong", full_name="Someone Else",
                       company="Wrong Clinic", confidence="high")
    rec = _run(store, ["ic_wrong"], ["ic_wrong"],
               linkedin_url="https://linkedin.com/in/e",
               full_name="Dr Anaya Varma", company="Meridian Skin Clinic")
    assert rec.name.value == "Dr Anaya Varma"
    assert rec.name.provenance.provider == "client_input"
    assert rec.clinic.value == "Meridian Skin Clinic"
    assert rec.identity_check == IdentityCheck.CONFLICT.value, \
        "the disagreement must still be surfaced, not hidden"
