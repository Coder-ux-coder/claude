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

    Real sites are inconsistent in ways that all look like "no phone found" if
    you do not handle them, so each is handled explicitly:

    * the domain may only answer on ``http``, or only with ``www`` -- several
      origins are tried in likelihood order and the first that answers wins
    * the site's own navigation is followed to whatever it calls its contact
      page, rather than guessing paths, because Indian clinic sites use
      /reach-us, /branches, /book and many others
    * a Cloudflare interstitial or a JavaScript-only shell is reported as
      *needs a human*, never as "no number" -- the latter would be a false
      negative a reviewer cannot see
    * ``robots.txt`` is honoured before every fetch, and a disallowed page is
      recorded as skipped rather than silently missing
    """

    name = "website"
    stage = "phone"
    DOC_URL = ""
    NOTE = "Reads public pages only, after checking robots.txt. No credentials needed."
    #: Tried only when the site's own navigation offers nothing.
    FALLBACK_PATHS = ("/contact", "/contact-us", "/reach-us", "/about",
                      "/about-us", "/team", "/doctors")

    def available(self) -> bool:
        return True

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
            # An unreachable robots.txt is conventionally treated as allow, and
            # these are ordinary public contact pages.
            return True

    def _call(self, rec, ctx: dict[str, Any]) -> ProviderResult:
        from ..webfetch import candidate_origins, fetch_page

        ua = self._opt("user_agent",
                       "leadenrich-bot/1.0 (+public business contact lookup)")
        region = self._opt("region", "IN")
        max_pages = int(self._opt("max_pages", 4))
        max_bytes = int(self._opt("max_bytes", 2_000_000))
        max_redirects = int(self._opt("max_redirects", 5))
        follow_links = bool(self._opt("follow_site_contact_link", True))
        person = ctx.get("full_name") or rec.name.value or ""

        explicit = (ctx.get("website") or "").strip()
        domain = normalise_domain(ctx.get("domain") or rec.domain.value
                                  or rec.inp.domain or "")
        origins = ([explicit] if explicit else []) + candidate_origins(domain)
        if not origins:
            return ProviderResult(outcome=CallOutcome.SKIPPED_INSUFFICIENT_INPUT.value,
                                  detail="no website or domain")

        session = getattr(self.http, "session", None)
        if session is None:                      # pragma: no cover
            import requests
            session = requests.Session()

        phones: list = []
        checked: list[str] = []
        notes: list[str] = []
        home = None

        # ---- find an origin that actually answers -----------------------
        for origin in origins[:4]:
            if not self._robots_allows(origin, ua):
                notes.append(f"{origin}: disallowed by robots.txt")
                continue
            res = fetch_page(session, origin, user_agent=ua,
                             timeout=self.cfg.timeout, max_bytes=max_bytes,
                             max_redirects=max_redirects)
            if res.ok:
                home = res
                break
            if res.js_wall:
                return ProviderResult(
                    outcome=CallOutcome.NO_MATCH.value,
                    detail=f"{origin}: {res.reason}",
                    raw={"needs_human": True, "url": origin})
            notes.append(f"{origin}: {res.reason}")

        if home is None:
            return ProviderResult(
                outcome=CallOutcome.NO_MATCH.value,
                detail="site did not answer -- " + "; ".join(notes[:3]))

        # ---- collect numbers from the homepage, then its contact pages ---
        def harvest(page_res) -> None:
            checked.append(page_res.final_url)
            for raw, context in extract_numbers_from_html(page_res.text, region):
                cand = make_candidate(raw, provider=self.name,
                                      source_url=page_res.final_url,
                                      context=context, person_name=person,
                                      region=region)
                if cand and not any(p.number_e164 == cand.number_e164
                                    for p in phones):
                    phones.append(cand)

        harvest(home)

        targets: list[str] = []
        if follow_links:
            targets = [u for u, _ in home.links]
        for path in self.FALLBACK_PATHS:
            candidate = urljoin(home.final_url, path)
            if candidate not in targets:
                targets.append(candidate)

        for url in targets:
            if len(checked) >= max_pages:
                break
            if url in checked:
                continue
            if not self._robots_allows(url, ua):
                notes.append(f"{url}: disallowed by robots.txt")
                continue
            res = fetch_page(session, url, user_agent=ua,
                             timeout=self.cfg.timeout, max_bytes=max_bytes,
                             max_redirects=max_redirects)
            if res.ok:
                harvest(res)

        if not phones:
            detail = f"read {len(checked)} page(s), no published number found"
            if notes:
                detail += "; " + "; ".join(notes[:2])
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value, detail=detail,
                                  raw={"pages_checked": checked})

        return ProviderResult(
            outcome=CallOutcome.HIT.value, phones=phones,
            raw={"pages_checked": checked, "site": home.final_url},
            detail=f"{len(phones)} number(s) from {len(checked)} page(s) on "
                   f"{home.final_url}")
