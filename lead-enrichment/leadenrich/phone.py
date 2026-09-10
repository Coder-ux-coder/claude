"""Phone normalisation, classification and the export gate.

This module is the compliance control for the whole build. The brief asked for a
"verified mobile number"; what is delivered instead is a *published business
contact* with an evidence URL, correctly labelled. The two rules that must never
be relaxed by accident are enforced here and covered by tests:

1. A number with no public source URL cannot be exported (unless an operator
   explicitly disables ``require_public_evidence`` for their own legal basis).
2. A provider-supplied number with no publication evidence is labelled
   ``provider_supplied_unpublished`` and can never be relabelled as a verified
   personal or direct mobile.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .models import ContactType, PhoneCandidate

try:                                    # optional, but strongly preferred
    import phonenumbers
    from phonenumbers import PhoneNumberType
    _HAVE_PHONENUMBERS = True
except Exception:                       # pragma: no cover - fallback path
    _HAVE_PHONENUMBERS = False

#: Fallback +91 matcher used only when python-phonenumbers is unavailable.
_IN_FALLBACK_RE = re.compile(
    r"(?:\+?91[\s\-.]?)?([6-9]\d{9})\b|"          # mobile
    r"(?:\+?91[\s\-.]?)?(?:0?(\d{2,4}))[\s\-.]?(\d{6,8})\b"   # landline w/ STD
)
MARK_OPEN, MARK_CLOSE = "{{", "}}"
TEL_HREF_RE = re.compile(r'href\s*=\s*["\']tel:([^"\']+)["\']', re.I)
PHONE_TEXT_RE = re.compile(
    r"(?:\+?91[\s\-.]*)?(?:\(?0\d{1,4}\)?[\s\-.]*)?\d[\d\s\-.]{7,14}\d")

#: Page context that indicates a number is a general/reception line.
_MAIN_LINE_HINTS = ("reception", "front desk", "frontdesk", "appointment",
                    "book now", "helpline", "call us", "contact us", "clinic",
                    "enquiry", "enquiries", "general", "toll free", "tollfree")
#: Page context that indicates the business publishes this against a person.
_DIRECT_HINTS = ("direct", "direct line", "personal assistant", "secretary",
                 "office of", "chamber", "consultation with", "dr.", "dr ")


@dataclass
class ParsedPhone:
    e164: str = ""
    raw: str = ""
    valid: bool = False
    is_mobile: bool = False
    is_fixed_line: bool = False
    region: str = ""
    reason: str = ""


def parse_phone(raw: str, region: str = "IN") -> ParsedPhone:
    """Parse and validate a phone number, preferring libphonenumber."""
    raw = (raw or "").strip()
    if not raw:
        return ParsedPhone(reason="empty")

    if _HAVE_PHONENUMBERS:
        try:
            num = phonenumbers.parse(raw, region)
        except Exception as exc:
            return ParsedPhone(raw=raw, reason=f"unparseable: {exc}")
        if not phonenumbers.is_valid_number(num):
            return ParsedPhone(raw=raw, reason="not a valid number for region")
        e164 = phonenumbers.format_number(
            num, phonenumbers.PhoneNumberFormat.E164)
        ntype = phonenumbers.number_type(num)
        return ParsedPhone(
            e164=e164, raw=raw, valid=True,
            is_mobile=ntype in (PhoneNumberType.MOBILE,
                                PhoneNumberType.FIXED_LINE_OR_MOBILE),
            is_fixed_line=ntype in (PhoneNumberType.FIXED_LINE,
                                    PhoneNumberType.FIXED_LINE_OR_MOBILE),
            region=phonenumbers.region_code_for_number(num) or "",
        )

    # ---- fallback: India-only heuristics -------------------------------
    digits = re.sub(r"[^\d]", "", raw)
    if digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    elif digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    if len(digits) == 10 and digits[0] in "6789":
        return ParsedPhone(e164="+91" + digits, raw=raw, valid=True,
                           is_mobile=True, region="IN")
    if 8 <= len(digits) <= 11:
        return ParsedPhone(e164="+91" + digits[-10:] if len(digits) >= 10
                           else "", raw=raw, valid=len(digits) >= 10,
                           is_fixed_line=True, region="IN",
                           reason="fallback landline heuristic")
    return ParsedPhone(raw=raw, reason="fallback: unrecognised length")


def extract_numbers_from_html(html: str, region: str = "IN") -> list[tuple[str, str]]:
    """Return ``(raw, marked_context)`` pairs found in a public page.

    ``tel:`` hrefs are trusted most -- they are an explicit publication of a
    dialable number -- and come first. The page body is then scanned with
    libphonenumber's own text matcher where available, because Indian numbers
    are written in groupings (``+91 99999 10005``, ``0141 4567890``,
    ``(022) 2456 7890``) that a hand-rolled regex reliably gets wrong.

    Each context marks the number itself with ``{{ }}`` so
    :func:`classify_contact_type` can weigh nearby words more heavily than
    distant ones.
    """
    found: list[tuple[str, str]] = []
    seen: set[str] = set()

    for m in TEL_HREF_RE.finditer(html or ""):
        raw = m.group(1).strip()
        digits = re.sub(r"\D", "", raw)
        if raw and digits not in seen and len(digits) >= 8:
            seen.add(digits)
            found.append((raw, _context(html, m.start(), len(m.group(0)))))

    text = re.sub(r"<[^>]+>", " ", html or "")

    if _HAVE_PHONENUMBERS:
        try:
            for match in phonenumbers.PhoneNumberMatcher(text, region):
                digits = re.sub(r"\D", "", match.raw_string)
                if digits in seen:
                    continue
                seen.add(digits)
                found.append((match.raw_string,
                              _context(text, match.start, len(match.raw_string))))
            return found
        except Exception:
            pass   # fall through to the regex scanner

    for m in PHONE_TEXT_RE.finditer(text):
        raw = m.group(0).strip()
        digits = re.sub(r"\D", "", raw)
        if len(digits) < 10 or digits in seen:
            continue
        seen.add(digits)
        found.append((raw, _context(text, m.start(), len(raw))))
    return found


def _context(s: str, idx: int, match_len: int = 0, window: int = 120) -> str:
    """Text around a match, with the number itself wrapped in ``<<>>``.

    The marker is what lets :func:`classify_contact_type` judge *proximity*: a
    "direct line" label sitting beside the number is stronger evidence than the
    word "clinic" appearing anywhere in the same paragraph.
    """
    lo, hi = max(0, idx - window), min(len(s), idx + match_len + window)
    before = s[lo:idx]
    match = s[idx:idx + match_len] if match_len else ""
    after = s[idx + match_len:hi]
    joined = f"{before}{MARK_OPEN}{match}{MARK_CLOSE}{after}" if match_len else before + after
    return re.sub(r"\s+", " ", re.sub(r"<(?!<)[^>]+>", " ", joined)).strip().lower()


def _hint_distance(context: str, hints) -> int | None:
    """Character distance from the marked number to the nearest listed hint.

    Returns ``None`` when no hint appears. Distance -- not mere presence -- is
    what separates "Dr Joshi, direct line: X" from a reception number that
    happens to sit in the same paragraph as a doctor's name.
    """
    mark = context.find(MARK_OPEN)
    if mark < 0:
        return 0 if any(h in context for h in hints) else None
    close = context.find(MARK_CLOSE, mark)
    num_end = close + len(MARK_CLOSE) if close >= 0 else mark

    best: int | None = None
    for hint in hints:
        pos = context.find(hint)
        while pos >= 0:
            # Distance from the hint to the nearer edge of the number.
            dist = (mark - (pos + len(hint))) if pos < mark else (pos - num_end)
            dist = max(0, dist)
            if best is None or dist < best:
                best = dist
            pos = context.find(hint, pos + 1)
    return best


def classify_contact_type(
    context: str,
    *,
    person_name: str = "",
    from_business_listing: bool = False,
    is_mobile: bool = False,
    proximity: int = 45,
    name_proximity: int = 170,
) -> str:
    """Decide what kind of business contact a published number is.

    Whichever kind of label sits *closest* to the number wins. A number captioned
    for the named individual is a published direct line; one captioned
    "reception" or "call us" is the clinic's main line. With no label either way,
    it stays a clinic line -- the conservative, honest default.

    Two different windows, because real clinic markup puts them at different
    distances. A caption like "Direct line:" sits immediately beside the number,
    so it must be within ``proximity``. The person's *name*, though, is usually a
    heading with a bio paragraph beneath it -- comfortably past 45 characters and
    still unambiguously the same card. ``name_proximity`` is therefore wider, and
    a nearer general label ("reception") still wins, which is what stops the
    switchboard on a doctor's own page being read as her direct line.
    """
    ctx = (context or "").lower()

    if from_business_listing:
        # A Google Business Profile number is the clinic's own published line.
        return (ContactType.PUBLISHED_BUSINESS_MOBILE.value if is_mobile
                else ContactType.CLINIC_MAIN_LINE.value)

    surname = ""
    if person_name:
        parts = [p for p in re.sub(r"[^A-Za-z ]", " ", person_name).split()
                 if len(p) > 2 and p.lower() not in ("dr", "the")]
        surname = parts[-1].lower() if parts else ""

    d_direct = _hint_distance(ctx, _DIRECT_HINTS)
    d_general = _hint_distance(ctx, _MAIN_LINE_HINTS)
    d_named = _hint_distance(ctx, [surname]) if surname else None

    # The label must be adjacent; the name only needs to be in the same card.
    direct_close = d_direct is not None and d_direct <= proximity
    named_close = d_named is not None and d_named <= name_proximity
    general_close = d_general is not None and d_general <= proximity

    if direct_close and named_close:
        # A nearer "reception" still wins: a switchboard printed on a doctor's
        # own page is the clinic's line, not hers.
        if not general_close or d_direct < d_general:
            return ContactType.PUBLISHED_DIRECT_LINE.value

    if general_close:
        return ContactType.CLINIC_MAIN_LINE.value
    if d_general is not None and not (direct_close or named_close):
        return ContactType.CLINIC_MAIN_LINE.value
    if is_mobile:
        return ContactType.PUBLISHED_BUSINESS_MOBILE.value
    return ContactType.CLINIC_MAIN_LINE.value


def make_candidate(
    raw: str,
    *,
    provider: str,
    source_url: str,
    context: str = "",
    person_name: str = "",
    from_business_listing: bool = False,
    region: str = "IN",
    force_contact_type: str | None = None,
) -> PhoneCandidate | None:
    """Build a validated, classified candidate. Returns ``None`` if unusable."""
    import time as _time

    parsed = parse_phone(raw, region)
    if not parsed.valid or not parsed.e164:
        return None
    ctype = force_contact_type or classify_contact_type(
        context, person_name=person_name,
        from_business_listing=from_business_listing, is_mobile=parsed.is_mobile)
    return PhoneCandidate(
        number_e164=parsed.e164,
        number_raw=raw,
        contact_type=ctype,
        provider=provider,
        source_url=source_url,
        evidence=(context or "")[:240],
        is_mobile_range=parsed.is_mobile,
        checked_at=_time.time(),
    )


#: Ranking for choosing which published number to deliver. A number published
#: against the named individual beats the switchboard; both beat unclassified.
_PREFERENCE = {
    ContactType.PUBLISHED_DIRECT_LINE.value: 0,
    ContactType.PUBLISHED_BUSINESS_MOBILE.value: 1,
    ContactType.CLINIC_MAIN_LINE.value: 2,
    ContactType.UNKNOWN.value: 8,
    ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value: 9,
}


def select_exportable(
    candidates: list[PhoneCandidate],
    *,
    require_public_evidence: bool = True,
    allow_provider_personal_mobile: bool = False,
) -> tuple[PhoneCandidate | None, list[str]]:
    """Apply the export gate. Returns ``(chosen_or_None, rejection_reasons)``."""
    reasons: list[str] = []
    eligible: list[PhoneCandidate] = []

    for c in candidates:
        if c.contact_type == ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value:
            if not allow_provider_personal_mobile:
                reasons.append(
                    f"{c.number_e164}: provider-supplied with no publication "
                    f"evidence -- withheld by phone policy")
                continue
            # Even when an operator opts in, the label never changes.
            reasons.append(
                f"{c.number_e164}: provider-supplied, exported under operator "
                f"opt-in and NOT labelled as a verified personal mobile")
            eligible.append(c)
            continue
        if require_public_evidence and not c.has_public_evidence():
            reasons.append(f"{c.number_e164}: no public source URL -- withheld")
            continue
        eligible.append(c)

    if not eligible:
        return None, reasons
    eligible.sort(key=lambda c: (_PREFERENCE.get(c.contact_type, 5),
                                 0 if c.source_url else 1))
    return eligible[0], reasons
