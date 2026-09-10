"""Input normalisation, LinkedIn slug parsing, and dedupe keys.

The slug parser is the pipeline's free baseline: it derives a probable person
name from a URL the client already holds, with no API call and without touching
LinkedIn at all. It is deliberately conservative -- confidence is always ``low``
and it never fills the delivered Name column on its own.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import urlparse

#: Honorifics and post-nominals that appear inside LinkedIn slugs but are not names.
HONORIFICS = {"dr", "doctor", "prof", "professor", "mr", "mrs", "ms", "miss",
              "shri", "smt", "capt", "col", "maj", "vet"}
POST_NOMINALS = {"mbbs", "md", "ms", "mds", "bds", "dnb", "phd", "mba", "frcs",
                 "mrcp", "dm", "mch", "bams", "bhms", "pgdm", "facs", "fics"}
#: Slug tail noise: LinkedIn appends a hex/numeric discriminator to most handles.
_NOISE_RE = re.compile(r"^[0-9a-f]{2,}$|^\d+$")

#: Canonical decision-maker roles, most senior first. Order is the priority:
#: a title reading "Founder & Medical Director" is reported as Founder, because
#: ownership is the signal this brief is buying.
ROLE_KEYWORDS: list[tuple[tuple[str, ...], str]] = [
    (("co-founder", "cofounder", "co founder"), "Co-Founder"),
    (("founder",), "Founder"),
    (("proprietor",), "Proprietor"),
    (("owner",), "Owner"),
    (("chairman", "chairperson"), "Chairman"),
    (("managing director",), "Managing Director"),
    (("chief executive officer", "chief executive", "ceo"), "CEO"),
    (("managing partner",), "Managing Partner"),
    (("partner",), "Partner"),
    (("principal",), "Principal"),
    (("medical director",), "Medical Director"),
    (("clinical director",), "Clinical Director"),
    (("director",), "Director"),
    (("practice manager",), "Practice Manager"),
    (("administrator",), "Administrator"),
    (("head",), "Head"),
    (("chief",), "Chief"),
    (("consultant",), "Consultant"),
]

#: Tokens that mark an organisation as a clinic-like healthcare provider.
CLINIC_KEYWORDS = {"clinic", "clinics", "hospital", "hospitals", "healthcare",
                   "health", "medical", "medicare", "dental", "dentistry",
                   "polyclinic", "nursing", "diagnostics", "diagnostic", "care",
                   "wellness", "ayurveda", "homeopathy", "physiotherapy",
                   "eye", "skin", "derma", "ivf", "fertility", "ortho",
                   "cardiac", "surgery", "surgical", "labs", "laboratory"}

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
ROLE_LOCALPARTS = {"info", "contact", "admin", "office", "hello", "help",
                   "support", "sales", "enquiry", "enquiries", "inquiry",
                   "reception", "appointments", "care", "team", "mail",
                   "clinic", "frontdesk", "billing", "accounts", "hr", "no-reply",
                   "noreply", "webmaster", "postmaster"}
FREE_WEBMAIL_DOMAINS = {"gmail.com", "yahoo.com", "yahoo.co.in", "hotmail.com",
                        "outlook.com", "rediffmail.com", "live.com", "aol.com",
                        "icloud.com", "protonmail.com", "ymail.com", "msn.com"}


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s)
                   if not unicodedata.combining(c))


def clean_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def titlecase_name(s: str) -> str:
    """Title-case a name without mangling ``McRae``/``O'Brien``-style forms."""
    out = []
    for part in clean_ws(s).split(" "):
        if not part:
            continue
        if part.isupper() and len(part) <= 4:   # keep initials/acronyms
            out.append(part)
        else:
            out.append(part[:1].upper() + part[1:].lower())
    return " ".join(out)


# ---------------------------------------------------------------- LinkedIn ---

@dataclass
class SlugParse:
    slug: str = ""
    probable_first: str = ""
    probable_last: str = ""
    probable_full: str = ""
    honorific: str = ""
    confidence: str = "none"


def linkedin_slug(url: str) -> str:
    """Extract the ``/in/<slug>`` handle. Returns '' when the URL is not a profile."""
    if not url:
        return ""
    u = url.strip()
    if not u.lower().startswith(("http://", "https://")):
        u = "https://" + u
    try:
        parsed = urlparse(u)
    except ValueError:
        return ""
    host = (parsed.netloc or "").lower()
    if "linkedin.com" not in host:
        return ""
    parts = [p for p in (parsed.path or "").split("/") if p]
    for marker in ("in", "pub"):
        if marker in parts:
            i = parts.index(marker)
            if i + 1 < len(parts):
                return parts[i + 1].lower()
    return ""


def canonical_linkedin_url(url: str) -> str:
    slug = linkedin_slug(url)
    return f"https://www.linkedin.com/in/{slug}" if slug else (url or "").strip()


def parse_slug(url_or_slug: str) -> SlugParse:
    """Derive a probable name from a LinkedIn handle.

    ``dr-anjali-mehta-8b41a2`` -> honorific ``Dr``, first ``Anjali``, last ``Mehta``.
    Confidence is capped at ``low``: slugs are user-chosen and may be nicknames,
    transliterations or vanity strings.
    """
    slug = linkedin_slug(url_or_slug) or (url_or_slug or "").strip().lower()
    res = SlugParse(slug=slug)
    if not slug:
        return res

    tokens = [t for t in re.split(r"[-_.]+", slug) if t]
    honorific = ""
    if tokens and tokens[0] in HONORIFICS:
        honorific = tokens[0]
        tokens = tokens[1:]
    words = [t for t in tokens
             if not _NOISE_RE.match(t) and t not in POST_NOMINALS and len(t) > 1]

    res.honorific = honorific.capitalize() if honorific else ""
    if not words:
        return res
    if len(words) == 1:
        res.probable_first = titlecase_name(words[0])
        res.probable_full = res.probable_first
        res.confidence = "low"
        return res

    res.probable_first = titlecase_name(words[0])
    res.probable_last = titlecase_name(words[-1])
    res.probable_full = titlecase_name(" ".join(words[:3]))
    res.confidence = "low"
    return res


# ------------------------------------------------------------------ people ---

def split_name(full: str) -> tuple[str, str]:
    """Split a display name into (first, last), dropping honorifics/post-nominals."""
    cleaned = clean_ws(re.sub(r"[,.]", " ", full or ""))
    words = [w for w in cleaned.split(" ") if w]
    words = [w for w in words if w.lower().strip(".") not in HONORIFICS]
    words = [w for w in words if w.lower().strip(".") not in POST_NOMINALS]
    if not words:
        return "", ""
    if len(words) == 1:
        return titlecase_name(words[0]), ""
    return titlecase_name(words[0]), titlecase_name(words[-1])


def name_tokens(name: str) -> set[str]:
    n = strip_accents(clean_ws(name or "")).lower()
    n = re.sub(r"[^a-z0-9 ]+", " ", n)
    return {w for w in n.split()
            if len(w) > 1 and w not in HONORIFICS and w not in POST_NOMINALS}


def name_similarity(a: str, b: str) -> float:
    """Jaccard over name tokens. 1.0 = same token set, 0.0 = disjoint."""
    ta, tb = name_tokens(a), name_tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def company_similarity(a: str, b: str) -> float:
    """Company-name overlap, ignoring legal suffixes and generic clinic words."""
    stop = {"pvt", "private", "ltd", "limited", "llp", "inc", "the", "and", "&",
            "co", "company", "india"}
    def toks(s: str) -> set[str]:
        s = strip_accents(clean_ws(s or "")).lower()
        s = re.sub(r"[^a-z0-9 ]+", " ", s)
        return {w for w in s.split() if len(w) > 1 and w not in stop}
    ta, tb = toks(a), toks(b)
    if not ta or not tb:
        return 0.0
    # Distinctive tokens decide. Both names containing "clinic" is not evidence
    # they are the same clinic, so when each side has a distinctive part, only
    # those parts count -- including when they do not overlap at all.
    da, db = ta - CLINIC_KEYWORDS, tb - CLINIC_KEYWORDS
    if da and db:
        return len(da & db) / len(da | db)
    return len(ta & tb) / len(ta | tb)


def looks_like_clinic(name: str) -> bool:
    return bool(name_tokens(name) & CLINIC_KEYWORDS)


def normalise_role(title: str) -> str:
    """Map a free-text title onto a canonical decision-maker role.

    Matching runs in seniority order, so a compound title resolves to its most
    senior component: "Founder & Medical Director" -> ``Founder``. Titles that
    match nothing pass through unchanged rather than being discarded.
    """
    t = clean_ws(title or "")
    if not t:
        return ""
    low = t.lower()
    for needles, canonical in ROLE_KEYWORDS:
        for needle in needles:
            if re.search(rf"\b{re.escape(needle)}\b", low):
                return canonical
    return t


# ------------------------------------------------------------------ domains ---

def normalise_domain(value: str) -> str:
    """Reduce a URL or bare host to a registrable-looking domain."""
    v = clean_ws(value or "").lower()
    if not v:
        return ""
    if "@" in v:
        v = v.split("@", 1)[1]
    if v.startswith(("http://", "https://")):
        try:
            v = urlparse(v).netloc
        except ValueError:
            return ""
    v = v.split("/")[0].split("?")[0].strip()
    if v.startswith("www."):
        v = v[4:]
    return v if "." in v and " " not in v else ""


def email_domain(addr: str) -> str:
    return addr.rsplit("@", 1)[1].lower() if addr and "@" in addr else ""


def is_role_account(addr: str) -> bool:
    if not addr or "@" not in addr:
        return False
    local = addr.split("@", 1)[0].lower()
    local = re.sub(r"[._\-+].*$", "", local) if local.split(".")[0] in ROLE_LOCALPARTS else local
    return local in ROLE_LOCALPARTS


def is_free_webmail(addr: str) -> bool:
    return email_domain(addr) in FREE_WEBMAIL_DOMAINS


def valid_email_syntax(addr: str) -> bool:
    return bool(addr) and bool(EMAIL_RE.fullmatch(addr.strip()))


# ------------------------------------------------------------------- dedupe ---

def dedupe_key(linkedin_url: str = "", full_name: str = "",
               company: str = "", domain: str = "", email: str = "") -> str:
    """Stable identity key, most-reliable signal first.

    LinkedIn slug wins outright. Failing that, name+domain, then name+company.
    Rows with none of these get a unique key so they are never merged blindly.
    """
    slug = linkedin_slug(linkedin_url)
    if slug:
        return f"li:{slug}"
    if email and "@" in email:
        return f"em:{email.strip().lower()}"
    n = "-".join(sorted(name_tokens(full_name)))
    d = normalise_domain(domain)
    if n and d:
        return f"nd:{n}|{d}"
    c = "-".join(sorted(name_tokens(company)))
    if n and c:
        return f"nc:{n}|{c}"
    return ""
