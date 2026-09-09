"""Provider adapter contract.

Every adapter is a small, honest translation of one documented HTTP endpoint.
Adapters do three things and nothing more:

1. Declare what input they need (``can_handle``) so the pipeline never spends a
   paid call on a row that cannot possibly match.
2. Declare whether their credentials are present (``available``) so a missing key
   is a *skip*, never a crash and never a silent fake result.
3. Translate the documented response into our vocabulary, mapping the provider's
   own status string through verbatim so the audit ledger keeps their words too.

Each concrete adapter carries ``DOC_URL`` -- the documentation page its request
shape was built from -- so any contract can be re-verified in one click.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from ..config import ProviderConfig
from ..httpclient import HttpClient, PermanentError, TransientError
from ..models import CallOutcome, EmailCandidate, PhoneCandidate, ProviderCall


@dataclass
class IdentityResult:
    full_name: str = ""
    first_name: str = ""
    last_name: str = ""
    title: str = ""
    company: str = ""
    domain: str = ""
    location: str = ""
    linkedin_url: str = ""
    source_url: str = ""
    confidence: str = "medium"
    #: Emails the identity provider volunteered (still subject to the gate).
    emails: list[tuple[str, str]] = field(default_factory=list)   # (addr, kind)
    #: Numbers the provider volunteered. ``kind`` records what the provider
    #: called it; classification into our contact types happens in the pipeline
    #: and never trusts the provider's label alone.
    phones: list[tuple[str, str]] = field(default_factory=list)   # (number, kind)


@dataclass
class ValidationResult:
    status: str = ""
    sub_status: str = ""
    score: int | None = None
    free_email: bool = False
    mx_found: bool | None = None
    catch_all: bool | None = None
    extras: dict[str, Any] = field(default_factory=dict)


@dataclass
class ProviderResult:
    outcome: str = CallOutcome.NO_MATCH.value
    identity: IdentityResult | None = None
    emails: list[EmailCandidate] = field(default_factory=list)
    phones: list[PhoneCandidate] = field(default_factory=list)
    validation: ValidationResult | None = None
    http_status: int | None = None
    detail: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def is_hit(self) -> bool:
        return self.outcome == CallOutcome.HIT.value


class Provider:
    """Base class. Subclasses implement :meth:`_call`."""

    name: str = "base"
    stage: str = "identity"          # identity | email | validation | phone
    DOC_URL: str = ""
    #: Human-readable note surfaced by ``leadenrich doctor``.
    NOTE: str = ""

    def __init__(self, cfg: ProviderConfig, http: HttpClient | None = None):
        self.cfg = cfg
        self.http = http or HttpClient(timeout=cfg.timeout)

    # -- capability declarations ------------------------------------------
    def available(self) -> bool:
        """True when every credential this adapter needs is in the environment."""
        return self.cfg.has_credentials()

    def can_handle(self, rec, ctx: dict[str, Any] | None = None) -> bool:
        """True when the row carries enough input for this endpoint to match."""
        return True

    def missing_input_reason(self, rec, ctx: dict[str, Any] | None = None) -> str:
        return "insufficient input for this provider"

    # -- execution ---------------------------------------------------------
    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:   # pragma: no cover
        raise NotImplementedError

    def execute(self, rec, ctx: dict[str, Any] | None = None
                ) -> tuple[ProviderResult, ProviderCall]:
        """Run the adapter, converting exceptions into typed outcomes.

        The pipeline relies on the distinction encoded here: a
        ``TRANSIENT_ERROR`` means the HTTP layer already retried and still
        failed, while ``NO_MATCH`` means the provider answered cleanly and had
        nothing. Both advance the waterfall, but only the first is a fault.
        """
        ctx = ctx or {}
        started = time.time()
        attempts_before = len(self.http.attempt_log)
        try:
            result = self._call(rec, ctx)
        except TransientError as exc:
            result = ProviderResult(outcome=CallOutcome.TRANSIENT_ERROR.value,
                                    http_status=getattr(exc, "status", None),
                                    detail=str(exc))
        except PermanentError as exc:
            result = ProviderResult(outcome=CallOutcome.PERMANENT_ERROR.value,
                                    http_status=getattr(exc, "status", None),
                                    detail=str(exc))
        except Exception as exc:                       # adapter bug or bad payload
            result = ProviderResult(outcome=CallOutcome.PERMANENT_ERROR.value,
                                    detail=f"adapter error: {exc}")

        attempts = max(1, len(self.http.attempt_log) - attempts_before)
        billed = result.outcome in (CallOutcome.HIT.value, CallOutcome.NO_MATCH.value)
        call = ProviderCall(
            provider=self.name,
            stage=self.stage,
            outcome=result.outcome,
            started_at=started,
            duration_ms=int((time.time() - started) * 1000),
            attempts=attempts,
            http_status=result.http_status,
            estimated_credits=self.cfg.credits_per_call if billed else 0.0,
            detail=result.detail[:500],
        )
        return result, call

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _first(*vals: Any) -> str:
        for v in vals:
            if isinstance(v, str) and v.strip():
                return v.strip()
        return ""

    def _opt(self, key: str, default: Any = None) -> Any:
        return self.cfg.options.get(key, default)


class ProviderRegistry:
    """Name -> adapter class. Populated by :mod:`leadenrich.providers`."""

    def __init__(self) -> None:
        self._classes: dict[str, type[Provider]] = {}

    def register(self, cls: type[Provider]) -> type[Provider]:
        self._classes[cls.name] = cls
        return cls

    def get(self, name: str) -> type[Provider] | None:
        return self._classes.get(name)

    def names(self) -> list[str]:
        return sorted(self._classes)

    def by_stage(self, stage: str) -> list[str]:
        return sorted(n for n, c in self._classes.items() if c.stage == stage)

    def build(self, name: str, cfg: ProviderConfig,
              http: HttpClient | None = None) -> Provider | None:
        cls = self._classes.get(name)
        return cls(cfg, http) if cls else None


registry = ProviderRegistry()
