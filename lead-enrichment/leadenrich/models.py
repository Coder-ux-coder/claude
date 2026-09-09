"""Core data model.

Every enriched value carries its own provenance. The six delivered columns are
a *view* over this ledger, never the storage format -- so a delivered cell can
always be traced back to the provider, the source URL and the moment it was
checked.
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any


# --------------------------------------------------------------------------
# Status vocabularies
# --------------------------------------------------------------------------

class FieldStatus(str, Enum):
    """Per-field outcome. Distinguishes 'we never asked' from 'nobody knew'."""

    NOT_ATTEMPTED = "not_attempted"
    NO_MATCH = "no_match"            # providers answered cleanly, had nothing
    FOUND_UNVERIFIED = "found_unverified"
    FOUND_VERIFIED = "found_verified"
    REJECTED = "rejected"            # found, then failed a quality gate
    ERROR = "error"                  # transport/provider failure, exhausted


class Deliverability(str, Enum):
    """Answers: will mail to this address land? Nothing about ownership."""

    NOT_CHECKED = "not_checked"
    DELIVERABLE = "deliverable"
    UNDELIVERABLE = "undeliverable"
    RISKY_CATCH_ALL = "risky_catch_all"
    RISKY_UNKNOWN = "risky_unknown"
    DO_NOT_MAIL = "do_not_mail"      # spamtrap / abuse / disposable / toxic


class Ownership(str, Enum):
    """Answers: does this address belong to *this* person? Never from a validator."""

    UNCONFIRMED = "unconfirmed"
    PATTERN_GUESS = "pattern_guess"          # constructed, nobody vouched
    PROVIDER_ASSERTED = "provider_asserted"  # a finder claims this person
    PUBLISHED_ON_COMPANY_SITE = "published_on_company_site"


class ContactType(str, Enum):
    """Phone classification. The labels are the compliance control.

    ``PROVIDER_SUPPLIED_UNPUBLISHED`` exists so that a provider's ``mobile_phone``
    field can be *stored and labelled honestly* rather than quietly promoted into
    the delivered Phone column as a "verified mobile".
    """

    UNKNOWN = "unknown"
    CLINIC_MAIN_LINE = "clinic_main_line"
    PUBLISHED_DIRECT_LINE = "published_direct_line"
    PUBLISHED_BUSINESS_MOBILE = "published_business_mobile"
    PROVIDER_SUPPLIED_UNPUBLISHED = "provider_supplied_unpublished"


#: Human-readable labels used in the delivered Phone column.
CONTACT_TYPE_LABELS: dict[str, str] = {
    ContactType.CLINIC_MAIN_LINE.value: "clinic main line (published)",
    ContactType.PUBLISHED_DIRECT_LINE.value: "direct business line (published)",
    ContactType.PUBLISHED_BUSINESS_MOBILE.value: "business mobile (published)",
    ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value:
        "provider-supplied, no public evidence -- NOT a verified personal mobile",
    ContactType.UNKNOWN.value: "unclassified",
}

#: Contact types that may ever appear in the delivered Phone column.
EXPORTABLE_CONTACT_TYPES = frozenset({
    ContactType.CLINIC_MAIN_LINE.value,
    ContactType.PUBLISHED_DIRECT_LINE.value,
    ContactType.PUBLISHED_BUSINESS_MOBILE.value,
})


class IdentityCheck(str, Enum):
    PASS = "pass"
    WEAK = "weak"
    CONFLICT = "conflict"
    UNRESOLVED = "unresolved"


class CallOutcome(str, Enum):
    """Why a provider call ended. ``NO_MATCH`` is a *success* of the transport."""

    HIT = "hit"
    NO_MATCH = "no_match"
    TRANSIENT_ERROR = "transient_error"   # retryable: 429, 5xx, timeout
    PERMANENT_ERROR = "permanent_error"   # 4xx that retrying cannot fix
    SKIPPED_NO_CREDENTIALS = "skipped_no_credentials"
    SKIPPED_BUDGET = "skipped_budget"
    SKIPPED_INSUFFICIENT_INPUT = "skipped_insufficient_input"


# --------------------------------------------------------------------------
# Records
# --------------------------------------------------------------------------

@dataclass
class Provenance:
    """Where a single value came from, and when."""

    provider: str = ""
    source_url: str = ""
    checked_at: float = 0.0
    evidence: str = ""
    confidence: str = "unknown"   # low | medium | high
    raw_status: str = ""          # verbatim provider status string

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class FieldValue:
    """A value plus everything needed to defend it."""

    value: str | None = None
    status: str = FieldStatus.NOT_ATTEMPTED.value
    provenance: Provenance = field(default_factory=Provenance)
    attempts: list[str] = field(default_factory=list)   # providers tried, in order

    def is_present(self) -> bool:
        return bool(self.value)

    def set(
        self,
        value: str,
        provider: str,
        *,
        status: str = FieldStatus.FOUND_UNVERIFIED.value,
        source_url: str = "",
        evidence: str = "",
        confidence: str = "medium",
        raw_status: str = "",
    ) -> None:
        self.value = value
        self.status = status
        self.provenance = Provenance(
            provider=provider,
            source_url=source_url,
            checked_at=time.time(),
            evidence=evidence,
            confidence=confidence,
            raw_status=raw_status,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "value": self.value,
            "status": self.status,
            "provenance": self.provenance.to_dict(),
            "attempts": list(self.attempts),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "FieldValue":
        return cls(
            value=d.get("value"),
            status=d.get("status", FieldStatus.NOT_ATTEMPTED.value),
            provenance=Provenance(**d.get("provenance", {})),
            attempts=list(d.get("attempts", [])),
        )


@dataclass
class EmailCandidate:
    """An email plus the two orthogonal judgements the market keeps merging."""

    address: str
    provider: str
    ownership: str = Ownership.UNCONFIRMED.value
    deliverability: str = Deliverability.NOT_CHECKED.value
    validator: str = ""
    validator_status: str = ""
    validator_sub_status: str = ""
    is_role_account: bool = False
    is_free_webmail: bool = False
    score: int | None = None
    source_urls: list[str] = field(default_factory=list)
    checked_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "EmailCandidate":
        return cls(**d)


@dataclass
class PhoneCandidate:
    """A phone number that must earn its way into the delivered column."""

    number_e164: str
    number_raw: str
    contact_type: str = ContactType.UNKNOWN.value
    provider: str = ""
    source_url: str = ""
    evidence: str = ""
    is_mobile_range: bool = False
    checked_at: float = 0.0

    def has_public_evidence(self) -> bool:
        return bool(self.source_url)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "PhoneCandidate":
        return cls(**d)


@dataclass
class ProviderCall:
    """One line of the audit ledger. Written whether or not the call helped."""

    provider: str
    stage: str
    outcome: str
    started_at: float = 0.0
    duration_ms: int = 0
    attempts: int = 1
    http_status: int | None = None
    estimated_credits: float = 0.0
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class LeadInput:
    """What the client supplies. Only ``linkedin_url`` is expected to be common."""

    row_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    linkedin_url: str = ""
    full_name: str = ""
    first_name: str = ""
    last_name: str = ""
    company: str = ""
    domain: str = ""
    location: str = ""
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class LeadRecord:
    """A row in flight, and then at rest."""

    inp: LeadInput
    name: FieldValue = field(default_factory=FieldValue)
    role: FieldValue = field(default_factory=FieldValue)
    clinic: FieldValue = field(default_factory=FieldValue)
    domain: FieldValue = field(default_factory=FieldValue)
    email: FieldValue = field(default_factory=FieldValue)
    phone: FieldValue = field(default_factory=FieldValue)

    email_candidates: list[EmailCandidate] = field(default_factory=list)
    phone_candidates: list[PhoneCandidate] = field(default_factory=list)
    calls: list[ProviderCall] = field(default_factory=list)

    identity_check: str = IdentityCheck.UNRESOLVED.value
    identity_notes: list[str] = field(default_factory=list)
    review_reasons: list[str] = field(default_factory=list)
    stages_done: list[str] = field(default_factory=list)
    duplicate_of: str = ""

    # ---------------- helpers ----------------

    def fields(self) -> dict[str, FieldValue]:
        return {
            "name": self.name, "role": self.role, "clinic": self.clinic,
            "domain": self.domain, "email": self.email, "phone": self.phone,
        }

    def needs_review(self) -> bool:
        return bool(self.review_reasons)

    def flag_review(self, reason: str) -> None:
        if reason not in self.review_reasons:
            self.review_reasons.append(reason)

    def note(self, msg: str) -> None:
        if msg not in self.identity_notes:
            self.identity_notes.append(msg)

    def log_call(self, call: ProviderCall) -> None:
        self.calls.append(call)

    def best_email(self) -> EmailCandidate | None:
        return self.email_candidates[0] if self.email_candidates else None

    def source_summary(self) -> str:
        """The delivered ``Source`` column: which provider vouched for what."""
        parts: list[str] = []
        for label, fv in (
            ("name", self.name), ("role", self.role), ("clinic", self.clinic),
            ("email", self.email), ("phone", self.phone),
        ):
            if fv.is_present() and fv.provenance.provider:
                parts.append(f"{label}:{fv.provenance.provider}")
        return "; ".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return {
            "input": self.inp.to_dict(),
            "fields": {k: v.to_dict() for k, v in self.fields().items()},
            "email_candidates": [c.to_dict() for c in self.email_candidates],
            "phone_candidates": [c.to_dict() for c in self.phone_candidates],
            "calls": [c.to_dict() for c in self.calls],
            "identity_check": self.identity_check,
            "identity_notes": list(self.identity_notes),
            "review_reasons": list(self.review_reasons),
            "stages_done": list(self.stages_done),
            "duplicate_of": self.duplicate_of,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "LeadRecord":
        rec = cls(inp=LeadInput(**d["input"]))
        for k, v in d.get("fields", {}).items():
            setattr(rec, k, FieldValue.from_dict(v))
        rec.email_candidates = [EmailCandidate.from_dict(c)
                                for c in d.get("email_candidates", [])]
        rec.phone_candidates = [PhoneCandidate.from_dict(c)
                                for c in d.get("phone_candidates", [])]
        rec.calls = [ProviderCall(**c) for c in d.get("calls", [])]
        rec.identity_check = d.get("identity_check", IdentityCheck.UNRESOLVED.value)
        rec.identity_notes = list(d.get("identity_notes", []))
        rec.review_reasons = list(d.get("review_reasons", []))
        rec.stages_done = list(d.get("stages_done", []))
        rec.duplicate_of = d.get("duplicate_of", "")
        return rec

    @classmethod
    def from_json(cls, s: str) -> "LeadRecord":
        return cls.from_dict(json.loads(s))
