"""Google search-query generation.

The application only ever *builds* a search URL.  It is opened by an explicit
click from the operator in their own browser; nothing here sends a request to
Google or reads any result.
"""

from __future__ import annotations

from urllib.parse import quote_plus

GOOGLE = "https://www.google.com/search?q="

PLATFORMS = {
    "whatnot": {
        "label": "Whatnot",
        "home_url": "https://www.whatnot.com/",
        "home_label": "Open Whatnot",
    },
    "ebay_live": {
        "label": "eBay Live",
        "home_url": "https://www.ebay.com/eBayLive",
        "home_label": "Open eBay Live",
    },
}

TOPICS = [
    {"id": "all", "label": "All categories", "term": ""},
    {"id": "trading_cards", "label": "Trading cards", "term": "trading cards"},
    {"id": "sneakers", "label": "Sneakers", "term": "sneakers"},
    {"id": "fashion", "label": "Fashion", "term": "fashion"},
    {"id": "collectibles", "label": "Collectibles", "term": "collectibles"},
    {"id": "electronics", "label": "Electronics", "term": "electronics"},
]

_TOPIC_BY_ID = {t["id"]: t for t in TOPICS}

_WHATNOT_TEMPLATES = [
    ("site:whatnot.com/user/ {term}", "Profile pages in this category"),
    ("site:whatnot.com/user/ {term} seller", "Profiles that describe themselves as sellers"),
    ('site:whatnot.com/user/ {term} "followers"', "Profiles where a follower count is indexed"),
    ("site:whatnot.com/user/ {term} (contact OR email OR business)", "Profiles mentioning contact details"),
    ('"whatnot.com/user" {term} livestream seller', "Mentions of Whatnot profiles elsewhere on the web"),
    ('"whatnot" {term} seller (instagram OR linktree)', "Cross-posted social profiles that may list a business email"),
]

_EBAY_TEMPLATES = [
    ('"eBay Live" {term} seller', "Sellers mentioned alongside eBay Live"),
    ('"eBay Live" {term} livestream', "Livestream listings and write-ups"),
    ('site:ebay.com "eBay Live" {term}', "eBay's own pages referencing Live"),
    ('"eBay Live" {term} host', "Named hosts of eBay Live shows"),
    ('"eBay Live" {term} (contact OR email OR business)', "Pages that may carry a business email"),
    ('site:ebay.com/usr {term} seller', "eBay seller profile pages in this category"),
]


def _clean(template: str, term: str) -> str:
    query = template.replace("{term}", term)
    return " ".join(query.split())


def google_url(query: str) -> str:
    return GOOGLE + quote_plus(query)


def build_searches(platform: str, topic_id: str) -> list[dict]:
    """Return the generated search variations for a platform and topic."""
    if platform not in PLATFORMS:
        raise KeyError(platform)
    topic = _TOPIC_BY_ID.get(topic_id, _TOPIC_BY_ID["all"])
    templates = _WHATNOT_TEMPLATES if platform == "whatnot" else _EBAY_TEMPLATES

    searches = []
    for template, note in templates:
        query = _clean(template, topic["term"])
        searches.append({"query": query, "note": note, "url": google_url(query)})
    return searches


def email_searches(identifier: str, profile_url: str) -> list[dict]:
    """Searches for a streamer's publicly listed business email.

    Built only from the profile's publicly visible identifier (the username in
    the URL).  No address is ever generated or guessed from these.
    """
    name = (identifier or "").strip()
    if not name:
        return []

    host = ""
    if "//" in profile_url:
        host = profile_url.split("//", 1)[1].split("/", 1)[0].lower()
    platform_word = "whatnot" if "whatnot" in host else ("ebay" if "ebay" in host else "")

    templates = [
        (f'"{name}" {platform_word} (email OR contact)', "Contact details mentioned with the username"),
        (f'"{name}" "business email"', "Pages that state a business email"),
        (f'"{name}" (instagram OR linktree OR youtube) contact', "Linked social profiles that may list a contact address"),
        (f'"{name}" shop contact email -site:whatnot.com -site:ebay.com', "Their own store or website"),
    ]
    return [
        {"query": " ".join(q.split()), "note": note, "url": google_url(" ".join(q.split()))}
        for q, note in templates
    ]
