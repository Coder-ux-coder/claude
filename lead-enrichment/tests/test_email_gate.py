"""The email gate: deliverability and ownership are separate, and both are required."""
from __future__ import annotations

import pytest

from leadenrich.config import EmailPolicy
from leadenrich.models import Deliverability, EmailCandidate, Ownership
from leadenrich.validation import evaluate, map_status, select_email


def cand(addr, *, deliv=Deliverability.DELIVERABLE.value,
         own=Ownership.PROVIDER_ASSERTED.value, provider="p", score=None):
    return EmailCandidate(address=addr, provider=provider, ownership=own,
                          deliverability=deliv, score=score)


# ---------------------------------------------------------------- mapping ---

@pytest.mark.parametrize("status,expected", [
    ("valid", Deliverability.DELIVERABLE.value),
    ("invalid", Deliverability.UNDELIVERABLE.value),
    ("catch-all", Deliverability.RISKY_CATCH_ALL.value),
    ("accept_all", Deliverability.RISKY_CATCH_ALL.value),
    ("unknown", Deliverability.RISKY_UNKNOWN.value),
    ("spamtrap", Deliverability.DO_NOT_MAIL.value),
    ("abuse", Deliverability.DO_NOT_MAIL.value),
    ("do_not_mail", Deliverability.DO_NOT_MAIL.value),
])
def test_provider_vocabularies_map_correctly(status, expected):
    assert map_status(status) == expected


def test_valid_via_temporary_server_condition_is_downgraded():
    """A 'valid' that came back through greylisting is not proof of a mailbox."""
    assert map_status("valid", "greylisted") == Deliverability.RISKY_UNKNOWN.value
    assert map_status("valid", "mail_server_temporary_error") == Deliverability.RISKY_UNKNOWN.value


def test_suppression_sub_status_overrides_headline_status():
    assert map_status("valid", "global_suppression") == Deliverability.DO_NOT_MAIL.value
    assert map_status("valid", "possible_traps") == Deliverability.DO_NOT_MAIL.value


def test_unrecognised_status_is_treated_as_unknown_not_valid():
    """An unfamiliar vocabulary must fail closed."""
    assert map_status("probably_fine_honestly") == Deliverability.RISKY_UNKNOWN.value


# ------------------------------------------------------------------- gate ---

def test_deliverable_and_asserted_is_accepted():
    d = evaluate(cand("anjali@clinic.example"), EmailPolicy())
    assert d.accepted


def test_catch_all_is_never_confirmed():
    """The headline rule: a catch-all domain accepts everything, so proves nothing."""
    d = evaluate(cand("x@catchall.example",
                      deliv=Deliverability.RISKY_CATCH_ALL.value), EmailPolicy())
    assert not d.accepted and "risky_catch_all" in d.reason


def test_unknown_is_never_confirmed():
    d = evaluate(cand("x@unknown.example",
                      deliv=Deliverability.RISKY_UNKNOWN.value), EmailPolicy())
    assert not d.accepted


def test_unvalidated_address_is_not_confirmed():
    """Without a validator we must not claim deliverability we never checked."""
    d = evaluate(cand("x@clinic.example",
                      deliv=Deliverability.NOT_CHECKED.value), EmailPolicy())
    assert not d.accepted and "not validated" in d.reason


def test_deliverable_but_unowned_is_rejected():
    """Deliverable is not the same as belonging to this person."""
    d = evaluate(cand("someone@clinic.example",
                      own=Ownership.UNCONFIRMED.value), EmailPolicy())
    assert not d.accepted and "ownership" in d.reason


def test_pattern_guess_cannot_pass_even_when_deliverable():
    d = evaluate(cand("first.last@clinic.example",
                      own=Ownership.PATTERN_GUESS.value), EmailPolicy())
    assert not d.accepted


@pytest.mark.parametrize("addr", ["info@clinic.example", "contact@clinic.example",
                                  "reception@clinic.example", "appointments@clinic.example"])
def test_role_mailboxes_are_rejected(addr):
    d = evaluate(cand(addr, own=Ownership.PUBLISHED_ON_COMPANY_SITE.value),
                 EmailPolicy())
    assert not d.accepted and "role" in d.reason.lower()


def test_role_rejection_can_be_switched_off():
    pol = EmailPolicy(reject_role_accounts=False)
    assert evaluate(cand("info@clinic.example",
                         own=Ownership.PUBLISHED_ON_COMPANY_SITE.value), pol).accepted


def test_free_webmail_allowed_by_default_because_indian_clinics_use_it():
    """Many independent Indian clinics legitimately run on Gmail."""
    assert evaluate(cand("drmeera@gmail.com"), EmailPolicy()).accepted
    assert not evaluate(cand("drmeera@gmail.com"),
                        EmailPolicy(reject_free_webmail=True)).accepted


def test_minimum_finder_score_is_enforced():
    pol = EmailPolicy(min_finder_score=80)
    assert not evaluate(cand("a@clinic.example", score=55), pol).accepted
    assert evaluate(cand("a@clinic.example", score=95), pol).accepted


def test_malformed_address_fails_syntax_first():
    assert not evaluate(cand("not-an-email"), EmailPolicy()).accepted


# -------------------------------------------------------------- selection ---

def test_selection_prefers_the_first_acceptable_and_keeps_the_rest():
    accepted, risky, reasons = select_email([
        cand("info@clinic.example", own=Ownership.PUBLISHED_ON_COMPANY_SITE.value),
        cand("x@catchall.example", deliv=Deliverability.RISKY_CATCH_ALL.value),
        cand("anjali@clinic.example"),
    ], EmailPolicy())
    assert accepted.address == "anjali@clinic.example"
    assert [r.address for r in risky] == ["x@catchall.example"]
    assert len(reasons) == 2, "both rejections must be recorded, not discarded"


def test_nothing_acceptable_returns_none_and_explains_why():
    accepted, risky, reasons = select_email(
        [cand("x@catchall.example", deliv=Deliverability.RISKY_CATCH_ALL.value)],
        EmailPolicy())
    assert accepted is None
    assert risky and reasons


def test_risky_export_is_opt_in_and_never_silent(store):
    """With export_risky on, a risky address ships -- but labelled and flagged."""
    from conftest import lead, make_config, provider_cfg
    from leadenrich.models import CallOutcome, FieldStatus
    from leadenrich.pipeline import Pipeline, prepare_run
    from leadenrich.providers.base import Provider, ProviderResult, ValidationResult, registry

    class _Finder(Provider):
        name = "risky_finder"
        stage = "email"

        def available(self):
            return True

        def can_handle(self, rec, ctx=None):
            return True

        def _call(self, rec, ctx):
            return ProviderResult(outcome=CallOutcome.HIT.value, emails=[
                EmailCandidate(address="maybe@catchall.example", provider=self.name,
                               ownership=Ownership.PROVIDER_ASSERTED.value)])

    class _CatchAll(Provider):
        name = "catchall_validator"
        stage = "validation"

        def available(self):
            return True

        def can_handle(self, rec, ctx=None):
            return bool((ctx or {}).get("email"))

        def _call(self, rec, ctx):
            return ProviderResult(outcome=CallOutcome.HIT.value,
                                  validation=ValidationResult(status="catch-all"))

    registry.register(_Finder)
    registry.register(_CatchAll)

    cfg = make_config()
    cfg.waterfalls = {"identity": [], "email": ["risky_finder"],
                      "validation": ["catchall_validator"], "phone": []}
    cfg.providers = {n: provider_cfg(n) for n in ("risky_finder", "catchall_validator")}

    # Default policy: withheld.
    rid = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/a").inp])
    Pipeline(cfg, store, rid).run()
    rec = store.all_rows(rid)[0]
    assert rec.email.value is None
    assert rec.email.status == FieldStatus.REJECTED.value

    # Opt in: shipped, but marked unverified and pushed to review.
    cfg.email_policy.export_risky = True
    rid2 = prepare_run(cfg, store, [lead(linkedin_url="https://linkedin.com/in/b").inp])
    Pipeline(cfg, store, rid2).run()
    rec2 = store.all_rows(rid2)[0]
    assert rec2.email.value == "maybe@catchall.example"
    assert rec2.email.status == FieldStatus.FOUND_UNVERIFIED.value
    assert "RISKY" in rec2.email.provenance.evidence
    assert rec2.needs_review()
