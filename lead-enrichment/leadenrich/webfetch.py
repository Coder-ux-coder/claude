"""Fetching real public web pages safely.

The clinic sites this reads are small Indian practices, and they behave nothing
like an API. In the wild you meet: no declared charset (or a lying one), pages
served as ``text/html`` that are really a 40 MB PDF, redirect loops between
``www`` and apex, sites that only exist on ``http``, Cloudflare interstitials,
and single-page apps whose contact number never appears in the HTML at all.

Every one of those has a specific handling below, because each of them
otherwise shows up as "no phone found" -- an answer that is wrong in a way you
cannot see.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

import requests

#: Only these are worth parsing for a phone number.
HTML_TYPES = ("text/html", "application/xhtml+xml", "text/plain")

#: Markers of a page that exists but has no readable content for us: an
#: anti-bot interstitial, or a shell whose content arrives via JavaScript.
WALL_MARKERS = (
    "just a moment", "checking your browser", "cf-browser-verification",
    "enable javascript to run this app", "please enable javascript",
    "captcha-delivery", "ddos protection by",
)

#: Links whose text or href suggests the site's own contact page. Following the
#: site's own navigation beats guessing paths, because Indian clinic sites use
#: /reach-us, /appointments, /book, /branches and a dozen other conventions.
CONTACT_LINK_RE = re.compile(
    r'<a\b[^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*>(.{0,80}?)</a>',
    re.I | re.S)
CONTACT_WORDS = ("contact", "reach us", "reach-us", "get in touch", "enquiry",
                 "enquiries", "appointment", "book", "locate", "branches",
                 "our clinic", "visit us", "find us")


@dataclass
class FetchResult:
    url: str = ""
    final_url: str = ""
    status: int = 0
    text: str = ""
    ok: bool = False
    reason: str = ""
    truncated: bool = False
    blocked_by_robots: bool = False
    js_wall: bool = False
    bytes_read: int = 0
    links: list[tuple[str, str]] = field(default_factory=list)


#: Single-byte encodings that decode *any* byte sequence without complaint.
#: A page declaring one of these has told us nothing, because the decode cannot
#: fail even when the declaration is wrong.
PERMISSIVE = {"iso-8859-1", "iso8859-1", "latin-1", "latin1", "cp1252",
              "windows-1252", "ascii", "us-ascii"}


def _decode(content: bytes, declared: str | None) -> str:
    """Decode page bytes, distrusting a declaration that cannot be wrong.

    Older Indian hosting very often serves UTF-8 while declaring
    ``iso-8859-1``. Honouring that declaration succeeds -- latin-1 maps every
    byte -- and yields mojibake, which corrupts the digits and separators the
    phone extractor depends on. So when the declared encoding is one that
    cannot fail, UTF-8 is tried first and preferred if it decodes cleanly and
    the page actually contains non-ASCII bytes to disagree about.
    """
    declared_norm = (declared or "").strip().lower()
    has_high_bytes = any(b >= 0x80 for b in content)

    if has_high_bytes and (not declared_norm or declared_norm in PERMISSIVE):
        try:
            return content.decode("utf-8")
        except UnicodeDecodeError:
            pass          # genuinely not UTF-8; the declaration may be right

    for enc in (declared, "utf-8", "cp1252", "latin-1"):
        if not enc:
            continue
        try:
            return content.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return content.decode("utf-8", errors="replace")


def _charset_of(content_type: str) -> str | None:
    m = re.search(r"charset=([\w\-]+)", content_type or "", re.I)
    return m.group(1) if m else None


def candidate_origins(domain: str) -> list[str]:
    """Real sites are inconsistent about scheme and www. Try the likely ones.

    Ordered by what is most likely to be canonical, so the first success is
    usually the only request made.
    """
    d = (domain or "").strip().lower()
    d = re.sub(r"^https?://", "", d).split("/")[0]
    if not d:
        return []
    bare = d[4:] if d.startswith("www.") else d
    return [f"https://{bare}", f"https://www.{bare}",
            f"http://{bare}", f"http://www.{bare}"]


def find_contact_links(html: str, base_url: str, limit: int = 4) -> list[str]:
    """Contact-ish links from the page's own navigation, most promising first."""
    scored: list[tuple[int, str]] = []
    seen: set[str] = set()
    base_host = urlparse(base_url).netloc.lower()

    for m in CONTACT_LINK_RE.finditer(html or ""):
        href, label = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2)).lower()
        if href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        full = urljoin(base_url, href)
        if urlparse(full).netloc.lower() != base_host:
            continue          # never wander off the clinic's own site
        full = full.split("#")[0]
        if full in seen:
            continue
        haystack = (label + " " + href).lower()
        score = sum(2 if w in label else 1
                    for w in CONTACT_WORDS if w in haystack)
        if score:
            seen.add(full)
            scored.append((score, full))

    scored.sort(key=lambda t: -t[0])
    return [u for _s, u in scored[:limit]]


def fetch_page(session, url: str, *, user_agent: str, timeout: float = 20.0,
               max_bytes: int = 2_000_000, max_redirects: int = 5) -> FetchResult:
    """Fetch one page defensively. Never raises; every failure is a reason."""
    res = FetchResult(url=url)
    try:
        resp = session.get(
            url,
            headers={"User-Agent": user_agent,
                     "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                     "Accept-Language": "en-IN,en;q=0.9"},
            timeout=timeout, stream=True, allow_redirects=True)
    except requests.TooManyRedirects:
        res.reason = "redirect loop"
        return res
    except requests.Timeout:
        res.reason = f"timed out after {timeout}s"
        return res
    except Exception as exc:
        res.reason = f"unreachable: {type(exc).__name__}"
        return res

    res.status = getattr(resp, "status_code", 0)
    res.final_url = str(getattr(resp, "url", url) or url)
    headers = {k.lower(): v for k, v in (getattr(resp, "headers", {}) or {}).items()}

    if len(getattr(resp, "history", []) or []) > max_redirects:
        res.reason = f"more than {max_redirects} redirects"
        return res

    if res.status != 200:
        res.reason = f"HTTP {res.status}"
        return res

    ctype = headers.get("content-type", "")
    if ctype and not any(t in ctype.lower() for t in HTML_TYPES):
        # A PDF brochure or an image is a legitimate page, just not one we can
        # read a captioned phone number out of.
        res.reason = f"not a readable page ({ctype.split(';')[0]})"
        return res

    # Read with a hard ceiling. A stream cap is the only protection against a
    # site that advertises a small page and then never stops sending.
    chunks, total = [], 0
    try:
        for chunk in resp.iter_content(chunk_size=32_768):
            if not chunk:
                continue
            chunks.append(chunk)
            total += len(chunk)
            if total >= max_bytes:
                res.truncated = True
                break
    except Exception as exc:
        if not chunks:
            res.reason = f"read failed: {type(exc).__name__}"
            return res
    finally:
        try:
            resp.close()
        except Exception:
            pass

    res.bytes_read = total
    res.text = _decode(b"".join(chunks), _charset_of(ctype))

    low = res.text[:4000].lower()
    if any(marker in low for marker in WALL_MARKERS):
        # Say so explicitly. "No number found" would be a lie: we never saw the
        # page, and a human opening it in a browser probably would.
        res.js_wall = True
        res.reason = ("page needs JavaScript or is behind bot protection -- "
                      "check this one by hand")
        return res

    if len(res.text.strip()) < 200:
        res.reason = "page was effectively empty"
        return res

    res.links = [(u, "") for u in find_contact_links(res.text, res.final_url)]
    res.ok = True
    return res
