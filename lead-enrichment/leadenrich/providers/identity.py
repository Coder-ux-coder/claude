"""Identity resolution: LinkedIn URL (or name+company) -> person, role, clinic.

Read ``docs/RESEARCH.md`` section 1 before changing anything here. Proxycurl --
the old "URL in, JSON out" default -- shut down on 4 July 2025 after LinkedIn
sued its operator, and a permanent injunction followed. What remains is
*matching* against providers who already hold a record. A miss is a legitimate,
expected outcome, not a bug to engineer around with a login.
"""
from __future__ import annotations

from typing import Any

from ..models import CallOutcome
from ..normalize import (canonical_linkedin_url, normalise_domain, parse_slug,
                         split_name)
from .base import IdentityResult, Provider, ProviderResult, registry


@registry.register
class LinkedInSlugProvider(Provider):
    """Zero-cost baseline: parse the handle the client already supplied.

    Touches no network and no access control -- it reads the URL string. Yields
    a probable name only, always at ``low`` confidence, and never a role,
    company or contact detail.
    """

    name = "linkedin_slug"
    stage = "identity"
    DOC_URL = ""
    NOTE = "Local string parse of the profile handle. No API key, no network."

    def available(self) -> bool:
        return True

    def can_handle(self, rec, ctx=None) -> bool:
        return bool(rec.inp.linkedin_url)

    def missing_input_reason(self, rec, ctx=None) -> str:
        return "no LinkedIn URL on the row"

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        parsed = parse_slug(rec.inp.linkedin_url)
        if not parsed.probable_full:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  detail="handle carried no parseable name")
        return ProviderResult(
            outcome=CallOutcome.HIT.value,
            identity=IdentityResult(
                full_name=parsed.probable_full,
                first_name=parsed.probable_first,
                last_name=parsed.probable_last,
                linkedin_url=canonical_linkedin_url(rec.inp.linkedin_url),
                source_url=canonical_linkedin_url(rec.inp.linkedin_url),
                confidence="low",
            ),
            detail=f"parsed from handle '{parsed.slug}' (probable name only)",
        )


@registry.register
class ApolloProvider(Provider):
    """Apollo.io People Enrichment -- ``POST /api/v1/people/match``.

    Documented behaviour honoured here:

    * ``linkedin_url`` is an accepted match key.
    * Personal emails and phone numbers are withheld unless explicitly revealed.
    * ``reveal_phone_number=true`` **requires** a ``webhook_url``: Apollo verifies
      phones asynchronously and POSTs the result back. This adapter therefore
      leaves phone reveal **off** unless both the option and a webhook URL are
      configured, and it never blocks waiting for a callback.
    """

    name = "apollo"
    stage = "identity"
    DOC_URL = "https://docs.apollo.io/reference/people-enrichment"
    NOTE = ("Paid plan required; some endpoints need a key flagged 'master key'. "
            "Phone reveal is async and needs a public webhook URL.")
    ENDPOINT = "https://api.apollo.io/api/v1/people/match"

    def can_handle(self, rec, ctx=None) -> bool:
        i = rec.inp
        return bool(i.linkedin_url or i.full_name or (i.first_name and i.last_name))

    def missing_input_reason(self, rec, ctx=None) -> str:
        return "needs a LinkedIn URL or a person name"

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        i = rec.inp
        first, last = (i.first_name, i.last_name)
        if not (first and last) and i.full_name:
            first, last = split_name(i.full_name)

        payload: dict[str, Any] = {}
        if i.linkedin_url:
            payload["linkedin_url"] = canonical_linkedin_url(i.linkedin_url)
        if first:
            payload["first_name"] = first
        if last:
            payload["last_name"] = last
        if i.company:
            payload["organization_name"] = i.company
        if i.domain:
            payload["domain"] = normalise_domain(i.domain)

        # Work email only, by default. Personal contact reveal stays opt-in.
        if self._opt("reveal_personal_emails", False):
            payload["reveal_personal_emails"] = True
        webhook = self.cfg.env("webhook_url")
        if self._opt("reveal_phone_number", False) and webhook:
            payload["reveal_phone_number"] = True
            payload["webhook_url"] = webhook

        resp = self.http.post(
            self.ENDPOINT,
            headers={"x-api-key": self.cfg.api_key() or "",
                     "Content-Type": "application/json",
                     "Cache-Control": "no-cache", "accept": "application/json"},
            json_body=payload, timeout=self.cfg.timeout)

        person = resp.get("person", default=None)
        if not isinstance(person, dict) or not person:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status,
                                  detail="no person object in response")

        org = person.get("organization") or {}
        ident = IdentityResult(
            full_name=self._first(person.get("name"),
                                  f"{person.get('first_name','')} {person.get('last_name','')}"),
            first_name=self._first(person.get("first_name")),
            last_name=self._first(person.get("last_name")),
            title=self._first(person.get("title")),
            company=self._first(org.get("name"), person.get("organization_name")),
            domain=normalise_domain(self._first(org.get("website_url"),
                                                org.get("primary_domain"),
                                                person.get("email") or "")),
            location=", ".join(x for x in (person.get("city"), person.get("state"),
                                           person.get("country")) if x),
            linkedin_url=self._first(person.get("linkedin_url")),
            source_url=self._first(person.get("linkedin_url"), org.get("website_url")),
            confidence="high",
        )

        email = self._first(person.get("email"))
        # Apollo masks withheld addresses with a sentinel rather than omitting them.
        if email and "email_not_unlocked" not in email.lower():
            ident.emails.append((email, self._first(person.get("email_status")) or "apollo"))

        for num in (person.get("phone_numbers") or []):
            if isinstance(num, dict):
                raw = self._first(num.get("sanitized_number"), num.get("raw_number"))
                if raw:
                    ident.phones.append((raw, self._first(num.get("type")) or "unspecified"))
        if isinstance(org.get("phone"), str) and org["phone"]:
            ident.phones.append((org["phone"], "organization_phone"))

        return ProviderResult(outcome=CallOutcome.HIT.value, identity=ident,
                              http_status=resp.status,
                              detail=f"matched {ident.full_name or 'person'}")


@registry.register
class PeopleDataLabsProvider(Provider):
    """People Data Labs Person Enrichment -- ``GET /v5/person/enrich``.

    ``profile`` accepts a LinkedIn URL. ``min_likelihood`` (1-10) trades match
    rate against match quality; the default here is deliberately strict, because
    a wrong match is worse for this deliverable than a missing one.
    """

    name = "pdl"
    stage = "identity"
    DOC_URL = "https://docs.peopledatalabs.com/docs/reference-person-enrichment-api"
    NOTE = "min_likelihood defaults to 6 (strict). Lower it to trade precision for recall."
    ENDPOINT = "https://api.peopledatalabs.com/v5/person/enrich"

    def can_handle(self, rec, ctx=None) -> bool:
        i = rec.inp
        # PDL's documented minimum: profile OR email OR phone OR
        # (name AND one of company/school/locality/region/postal_code).
        if i.linkedin_url:
            return True
        has_name = bool(i.full_name or (i.first_name and i.last_name))
        return has_name and bool(i.company or i.domain or i.location)

    def missing_input_reason(self, rec, ctx=None) -> str:
        return ("PDL needs a profile URL, or a name plus one of "
                "company/domain/location")

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        i = rec.inp
        params: dict[str, Any] = {
            "min_likelihood": int(self._opt("min_likelihood", 6)),
            "titlecase": "true",
        }
        if i.linkedin_url:
            params["profile"] = canonical_linkedin_url(i.linkedin_url)
        else:
            first, last = (i.first_name, i.last_name)
            if not (first and last) and i.full_name:
                first, last = split_name(i.full_name)
            if first:
                params["first_name"] = first
            if last:
                params["last_name"] = last
            if i.company:
                params["company"] = i.company
            if i.domain:
                params["company"] = params.get("company") or normalise_domain(i.domain)
            if i.location:
                params["location"] = i.location

        resp = self.http.get(
            self.ENDPOINT,
            headers={"X-Api-Key": self.cfg.api_key() or "",
                     "accept": "application/json"},
            params=params, timeout=self.cfg.timeout)

        # PDL answers 404 for "no match at this likelihood" -- clean, not an error.
        if resp.status == 404:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=404,
                                  detail="no match at requested min_likelihood")
        data = resp.get("data", default=None)
        if not isinstance(data, dict) or not data:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status, detail="empty data")

        exp = (data.get("experience") or [])
        current = next((e for e in exp if isinstance(e, dict) and e.get("is_primary")),
                       exp[0] if exp else {}) or {}
        comp = (current.get("company") or {}) if isinstance(current, dict) else {}
        title = ((current.get("title") or {}).get("name")
                 if isinstance(current.get("title"), dict) else current.get("title"))

        ident = IdentityResult(
            full_name=self._first(data.get("full_name")),
            first_name=self._first(data.get("first_name")),
            last_name=self._first(data.get("last_name")),
            title=self._first(title, data.get("job_title")),
            company=self._first(comp.get("name"), data.get("job_company_name")),
            domain=normalise_domain(self._first(comp.get("website"),
                                                data.get("job_company_website"))),
            location=self._first(data.get("location_name")),
            linkedin_url=self._first(data.get("linkedin_url")),
            source_url=self._first(data.get("linkedin_url")),
            confidence="high" if data.get("likelihood", 0) >= 8 else "medium",
        )
        if data.get("work_email"):
            ident.emails.append((data["work_email"], "work_email"))
        for e in (data.get("emails") or []):
            addr = e.get("address") if isinstance(e, dict) else e
            if addr:
                kind = e.get("type") if isinstance(e, dict) else "unspecified"
                ident.emails.append((addr, kind or "unspecified"))
        # PDL's mobile_phone is an unpublished personal line. It is carried
        # through labelled as such and is withheld from export by the phone
        # policy -- see leadenrich/phone.py.
        if data.get("mobile_phone"):
            ident.phones.append((data["mobile_phone"], "mobile_phone"))
        for p in (data.get("phone_numbers") or []):
            if isinstance(p, str):
                ident.phones.append((p, "unspecified"))

        return ProviderResult(outcome=CallOutcome.HIT.value, identity=ident,
                              http_status=resp.status,
                              detail=f"likelihood={data.get('likelihood')}")


@registry.register
class EnrichLayerProvider(Provider):
    """Enrich Layer -- markets itself as Proxycurl's successor.

    **Shipped disabled.** It inherits the legal exposure that closed Proxycurl in
    July 2025. Enable it only after your own counsel has reviewed the position;
    the pipeline works without it.
    """

    name = "enrichlayer"
    stage = "identity"
    DOC_URL = "https://enrichlayer.com/docs"
    NOTE = ("DISABLED BY DEFAULT. Positions itself as the Proxycurl successor and "
            "inherits that legal exposure. Review before enabling.")
    ENDPOINT = "https://enrichlayer.com/api/v2/profile"

    def can_handle(self, rec, ctx=None) -> bool:
        return bool(rec.inp.linkedin_url)

    def missing_input_reason(self, rec, ctx=None) -> str:
        return "needs a LinkedIn profile URL"

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        resp = self.http.get(
            self.ENDPOINT,
            headers={"Authorization": f"Bearer {self.cfg.api_key() or ''}"},
            params={"url": canonical_linkedin_url(rec.inp.linkedin_url),
                    "use_cache": self._opt("use_cache", "if-present")},
            timeout=self.cfg.timeout)
        if resp.status == 404 or not isinstance(resp.json_body, dict) or not resp.json_body:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=resp.status, detail="no profile")
        d = resp.json_body
        exp = (d.get("experiences") or [])
        cur = exp[0] if exp else {}
        first = self._first(d.get("first_name"))
        last = self._first(d.get("last_name"))
        ident = IdentityResult(
            full_name=self._first(d.get("full_name"), f"{first} {last}"),
            first_name=first, last_name=last,
            title=self._first(d.get("occupation"), cur.get("title")),
            company=self._first(cur.get("company")),
            domain=normalise_domain(self._first(cur.get("company_linkedin_profile_url"))),
            location=", ".join(x for x in (d.get("city"), d.get("state"),
                                           d.get("country_full_name")) if x),
            linkedin_url=canonical_linkedin_url(rec.inp.linkedin_url),
            source_url=canonical_linkedin_url(rec.inp.linkedin_url),
            confidence="medium",
        )
        return ProviderResult(outcome=CallOutcome.HIT.value, identity=ident,
                              http_status=resp.status)
