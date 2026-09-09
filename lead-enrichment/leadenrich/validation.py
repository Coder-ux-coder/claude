"""The email gate.

Two judgements are kept strictly apart, because the market routinely merges them
and that merge is what produces "verified" lists that bounce:

* **Deliverability** -- will mail land? Answered by a validator (SMTP/MX probing).
* **Ownership**      -- is this *that person's* mailbox? Answered only by who
  asserted the address and on what evidence. A validator can never answer it.

A catch-all domain accepts every address, so it proves neither. Catch-all and
unknown are therefore ``risky`` and are withheld from the delivered Email column
by default.
"""
from __future__ import annotations

from dataclasses import dataclass

from .models import Deliverability, EmailCandidate, Ownership
from .normalize import is_free_webmail, is_role_account, valid_email_syntax

# --------------------------------------------------------------------------
# Validator vocabularies -> our internal deliverability classes.
# ZeroBounce: valid | invalid | catch-all | unknown | spamtrap | abuse | do_not_mail
# Hunter:     valid | invalid | accept_all | webmail | disposable | unknown
# --------------------------------------------------------------------------
STATUS_MAP: dict[str, str] = {
    "valid": Deliverability.DELIVERABLE.value,
    "deliverable": Deliverability.DELIVERABLE.value,
    "ok": Deliverability.DELIVERABLE.value,

    "invalid": Deliverability.UNDELIVERABLE.value,
    "undeliverable": Deliverability.UNDELIVERABLE.value,
    "not_found": Deliverability.UNDELIVERABLE.value,

    "catch-all": Deliverability.RISKY_CATCH_ALL.value,
    "catch_all": Deliverability.RISKY_CATCH_ALL.value,
    "catchall": Deliverability.RISKY_CATCH_ALL.value,
    "accept_all": Deliverability.RISKY_CATCH_ALL.value,
    "accept-all": Deliverability.RISKY_CATCH_ALL.value,

    "unknown": Deliverability.RISKY_UNKNOWN.value,
    "risky": Deliverability.RISKY_UNKNOWN.value,
    "webmail": Deliverability.RISKY_UNKNOWN.value,

    "spamtrap": Deliverability.DO_NOT_MAIL.value,
    "abuse": Deliverability.DO_NOT_MAIL.value,
    "do_not_mail": Deliverability.DO_NOT_MAIL.value,
    "disposable": Deliverability.DO_NOT_MAIL.value,
    "toxic": Deliverability.DO_NOT_MAIL.value,
}

#: ZeroBounce sub-statuses that mean "the server would not answer right now".
#: These are temporary conditions, not evidence of a working mailbox.
TEMPORARY_SUB_STATUSES = frozenset({
    "greylisted", "antispam_system", "mail_server_temporary_error",
    "mail_server_did_not_respond", "timeout_exceeded", "forcible_disconnect",
    "failed_smtp_connection", "exception_occurred",
})
#: Sub-statuses that should never be mailed regardless of the headline status.
SUPPRESS_SUB_STATUSES = frozenset({
    "global_suppression", "possible_traps", "toxic", "disposable",
    "mailbox_quota_exceeded",
})


def map_status(status: str, sub_status: str = "") -> str:
    """Map a provider's vocabulary onto our deliverability classes."""
    s = (status or "").strip().lower().replace(" ", "_")
    sub = (sub_status or "").strip().lower()
    if sub in SUPPRESS_SUB_STATUSES:
        return Deliverability.DO_NOT_MAIL.value
    mapped = STATUS_MAP.get(s, Deliverability.RISKY_UNKNOWN.value)
    # A "valid" that arrived through a temporary server condition is not proof.
    if mapped == Deliverability.DELIVERABLE.value and sub in TEMPORARY_SUB_STATUSES:
        return Deliverability.RISKY_UNKNOWN.value
    return mapped


@dataclass
class GateDecision:
    accepted: bool
    reason: str
    deliverability: str
    ownership: str
    is_role_account: bool = False
    is_free_webmail: bool = False


def evaluate(candidate: EmailCandidate, policy) -> GateDecision:
    """Decide whether one candidate may occupy the delivered Email column."""
    addr = (candidate.address or "").strip()

    if not valid_email_syntax(addr):
        return GateDecision(False, "failed syntax check",
                            candidate.deliverability, candidate.ownership)

    role = is_role_account(addr)
    webmail = is_free_webmail(addr)
    deliv = candidate.deliverability or Deliverability.NOT_CHECKED.value
    owner = candidate.ownership or Ownership.UNCONFIRMED.value

    if getattr(policy, "reject_role_accounts", True) and role:
        return GateDecision(
            False,
            "role/shared mailbox (info@, contact@ ...) -- deliverable but not a "
            "named decision-maker's mailbox",
            deliv, owner, role, webmail)

    if getattr(policy, "reject_free_webmail", False) and webmail:
        return GateDecision(False, "free webmail address rejected by policy",
                            deliv, owner, role, webmail)

    if getattr(policy, "require_validation", True):
        if deliv == Deliverability.NOT_CHECKED.value:
            return GateDecision(
                False,
                "not validated -- no live validation was performed "
                "(no validator credentials configured)",
                deliv, owner, role, webmail)
        if deliv not in set(getattr(policy, "accept_deliverability",
                                    [Deliverability.DELIVERABLE.value])):
            return GateDecision(False, f"deliverability={deliv} not accepted",
                                deliv, owner, role, webmail)

    accept_own = set(getattr(policy, "accept_ownership", [
        Ownership.PROVIDER_ASSERTED.value,
        Ownership.PUBLISHED_ON_COMPANY_SITE.value]))
    if owner not in accept_own:
        return GateDecision(
            False,
            f"ownership={owner} -- deliverable is not the same as belonging to "
            f"this person",
            deliv, owner, role, webmail)

    min_score = int(getattr(policy, "min_finder_score", 0) or 0)
    if min_score and candidate.score is not None and candidate.score < min_score:
        return GateDecision(False,
                            f"finder confidence {candidate.score} < {min_score}",
                            deliv, owner, role, webmail)

    return GateDecision(True, "deliverable and ownership-attributed",
                        deliv, owner, role, webmail)


def select_email(candidates: list[EmailCandidate], policy
                 ) -> tuple[EmailCandidate | None, list[EmailCandidate], list[str]]:
    """Split candidates into (accepted, risky-but-kept, rejection reasons).

    ``risky`` rows are retained for the review queue and are exported only when
    ``email_policy.export_risky`` is switched on -- and even then they are
    labelled, never presented as confirmed.
    """
    accepted: EmailCandidate | None = None
    risky: list[EmailCandidate] = []
    reasons: list[str] = []

    for c in candidates:
        d = evaluate(c, policy)
        c.is_role_account = d.is_role_account
        c.is_free_webmail = d.is_free_webmail
        if d.accepted and accepted is None:
            accepted = c
            continue
        reasons.append(f"{c.address} [{c.provider}]: {d.reason}")
        if d.deliverability in (Deliverability.RISKY_CATCH_ALL.value,
                                Deliverability.RISKY_UNKNOWN.value):
            risky.append(c)

    return accepted, risky, reasons
