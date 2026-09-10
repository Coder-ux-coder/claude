"""Email validators.

These answer exactly one question -- *will mail to this address land?* -- and
nothing about whether the address belongs to the named person. That separation is
enforced in :mod:`leadenrich.validation`; the adapters here only translate the
provider's vocabulary faithfully, including the sub-status, which is where the
"valid, but only because the server greylisted us" cases hide.
"""
from __future__ import annotations

from typing import Any

from ..models import CallOutcome
from .base import Provider, ProviderResult, ValidationResult, registry


@registry.register
class ZeroBounceValidator(Provider):
    """ZeroBounce -- ``GET /v2/validate``.

    Documented statuses: ``valid, invalid, catch-all, unknown, spamtrap, abuse,
    do_not_mail``; disposable and toxic now sit under ``do_not_mail`` with the
    matching sub-status. ZeroBounce documents that **no credit is consumed for an
    ``unknown`` result**, which removes the last excuse for skipping validation.
    """

    name = "zerobounce"
    stage = "validation"
    DOC_URL = "https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails"
    NOTE = "No credit charged for 'unknown' results (per vendor docs)."
    ENDPOINT = "https://api.zerobounce.net/v2/validate"

    def can_handle(self, rec, ctx=None) -> bool:
        return bool((ctx or {}).get("email"))

    def missing_input_reason(self, rec, ctx=None) -> str:
        return "no email address to validate"

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        resp = self.http.get(
            self.ENDPOINT,
            params={"api_key": self.cfg.api_key() or "",
                    "email": ctx.get("email", ""),
                    "ip_address": ""},
            timeout=self.cfg.timeout)
        body = resp.json_body if isinstance(resp.json_body, dict) else {}
        status = str(body.get("status", "") or "")
        if not status:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status,
                                  detail="no status field in response")
        return ProviderResult(
            outcome=CallOutcome.HIT.value, http_status=resp.status,
            validation=ValidationResult(
                status=status,
                sub_status=str(body.get("sub_status", "") or ""),
                free_email=bool(body.get("free_email", False)),
                mx_found=(str(body.get("mx_found", "")).lower() == "true"
                          if body.get("mx_found") is not None else None),
                catch_all=(status.lower() in ("catch-all", "catch_all")),
                extras={k: body.get(k) for k in
                        ("domain_age_days", "smtp_provider", "did_you_mean",
                         "firstname", "lastname") if k in body},
            ),
            detail=f"{status}/{body.get('sub_status', '')}")


@registry.register
class HunterVerifier(Provider):
    """Hunter Email Verifier -- ``GET /v2/email-verifier``.

    Returns a status plus a 0-100 score and the booleans ``accept_all``,
    ``disposable``, ``webmail``, ``gibberish``, ``mx_records``, ``smtp_check``.
    A **202** means the check is still running; the same URL is polled.
    """

    name = "hunter_verifier"
    stage = "validation"
    DOC_URL = "https://hunter.io/api/email-verifier"
    NOTE = "HTTP 202 means 'still checking' -- poll the same URL."
    ENDPOINT = "https://api.hunter.io/v2/email-verifier"

    def can_handle(self, rec, ctx=None) -> bool:
        return bool((ctx or {}).get("email"))

    def missing_input_reason(self, rec, ctx=None) -> str:
        return "no email address to validate"

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        import time as _t
        params = {"api_key": self.cfg.api_key() or "", "email": ctx.get("email", "")}
        max_polls = int(self._opt("max_polls", 4))
        interval = float(self._opt("poll_interval", 3.0))

        resp = self.http.get(self.ENDPOINT, params=params, timeout=self.cfg.timeout)
        polls = 0
        while resp.status == 202 and polls < max_polls:
            _t.sleep(interval)
            resp = self.http.get(self.ENDPOINT, params=params, timeout=self.cfg.timeout)
            polls += 1
        if resp.status == 202:
            return ProviderResult(outcome=CallOutcome.TRANSIENT_ERROR.value,
                                  http_status=202,
                                  detail="verification still pending after polling")

        data = resp.get("data", default={}) or {}
        status = str(data.get("status", "") or "")
        if not status:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status, detail="no status field")
        # Hunter reports accept-all as a boolean alongside the status; fold it in
        # so a catch-all can never be mistaken for a confirmed mailbox.
        if data.get("accept_all") and status.lower() == "valid":
            status = "accept_all"
        return ProviderResult(
            outcome=CallOutcome.HIT.value, http_status=resp.status,
            validation=ValidationResult(
                status=status,
                sub_status=("disposable" if data.get("disposable") else
                            "gibberish" if data.get("gibberish") else ""),
                score=data.get("score"),
                free_email=bool(data.get("webmail", False)),
                mx_found=data.get("mx_records"),
                catch_all=bool(data.get("accept_all", False)),
                extras={k: data.get(k) for k in ("smtp_check", "block", "regexp")
                        if k in data},
            ),
            detail=f"{status} score={data.get('score')}")
