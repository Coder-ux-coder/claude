"""Published business-phone sources.

Both adapters here produce numbers that a business has itself published, each
carrying the URL that proves it. Neither produces a personal mobile, and neither
touches an access-controlled surface.

* **Google Places (New)** -- the clinic's own Google Business Profile. First
  party, licensed, ToS-clean. Billing note that matters: ``internationalPhoneNumber``,
  ``nationalPhoneNumber`` and ``websiteUri`` are Enterprise-SKU fields, so the
  field mask is kept as narrow as the brief allows.
* **Website contact page** -- the clinic's own site, fetched only after
  ``robots.txt`` allows it, with the page URL retained as evidence.
"""
from __future__ import annotations

import re
import urllib.robotparser
from typing import Any
from urllib.parse import urljoin, urlparse

from ..models import CallOutcome, ContactType
from ..normalize import normalise_domain
from ..phone import extract_numbers_from_html, make_candidate
from .base import Provider, ProviderResult, registry


@registry.register
class GooglePlacesProvider(Provider):
    """Google Places API (New): Text Search -> Place Details.

    Text Search resolves the clinic name (+ location) to a place; Place Details
    then returns the published phone and website. Both calls send an explicit
    ``X-Goog-FieldMask`` -- it is mandatory, and it is what determines the SKU
    you are billed at.
    """

    name = "google_places"
    stage = "phone"
    DOC_URL = "https://developers.google.com/maps/documentation/places/web-service/place-details"
    NOTE = ("Phone/website fields bill at the Enterprise SKU (~$20/1k, ~1k free "
            "calls/month). Keep the field mask narrow.")
    SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
    DETAILS_URL = "https://places.googleapis.com/v1/places/{place_id}"

    #: Narrowest mask that still identifies the right clinic.
    SEARCH_MASK = ("places.id,places.displayName,places.formattedAddress,"
                   "places.primaryType")
    #: Enterprise-tier fields. Requested only once a place has been chosen.
    DETAILS_MASK = ("id,displayName,formattedAddress,internationalPhoneNumber,"
                    "nationalPhoneNumber,websiteUri,googleMapsUri")

    def can_handle(self, rec, ctx=None) -> bool:
        ctx = ctx or {}
        return bool(ctx.get("company") or rec.clinic.value or rec.inp.company)

    def missing_input_reason(self, rec, ctx=None) -> str:
        return "no clinic/company name to look up"

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        company = (ctx.get("company") or rec.clinic.value or rec.inp.company or "").strip()
        location = (ctx.get("location") or rec.inp.location or "").strip()
        query = f"{company} {location}".strip()
        key = self.cfg.api_key() or ""

        search = self.http.post(
            self.SEARCH_URL,
            headers={"Content-Type": "application/json", "X-Goog-Api-Key": key,
                     "X-Goog-FieldMask": self.SEARCH_MASK},
            json_body={"textQuery": query,
                       "regionCode": self._opt("region_code", "IN"),
                       "maxResultCount": int(self._opt("max_results", 3))},
            timeout=self.cfg.timeout)

        places = search.get("places", default=[]) or []
        if not places:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=search.status,
                                  detail=f"no place matched '{query}'")

        place = places[0]
        place_id = place.get("id") or ""
        display = ((place.get("displayName") or {}).get("text")
                   if isinstance(place.get("displayName"), dict) else "") or company
        if not place_id:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=search.status, detail="place had no id")

        details = self.http.get(
            self.DETAILS_URL.format(place_id=place_id),
            headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": self.DETAILS_MASK},
            timeout=self.cfg.timeout)
        body = details.json_body if isinstance(details.json_body, dict) else {}

        maps_uri = body.get("googleMapsUri") or f"https://www.google.com/maps/place/?q=place_id:{place_id}"
        website = body.get("websiteUri") or ""
        raw_phone = body.get("internationalPhoneNumber") or body.get("nationalPhoneNumber") or ""

        phones = []
        if raw_phone:
            cand = make_candidate(
                raw_phone, provider=self.name, source_url=maps_uri,
                context=f"google business profile for {display}",
                person_name=(ctx.get("full_name") or rec.name.value or ""),
                from_business_listing=True,
                region=self._opt("region", "IN"))
            if cand:
                phones.append(cand)

        if not phones and not website:
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value,
                                  http_status=details.status,
                                  detail="place found but published no phone or website")
        return ProviderResult(
            outcome=CallOutcome.HIT.value, phones=phones, http_status=details.status,
            raw={"website": website, "place_id": place_id,
                 "maps_uri": maps_uri, "display_name": display},
            detail=f"{display}: phone={'yes' if phones else 'no'} site={'yes' if website else 'no'}")


@registry.register
class WebsiteContactProvider(Provider):
    """The clinic's own public website.

    Fetches the homepage and a small set of conventional contact paths, honours
    ``robots.txt`` before every fetch, and keeps the page URL plus the surrounding
    text as evidence for each number found. No login, no paywall, nothing behind
    an access control.
    """

    name = "website"
    stage = "phone"
    DOC_URL = ""
    NOTE = "Reads public pages only, after checking robots.txt. No credentials needed."
    CONTACT_PATHS = ("", "/contact", "/contact-us", "/contactus", "/about",
                     "/about-us", "/reach-us", "/get-in-touch", "/team", "/doctors")

    def available(self) -> bool:
        return True   # no credentials required

    def can_handle(self, rec, ctx=None) -> bool:
        ctx = ctx or {}
        return bool(ctx.get("website") or ctx.get("domain") or rec.domain.value
                    or rec.inp.domain)

    def missing_input_reason(self, rec, ctx=None) -> str:
        return "no clinic website or domain known"

    def _robots_allows(self, url: str, user_agent: str) -> bool:
        try:
            parsed = urlparse(url)
            rp = urllib.robotparser.RobotFileParser()
            rp.set_url(f"{parsed.scheme}://{parsed.netloc}/robots.txt")
            rp.read()
            return rp.can_fetch(user_agent, url)
        except Exception:
            # No reachable robots.txt is conventionally treated as allow. The
            # pages fetched here are ordinary public contact pages.
            return True

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        base = (ctx.get("website") or "").strip()
        if not base:
            domain = normalise_domain(ctx.get("domain") or rec.domain.value
                                      or rec.inp.domain or "")
            if not domain:
                return ProviderResult(outcome=CallOutcome.SKIPPED_INSUFFICIENT_INPUT.value,
                                      detail="no website or domain")
            base = f"https://{domain}"
        if not base.startswith(("http://", "https://")):
            base = "https://" + base

        ua = self._opt("user_agent", "leadenrich-bot/1.0 (+public business contact lookup)")
        person = ctx.get("full_name") or rec.name.value or ""
        max_pages = int(self._opt("max_pages", 3))

        phones, checked, blocked = [], [], 0
        for path in self.CONTACT_PATHS:
            if len(checked) >= max_pages:
                break
            url = urljoin(base, path) if path else base
            if not self._robots_allows(url, ua):
                blocked += 1
                continue
            try:
                resp = self.http.get(url, headers={"User-Agent": ua,
                                                   "Accept": "text/html"},
                                     timeout=self.cfg.timeout)
            except Exception:
                continue
            if resp.status != 200 or not resp.text:
                continue
            checked.append(url)
            for raw, context in extract_numbers_from_html(resp.text,
                                                          self._opt("region", "IN")):
                cand = make_candidate(raw, provider=self.name, source_url=url,
                                      context=context, person_name=person,
                                      region=self._opt("region", "IN"))
                if cand and not any(p.number_e164 == cand.number_e164 for p in phones):
                    phones.append(cand)

        if not phones:
            detail = (f"checked {len(checked)} page(s), no published number found"
                      + (f"; {blocked} page(s) disallowed by robots.txt" if blocked else ""))
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value, detail=detail)

        return ProviderResult(outcome=CallOutcome.HIT.value, phones=phones,
                              raw={"pages_checked": checked},
                              detail=f"{len(phones)} number(s) from {len(checked)} page(s)")
