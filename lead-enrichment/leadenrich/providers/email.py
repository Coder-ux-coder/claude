"""Email discovery waterfall adapters.

Ordering is configuration, not code -- see ``waterfalls.email`` in
``config/pipeline.yml``. Each adapter reports ``NO_MATCH`` cleanly when the
provider answers but has nothing, which is what lets the pipeline advance to the
next provider immediately instead of retrying a settled question.

Every candidate is stamped with ``ownership``. A finder that names the person is
``provider_asserted``; a pattern constructed locally would be ``pattern_guess``
and cannot pass the gate. Nothing here sets deliverability -- that is the
validator's job alone.
"""
from __future__ import annotations

from typing import Any

from ..models import CallOutcome, EmailCandidate, Ownership
from ..normalize import (canonical_linkedin_url, linkedin_slug, normalise_domain,
                         split_name, valid_email_syntax)
from .base import Provider, ProviderResult, registry


class _EmailProvider(Provider):
    """Shared helpers for the discovery stage."""

    stage = "email"

    def _names(self, rec, ctx: dict[str, Any]) -> tuple[str, str]:
        first = rec.inp.first_name or ""
        last = rec.inp.last_name or ""
        if not (first and last):
            full = ctx.get("full_name") or rec.name.value or rec.inp.full_name or ""
            f2, l2 = split_name(full)
            first, last = first or f2, last or l2
        return first, last

    def _domain(self, rec, ctx: dict[str, Any]) -> str:
        return normalise_domain(
            ctx.get("domain") or rec.domain.value or rec.inp.domain or "")

    def _company(self, rec, ctx: dict[str, Any]) -> str:
        return ctx.get("company") or rec.clinic.value or rec.inp.company or ""

    def _needs_name_and_domain(self, rec, ctx=None) -> bool:
        ctx = ctx or {}
        first, last = self._names(rec, ctx)
        return bool(first and last and (self._domain(rec, ctx) or self._company(rec, ctx)))

    def missing_input_reason(self, rec, ctx=None) -> str:
        return "needs a person name plus a company domain (or company name)"

    def _candidate(self, addr: str, *, score: int | None = None,
                   sources: list[str] | None = None,
                   ownership: str = Ownership.PROVIDER_ASSERTED.value
                   ) -> EmailCandidate | None:
        import time as _t
        addr = (addr or "").strip().lower()
        if not valid_email_syntax(addr):
            return None
        return EmailCandidate(address=addr, provider=self.name, ownership=ownership,
                              score=score, source_urls=sources or [],
                              checked_at=_t.time())


@registry.register
class ProspeoProvider(_EmailProvider):
    """Prospeo LinkedIn Email Finder -- ``POST /linkedin-email-finder``.

    Placed first in the default order because it consumes a LinkedIn URL
    directly, so it can run before identity resolution has produced a domain.
    """

    name = "prospeo"
    DOC_URL = "https://prospeo.io/api/linkedin-email-finder"
    NOTE = "Documented rate limit ~150 req/min. Takes the LinkedIn URL directly."
    ENDPOINT = "https://api.prospeo.io/linkedin-email-finder"
    DOMAIN_ENDPOINT = "https://api.prospeo.io/email-finder"

    def can_handle(self, rec, ctx=None) -> bool:
        return bool(rec.inp.linkedin_url) or self._needs_name_and_domain(rec, ctx)

    def missing_input_reason(self, rec, ctx=None) -> str:
        return "needs a LinkedIn URL, or a name plus company domain"

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        headers = {"Content-Type": "application/json",
                   "X-KEY": self.cfg.api_key() or ""}
        if rec.inp.linkedin_url:
            url, body = self.ENDPOINT, {
                "url": canonical_linkedin_url(rec.inp.linkedin_url)}
        else:
            first, last = self._names(rec, ctx)
            url, body = self.DOMAIN_ENDPOINT, {
                "first_name": first, "last_name": last,
                "company": self._domain(rec, ctx) or self._company(rec, ctx)}

        resp = self.http.post(url, headers=headers, json_body=body,
                              timeout=self.cfg.timeout)
        if resp.status == 404 or resp.get("error", default=False):
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status,
                                  detail=str(resp.get("message", default=""))[:200])
        addr = resp.get("response", "email", default="") or ""
        cand = self._candidate(addr)
        if not cand:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status, detail="no email in response")
        # Prospeo returns its own verification verdict; recorded verbatim for the
        # ledger, but it never substitutes for the validation stage.
        cand.validator_status = str(resp.get("response", "email_status", default="") or "")
        return ProviderResult(outcome=CallOutcome.HIT.value, emails=[cand],
                              http_status=resp.status,
                              detail=f"prospeo status={cand.validator_status}")


@registry.register
class FindymailProvider(_EmailProvider):
    """Findymail -- ``POST /api/search/name``.

    Documented as charging a credit **only when an email is found**, which is why
    it sits early: a miss here is free, so it costs nothing to ask.
    """

    name = "findymail"
    DOC_URL = "https://app.findymail.com/docs/"
    NOTE = "Charges a credit only on a successful find. Misses are free."
    ENDPOINT = "https://app.findymail.com/api/search/name"

    def can_handle(self, rec, ctx=None) -> bool:
        return self._needs_name_and_domain(rec, ctx)

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        first, last = self._names(rec, ctx)
        body = {"name": f"{first} {last}".strip(),
                "domain": self._domain(rec, ctx) or self._company(rec, ctx)}
        resp = self.http.post(
            self.ENDPOINT,
            headers={"Authorization": f"Bearer {self.cfg.api_key() or ''}",
                     "Content-Type": "application/json",
                     "Accept": "application/json"},
            json_body=body, timeout=self.cfg.timeout)
        if resp.status == 404:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value, http_status=404)
        contact = resp.get("contact", default=None)
        addr = contact.get("email") if isinstance(contact, dict) else None
        cand = self._candidate(addr or "")
        if not cand:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status, detail="no contact returned")
        return ProviderResult(outcome=CallOutcome.HIT.value, emails=[cand],
                              http_status=resp.status)


@registry.register
class HunterFinderProvider(_EmailProvider):
    """Hunter.io Email Finder -- ``GET /v2/email-finder``.

    Valuable beyond hit rate: Hunter returns ``data.sources`` -- the public URLs
    where the address was seen, with discovery dates. That is exactly the
    evidence the delivered ``Source`` column needs, so a Hunter hit carrying
    sources is upgraded to ``published_on_company_site`` ownership.
    Per the changelog, a LinkedIn handle is now an accepted input.
    """

    name = "hunter"
    DOC_URL = "https://hunter.io/api-documentation/v2"
    NOTE = "15 req/s, 500 req/min. Returns public source URLs -- keep those."
    ENDPOINT = "https://api.hunter.io/v2/email-finder"

    def can_handle(self, rec, ctx=None) -> bool:
        return bool(rec.inp.linkedin_url) or self._needs_name_and_domain(rec, ctx)

    def missing_input_reason(self, rec, ctx=None) -> str:
        return "needs a LinkedIn handle, or a name plus company domain"

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        params: dict[str, Any] = {"api_key": self.cfg.api_key() or "",
                                  "max_duration": int(self._opt("max_duration", 10))}
        domain = self._domain(rec, ctx)
        first, last = self._names(rec, ctx)
        if domain and first and last:
            params.update({"domain": domain, "first_name": first, "last_name": last})
        elif first and last and self._company(rec, ctx):
            params.update({"company": self._company(rec, ctx),
                           "first_name": first, "last_name": last})
        else:
            slug = linkedin_slug(rec.inp.linkedin_url)
            if not slug:
                return ProviderResult(outcome=CallOutcome.SKIPPED_INSUFFICIENT_INPUT.value,
                                      detail="no domain/name and no LinkedIn handle")
            params["linkedin_handle"] = slug

        resp = self.http.get(self.ENDPOINT, params=params, timeout=self.cfg.timeout)
        if resp.status == 404:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value, http_status=404)
        addr = resp.get("data", "email", default="") or ""
        if not addr:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status, detail="no email found")

        sources = [s.get("uri", "") for s in (resp.get("data", "sources", default=[]) or [])
                   if isinstance(s, dict) and s.get("uri")]
        cand = self._candidate(
            addr, score=resp.get("data", "score", default=None), sources=sources[:10],
            ownership=(Ownership.PUBLISHED_ON_COMPANY_SITE.value if sources
                       else Ownership.PROVIDER_ASSERTED.value))
        if not cand:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status)
        cand.validator_status = str(
            resp.get("data", "verification", "status", default="") or "")
        return ProviderResult(
            outcome=CallOutcome.HIT.value, emails=[cand], http_status=resp.status,
            detail=f"score={cand.score} sources={len(sources)}")


@registry.register
class AnymailFinderProvider(_EmailProvider):
    """Anymail Finder -- ``POST /v5.1/find-email/person``.

    Returns ``email_status`` and ``credits_charged``; markets verified-only
    results. A 404 here is the documented "not found" path.
    """

    name = "anymailfinder"
    DOC_URL = "https://anymailfinder.com/email-finder-api/docs/find-person-email"
    NOTE = "Returns email_status and credits_charged. 404 means not found."
    ENDPOINT = "https://api.anymailfinder.com/v5.1/find-email/person"

    def can_handle(self, rec, ctx=None) -> bool:
        return self._needs_name_and_domain(rec, ctx)

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        first, last = self._names(rec, ctx)
        body: dict[str, Any] = {"full_name": f"{first} {last}".strip()}
        domain = self._domain(rec, ctx)
        if domain:
            body["domain"] = domain
        else:
            body["company_name"] = self._company(rec, ctx)

        resp = self.http.post(
            self.ENDPOINT,
            headers={"Authorization": f"Bearer {self.cfg.api_key() or ''}",
                     "Content-Type": "application/json"},
            json_body=body, timeout=self.cfg.timeout)
        if resp.status == 404:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value, http_status=404,
                                  detail="not found")
        results = resp.get("results", default={}) or {}
        addr = results.get("email") if isinstance(results, dict) else None
        cand = self._candidate(addr or "")
        if not cand:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status)
        cand.validator_status = str(results.get("email_status", "") or "")
        return ProviderResult(outcome=CallOutcome.HIT.value, emails=[cand],
                              http_status=resp.status,
                              detail=f"email_status={cand.validator_status}")


@registry.register
class DropcontactProvider(_EmailProvider):
    """Dropcontact -- ``POST /batch`` then poll ``GET /batch/{request_id}``.

    Asynchronous by design, and EU-processed with no third-party database: it
    derives and verifies rather than looking up. Sits late in the order because
    of the poll latency, not because of quality.
    """

    name = "dropcontact"
    DOC_URL = "https://developer.dropcontact.com/"
    NOTE = "Asynchronous: POST returns request_id, results are polled."
    ENDPOINT = "https://api.dropcontact.io/batch"

    def can_handle(self, rec, ctx=None) -> bool:
        ctx = ctx or {}
        first, last = self._names(rec, ctx)
        return bool(first and last and (self._domain(rec, ctx) or self._company(rec, ctx)))

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        import time as _t
        first, last = self._names(rec, ctx)
        headers = {"Content-Type": "application/json",
                   "X-Access-Token": self.cfg.api_key() or ""}
        body = {"data": [{"first_name": first, "last_name": last,
                          "company": self._company(rec, ctx),
                          "website": self._domain(rec, ctx)}],
                "siren": False, "language": "en"}

        resp = self.http.post(self.ENDPOINT, headers=headers, json_body=body,
                              timeout=self.cfg.timeout)
        request_id = resp.get("request_id", default="") or ""
        if not request_id:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status, detail="no request_id")

        poll_url = f"{self.ENDPOINT}/{request_id}"
        max_polls = int(self._opt("max_polls", 6))
        interval = float(self._opt("poll_interval", 5.0))
        for _ in range(max_polls):
            pr = self.http.get(poll_url, headers=headers, timeout=self.cfg.timeout)
            if pr.get("success", default=False):
                rows = pr.get("data", default=[]) or []
                for row in rows:
                    for e in (row.get("email") or []):
                        addr = e.get("email") if isinstance(e, dict) else e
                        cand = self._candidate(addr or "")
                        if cand:
                            qual = e.get("qualification", "") if isinstance(e, dict) else ""
                            cand.validator_status = str(qual)
                            return ProviderResult(outcome=CallOutcome.HIT.value,
                                                  emails=[cand], http_status=pr.status,
                                                  detail=f"qualification={qual}")
                return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                      http_status=pr.status, detail="batch had no email")
            _t.sleep(interval)
        return ProviderResult(outcome=CallOutcome.TRANSIENT_ERROR.value,
                              detail=f"batch {request_id} not ready after {max_polls} polls")


@registry.register
class SnovProvider(_EmailProvider):
    """Snov.io -- OAuth2 client_credentials, then ``/v1/get-emails-from-names``.

    The access token has a documented one-hour TTL and is cached in-process.
    Tail provider: cheapest of the set, so it is asked last.
    """

    name = "snov"
    DOC_URL = "https://snov.io/api"
    NOTE = "OAuth2 client_credentials; token TTL 1 hour. Needs USER_ID and SECRET."
    TOKEN_URL = "https://api.snov.io/v1/oauth/access_token"
    ENDPOINT = "https://api.snov.io/v1/get-emails-from-names"

    def __init__(self, cfg, http=None):
        super().__init__(cfg, http)
        self._token: str = ""
        self._token_expiry: float = 0.0

    def available(self) -> bool:
        return bool(self.cfg.env("client_id") and self.cfg.env("client_secret"))

    def can_handle(self, rec, ctx=None) -> bool:
        return self._needs_name_and_domain(rec, ctx)

    def _access_token(self) -> str:
        import time as _t
        if self._token and _t.time() < self._token_expiry:
            return self._token
        resp = self.http.post(
            self.TOKEN_URL,
            data={"grant_type": "client_credentials",
                  "client_id": self.cfg.env("client_id") or "",
                  "client_secret": self.cfg.env("client_secret") or ""},
            timeout=self.cfg.timeout)
        self._token = str(resp.get("access_token", default="") or "")
        # Refresh a minute early rather than discovering expiry mid-run.
        self._token_expiry = _t.time() + float(resp.get("expires_in", default=3600)) - 60
        return self._token

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        token = self._access_token()
        if not token:
            return ProviderResult(outcome=CallOutcome.PERMANENT_ERROR.value,
                                  detail="could not obtain Snov access token")
        first, last = self._names(rec, ctx)
        resp = self.http.post(
            self.ENDPOINT,
            headers={"Authorization": f"Bearer {token}"},
            data={"firstName": first, "lastName": last,
                  "domain": self._domain(rec, ctx)},
            timeout=self.cfg.timeout)
        data = resp.get("data", default={}) or {}
        emails = data.get("emails") if isinstance(data, dict) else None
        for e in (emails or []):
            addr = e.get("email") if isinstance(e, dict) else e
            cand = self._candidate(addr or "")
            if cand:
                if isinstance(e, dict):
                    cand.validator_status = str(e.get("emailStatus", "") or "")
                return ProviderResult(outcome=CallOutcome.HIT.value, emails=[cand],
                                      http_status=resp.status)
        return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                              http_status=resp.status, detail="no emails returned")
