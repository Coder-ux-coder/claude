"""Deterministic demo fixtures.

Every value here is **clearly fictional**: names are invented, clinics use the
``.example`` reserved TLD, and phone numbers sit in India's documentation range
(+91 99999 xxxxx). Nothing in this module touches the network.

The fixtures are arranged so a demo run exercises every branch the real pipeline
has: provider A finding an address, A missing and B finding it, A and B missing
and C finding it, a transient failure that retries and then succeeds, a
catch-all that the gate refuses, a role account that the gate refuses, a row with
no resolvable identity, and a duplicate row.
"""
from __future__ import annotations

import hashlib
from typing import Any

from ..models import CallOutcome, Ownership
from ..normalize import linkedin_slug
from ..phone import make_candidate
from .base import (IdentityResult, Provider, ProviderResult, ValidationResult,
                   registry)

#: slug -> fictional identity.
DEMO_IDENTITIES: dict[str, dict[str, str]] = {
    "dr-anaya-varma-demo1": {
        "full_name": "Dr Anaya Varma", "first_name": "Anaya", "last_name": "Varma",
        "title": "Founder & Medical Director", "company": "Meridian Skin Clinic",
        "domain": "meridianskin.example", "location": "Bengaluru, Karnataka, India",
    },
    "rohan-desai-demo2": {
        "full_name": "Rohan Desai", "first_name": "Rohan", "last_name": "Desai",
        "title": "Managing Director", "company": "Blue Harbour Dental",
        "domain": "blueharbourdental.example", "location": "Mumbai, Maharashtra, India",
    },
    "dr-kavya-nair-demo3": {
        "full_name": "Dr Kavya Nair", "first_name": "Kavya", "last_name": "Nair",
        "title": "Clinic Owner", "company": "Aurora Eye Care",
        "domain": "auroraeyecare.example", "location": "Kochi, Kerala, India",
    },
    "sanjay-iyer-demo4": {
        "full_name": "Sanjay Iyer", "first_name": "Sanjay", "last_name": "Iyer",
        "title": "Director of Operations", "company": "Northgate Physiotherapy",
        "domain": "northgatephysio.example", "location": "Pune, Maharashtra, India",
    },
    "dr-meera-joshi-demo5": {
        "full_name": "Dr Meera Joshi", "first_name": "Meera", "last_name": "Joshi",
        "title": "Proprietor", "company": "Lotus Wellness Polyclinic",
        "domain": "lotuswellness.example", "location": "Jaipur, Rajasthan, India",
    },
    "arjun-menon-demo6": {
        "full_name": "Arjun Menon", "first_name": "Arjun", "last_name": "Menon",
        "title": "Chief Executive Officer", "company": "Silverline Diagnostics",
        "domain": "silverlinediag.example", "location": "Chennai, Tamil Nadu, India",
    },
    # demo7 is deliberately absent: it exercises the unresolved-identity path.
}

#: Which demo email provider (if any) holds each address, and what the validator
#: will say about it. This is the table that drives the A -> B -> C fallback.
DEMO_EMAILS: dict[str, dict[str, Any]] = {
    "dr-anaya-varma-demo1": {
        "provider": "demo_email_a", "address": "anaya.varma@meridianskin.example",
        "status": "valid", "score": 96},
    "rohan-desai-demo2": {
        "provider": "demo_email_b", "address": "rohan@blueharbourdental.example",
        "status": "valid", "score": 91},
    "dr-kavya-nair-demo3": {
        "provider": "demo_email_c", "address": "k.nair@auroraeyecare.example",
        "status": "valid", "score": 88},
    "sanjay-iyer-demo4": {
        # Provider B answers, but the domain is catch-all -- the gate must refuse.
        "provider": "demo_email_b", "address": "sanjay@northgatephysio.example",
        "status": "catch-all", "score": 72},
    "dr-meera-joshi-demo5": {
        # A role mailbox: perfectly deliverable, not a named person's inbox.
        "provider": "demo_email_c", "address": "info@lotuswellness.example",
        "status": "valid", "score": 80},
    # demo6 is in no provider's table: all three miss, ending in a clean no_match.
}

#: Published business numbers, in India's +91 99999 documentation range.
DEMO_PLACES: dict[str, dict[str, str]] = {
    "Meridian Skin Clinic": {"phone": "+91 99999 10001",
                             "website": "https://meridianskin.example",
                             "maps": "https://maps.google.example/place/meridian"},
    "Blue Harbour Dental": {"phone": "+91 99999 10002",
                            "website": "https://blueharbourdental.example",
                            "maps": "https://maps.google.example/place/blueharbour"},
    "Aurora Eye Care": {"phone": "+91 99999 10003",
                        "website": "https://auroraeyecare.example",
                        "maps": "https://maps.google.example/place/aurora"},
    "Northgate Physiotherapy": {"phone": "+91 99999 10004",
                                "website": "https://northgatephysio.example",
                                "maps": "https://maps.google.example/place/northgate"},
    "Silverline Diagnostics": {"phone": "+91 99999 10006",
                               "website": "https://silverlinediag.example",
                               "maps": "https://maps.google.example/place/silverline"},
    # Lotus Wellness is absent from the listing: the website fallback covers it.
}

#: Pages the demo "website" reader returns, with a direct line published against
#: a named doctor so the direct-line classification is exercised.
DEMO_WEBSITES: dict[str, str] = {
    "lotuswellness.example": (
        "Lotus Wellness Polyclinic. Reception: 0141 4567890. "
        "Dr Meera Joshi, Proprietor -- direct line +91 99999 10005."),
    "meridianskin.example": (
        "Meridian Skin Clinic. Call us on +91 99999 10001 to book an appointment."),
}


def _slug(rec) -> str:
    return linkedin_slug(rec.inp.linkedin_url) or ""


class _Demo(Provider):
    """Demo adapters need no credentials and never leave the process."""

    def available(self) -> bool:
        return True


@registry.register
class DemoIdentityProvider(_Demo):
    name = "demo_identity"
    stage = "identity"
    NOTE = "Fictional fixtures. No network, no credentials."

    def can_handle(self, rec, ctx=None) -> bool:
        return bool(rec.inp.linkedin_url)

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        d = DEMO_IDENTITIES.get(_slug(rec))
        if not d:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  detail="no fixture for this handle")
        return ProviderResult(
            outcome=CallOutcome.HIT.value,
            identity=IdentityResult(
                source_url=f"https://www.linkedin.com/in/{_slug(rec)}",
                confidence="high", **d),
            detail=f"fixture match: {d['full_name']}")


class _DemoEmail(_Demo):
    stage = "email"
    NOTE = "Fictional fixtures. Demonstrates waterfall fallback."

    def can_handle(self, rec, ctx=None) -> bool:
        return bool(_slug(rec))

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        slug = _slug(rec)
        entry = DEMO_EMAILS.get(slug)

        # demo4 makes provider A fail transiently the first time it is asked, so
        # a demo run visibly exercises retry-then-continue behaviour.
        if self.name == "demo_email_a" and slug == "sanjay-iyer-demo4":
            key = f"{self.name}:{slug}"
            seen = ctx.setdefault("_demo_transient_seen", set())
            if key not in seen:
                seen.add(key)
                return ProviderResult(outcome=CallOutcome.TRANSIENT_ERROR.value,
                                      http_status=503,
                                      detail="simulated 503 from provider A")

        if not entry or entry["provider"] != self.name:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  detail="provider has no record for this person")

        from ..models import EmailCandidate
        import time as _t
        cand = EmailCandidate(
            address=entry["address"], provider=self.name,
            ownership=Ownership.PROVIDER_ASSERTED.value,
            score=entry.get("score"), checked_at=_t.time(),
            source_urls=[f"https://{entry['address'].split('@')[1]}/team"])
        return ProviderResult(outcome=CallOutcome.HIT.value, emails=[cand],
                              detail=f"fixture email for {slug}")


@registry.register
class DemoEmailA(_DemoEmail):
    name = "demo_email_a"


@registry.register
class DemoEmailB(_DemoEmail):
    name = "demo_email_b"


@registry.register
class DemoEmailC(_DemoEmail):
    name = "demo_email_c"


@registry.register
class DemoValidator(_Demo):
    name = "demo_validator"
    stage = "validation"
    NOTE = "Fictional fixtures. Returns the status recorded in the fixture table."

    def can_handle(self, rec, ctx=None) -> bool:
        return bool((ctx or {}).get("email"))

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        addr = (ctx.get("email") or "").lower()
        entry = next((e for e in DEMO_EMAILS.values()
                      if e["address"].lower() == addr), None)
        if not entry:
            # Unknown addresses are 'unknown', never optimistically 'valid'.
            return ProviderResult(
                outcome=CallOutcome.HIT.value,
                validation=ValidationResult(status="unknown",
                                            sub_status="no fixture"),
                detail="unknown (no fixture)")
        status = entry["status"]
        return ProviderResult(
            outcome=CallOutcome.HIT.value,
            validation=ValidationResult(
                status=status,
                sub_status="role_based" if addr.startswith("info@") else "",
                score=entry.get("score"),
                catch_all=(status == "catch-all")),
            detail=f"fixture validation: {status}")


@registry.register
class DemoPlacesProvider(_Demo):
    name = "demo_places"
    stage = "phone"
    NOTE = "Fictional business listings. Numbers use India's +91 99999 doc range."

    def can_handle(self, rec, ctx=None) -> bool:
        ctx = ctx or {}
        return bool(ctx.get("company") or rec.clinic.value)

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        company = ctx.get("company") or rec.clinic.value or ""
        entry = DEMO_PLACES.get(company)
        if not entry:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  detail=f"no listing for '{company}'")
        cand = make_candidate(
            entry["phone"], provider=self.name, source_url=entry["maps"],
            context=f"google business profile for {company}",
            person_name=ctx.get("full_name", ""), from_business_listing=True)
        phones = [cand] if cand else []
        return ProviderResult(outcome=CallOutcome.HIT.value, phones=phones,
                              raw={"website": entry["website"]},
                              detail=f"listing for {company}")


@registry.register
class DemoWebsiteProvider(_Demo):
    name = "demo_website"
    stage = "phone"
    NOTE = "Fictional public pages. Exercises direct-line classification."

    def can_handle(self, rec, ctx=None) -> bool:
        ctx = ctx or {}
        return bool(ctx.get("domain") or rec.domain.value)

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        from ..phone import extract_numbers_from_html
        domain = ctx.get("domain") or rec.domain.value or ""
        page = DEMO_WEBSITES.get(domain)
        if not page:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  detail=f"no public page fixture for {domain}")
        url = f"https://{domain}/contact"
        person = ctx.get("full_name") or rec.name.value or ""
        phones = []
        for raw, context in extract_numbers_from_html(page):
            cand = make_candidate(raw, provider=self.name, source_url=url,
                                  context=context, person_name=person)
            if cand and not any(p.number_e164 == cand.number_e164 for p in phones):
                phones.append(cand)
        if not phones:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  detail="page published no usable number")
        return ProviderResult(outcome=CallOutcome.HIT.value, phones=phones,
                              detail=f"{len(phones)} number(s) from {url}")


def fixture_digest() -> str:
    """Stable digest of the fixture tables -- lets tests assert determinism."""
    blob = repr(sorted(DEMO_IDENTITIES.items())) + repr(sorted(DEMO_EMAILS.items()))
    return hashlib.sha256(blob.encode()).hexdigest()[:12]
