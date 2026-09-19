"""Deterministic cleaning and validation for the three lead fields.

Everything in this module is plain Python: no network calls, no third-party
services, no guessing.  A value is either understood exactly or reported back
to the operator with a message asking them to supply it manually.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# --------------------------------------------------------------------------
# Profile link
# --------------------------------------------------------------------------

#: Query parameters that only carry campaign / referral tracking.  They are
#: dropped because they never identify the profile itself.  Anything not on
#: this list is preserved verbatim - we do not guess at unknown URL formats.
TRACKING_PARAMS = frozenset(
    {
        # generic campaign tracking
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "utm_id", "utm_name", "utm_reader", "utm_social",
        # ad-network click identifiers
        "fbclid", "gclid", "gbraid", "wbraid", "msclkid", "dclid", "yclid",
        "ttclid", "twclid", "irclickid", "igshid", "igsh", "scid",
        # mail platforms
        "mc_cid", "mc_eid", "vero_id", "vero_conv",
        # app / referral attribution
        "_branch_match_id", "_branch_referrer", "ref", "ref_src", "ref_url",
        "referrer", "share_id", "si", "spm",
        # eBay campaign tracking
        "mkevt", "mkcid", "mkrid", "campid", "customid", "toolid",
        "_trksid", "_trkparms", "amdata", "norover",
    }
)

_PASTE_NOISE = " \t\r\n\"'<>«»​‎‏"


@dataclass
class UrlResult:
    """Outcome of normalising a pasted profile link."""

    url: str                       # cleaned link, stored and exported
    key: str                       # canonical form used for duplicate checks
    hints: list[str] = field(default_factory=list)
    identifier: str = ""           # last path segment, e.g. the username


class FieldError(ValueError):
    """A field could not be understood.  Carries an operator-facing message."""


def normalize_profile_url(raw: str | None) -> UrlResult:
    """Clean a pasted profile link and derive its duplicate-detection key.

    Raises :class:`FieldError` with a plain-language message when the value is
    not a usable http(s) URL.
    """
    text = (raw or "").strip().strip(_PASTE_NOISE).strip()
    if not text:
        raise FieldError("Profile link is empty. Paste the streamer's profile URL.")

    if "://" not in text:
        if text.startswith("//"):
            text = "https:" + text
        else:
            text = "https://" + text

    try:
        parts = urlsplit(text)
    except ValueError as exc:  # pragma: no cover - urlsplit rarely raises
        raise FieldError(f"That profile link could not be read: {exc}") from exc

    scheme = (parts.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise FieldError("Profile link must start with http:// or https://")

    try:
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError as exc:
        raise FieldError(f"That profile link has an invalid port: {exc}") from exc

    if not host:
        raise FieldError("Profile link is missing a website address.")
    if "." not in host.strip(".") or host.endswith(".") or host.startswith("."):
        raise FieldError(f"'{host}' is not a valid website address.")
    if re.search(r"\s", host):
        raise FieldError("Profile link contains a space in the website address.")

    netloc = host
    if port and port not in (80, 443):
        netloc = f"{host}:{port}"

    path = parts.path or "/"
    if len(path) > 1:
        path = path.rstrip("/") or "/"

    kept_pairs = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k.lower() not in TRACKING_PARAMS
    ]
    query = urlencode(kept_pairs)

    # The fragment is kept on the stored link (no information is thrown away)
    # but excluded from the duplicate key, because #section never identifies a
    # different profile.
    url = urlunsplit((scheme, netloc, path, query, parts.fragment))

    key_host = host[4:] if host.startswith("www.") else host
    key_netloc = f"{key_host}:{port}" if port and port not in (80, 443) else key_host
    key_path = path.lower()
    key_query = urlencode(sorted(kept_pairs))
    key = f"{key_netloc}{key_path}" + (f"?{key_query}" if key_query else "")

    hints: list[str] = []
    if path in ("", "/"):
        hints.append(
            "This looks like a site homepage rather than a profile page. "
            "Check that you copied the streamer's own profile URL."
        )
    if len(kept_pairs) < len(parse_qsl(parts.query, keep_blank_values=True)):
        hints.append("Tracking parameters were removed from the link.")

    identifier = ""
    segments = [seg for seg in path.split("/") if seg]
    if segments:
        identifier = segments[-1]

    return UrlResult(url=url, key=key, hints=hints, identifier=identifier)


# --------------------------------------------------------------------------
# Follower count
# --------------------------------------------------------------------------

_FOLLOWER_RE = re.compile(
    r"""^
    (?P<num>
        \d{1,3}(?:,\d{3})+      # 1,250
        |\d+(?:\.\d+)?          # 1250  or  1.2
    )
    \s*
    (?P<suffix>[kKmMbB])?
    $""",
    re.VERBOSE,
)

_MULTIPLIER = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}
_FOLLOWER_MAX = 10_000_000_000


@dataclass
class FollowerResult:
    """A parsed follower count.

    ``approximate`` is True whenever the operator entered a rounded, abbreviated
    figure such as ``1.2K``.  The flag travels with the record so the number is
    never presented as an exact reading of the profile.
    """

    value: int | None
    raw: str
    approximate: bool


def parse_follower_count(raw: str | None) -> FollowerResult:
    """Convert an entered follower count into a whole number.

    An empty value is allowed - the lead simply stays incomplete.
    """
    text = (raw or "").strip().replace(" ", " ").replace(" ", " ").strip()
    if not text:
        return FollowerResult(value=None, raw="", approximate=False)

    cleaned = re.sub(r"(?i)\bfollowers?\b", "", text).strip()
    cleaned = cleaned.lstrip("+").strip()
    if not cleaned:
        raise FieldError(
            "No number found in the follower count. "
            "Open the profile and enter the figure shown."
        )

    match = _FOLLOWER_RE.match(cleaned)
    if not match:
        raise FieldError(
            f"'{text}' is not a follower count we can read. "
            "Use a form such as 1250, 1,250 or 1.2K."
        )

    number = match.group("num").replace(",", "")
    suffix = (match.group("suffix") or "").lower()

    if suffix:
        value = float(number) * _MULTIPLIER[suffix]
        approximate = True
    else:
        if "." in number:
            raise FieldError(
                f"'{text}' looks like a partial number. "
                "Enter a whole number such as 1250, or an abbreviation such as 1.2K."
            )
        value = float(number)
        approximate = False

    if value < 0:
        raise FieldError("Follower count cannot be negative.")
    if value > _FOLLOWER_MAX:
        raise FieldError("That follower count is implausibly large. Please re-check the profile.")

    return FollowerResult(value=int(round(value)), raw=text, approximate=approximate)


# --------------------------------------------------------------------------
# Email address
# --------------------------------------------------------------------------

_EMAIL_RE = re.compile(
    r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$"
)


def normalize_email(raw: str | None) -> str | None:
    """Trim and format-check an email address.

    A valid format is *not* a claim that the address is deliverable or that it
    belongs to the streamer - that judgement stays with the operator.
    """
    text = (raw or "").strip().strip(_PASTE_NOISE).strip()
    if not text:
        return None

    if text.lower().startswith("mailto:"):
        text = text[7:].strip()
    text = text.strip("<>").strip().rstrip(".,;:")

    if not text:
        return None
    if len(text) > 254:
        raise FieldError("That email address is too long to be valid.")
    if text.count("@") != 1:
        raise FieldError(f"'{text}' is not a valid email address - it needs exactly one @ sign.")

    local, _, domain = text.partition("@")
    if not _EMAIL_RE.match(text):
        raise FieldError(f"'{text}' is not a valid email address.")
    if len(local) > 64:
        raise FieldError("The part before the @ sign is too long to be valid.")

    return f"{local}@{domain.lower()}"
