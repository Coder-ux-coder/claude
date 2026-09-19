"""Deterministic extraction of candidate values from text the operator pastes.

Plain regular expressions only - no AI service, no OCR, no network.  Every
result is offered as a *suggestion* that the operator must accept explicitly.
A number is only ever proposed as a follower count when the word "follower"
actually sits next to it, so viewer counts, feedback scores and sales totals
are not mistaken for followers.
"""

from __future__ import annotations

import re

from .normalize import FieldError, normalize_email, parse_follower_count

_NUM = r"\d[\d.,]*\s*[KkMm]?"

# "12.5K followers"  /  "Followers: 12,500"  /  "followers 1.2k"
_FOLLOWER_PATTERNS = [
    re.compile(rf"(?P<num>{_NUM})\s*(?:\+\s*)?followers?\b", re.IGNORECASE),
    re.compile(rf"\bfollowers?\b\s*[:\-–]?\s*(?P<num>{_NUM})", re.IGNORECASE),
]

_EMAIL_PATTERN = re.compile(
    r"\b[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}\b"
)

#: Addresses that are almost never the streamer's own business contact.
_EMAIL_NOISE = re.compile(
    r"(?:^|@)(?:no-?reply|do-?not-?reply|postmaster|abuse|example\.(?:com|org|net)|"
    r"sentry\.io|wixpress\.com|\d+x\d+)", re.IGNORECASE
)

MAX_TEXT = 200_000


def extract(text: str) -> dict:
    """Return follower-count and email candidates found in ``text``."""
    body = (text or "")[:MAX_TEXT]
    notes: list[str] = []

    # ---- follower candidates -------------------------------------------
    follower_candidates: list[dict] = []
    seen_followers: set[str] = set()
    for pattern in _FOLLOWER_PATTERNS:
        for match in pattern.finditer(body):
            token = match.group("num").strip().rstrip(".,")
            if token.lower() in seen_followers:
                continue
            try:
                parsed = parse_follower_count(token)
            except FieldError:
                continue
            if parsed.value is None:
                continue
            seen_followers.add(token.lower())
            start = max(0, match.start() - 45)
            end = min(len(body), match.end() + 45)
            follower_candidates.append(
                {
                    "raw": token,
                    "value": parsed.value,
                    "approximate": parsed.approximate,
                    "context": " ".join(body[start:end].split()),
                }
            )

    if not follower_candidates:
        if re.search(r"\d", body):
            notes.append(
                "Numbers were found but none were labelled as followers. "
                "Please read the follower count from the profile and type it in."
            )
        else:
            notes.append("No follower count was found in this text.")
    elif len(follower_candidates) > 1:
        notes.append(
            f"{len(follower_candidates)} different follower figures were found - "
            "check the surrounding text before accepting one."
        )

    # ---- email candidates ----------------------------------------------
    email_candidates: list[dict] = []
    seen_emails: set[str] = set()
    for match in _EMAIL_PATTERN.finditer(body):
        token = match.group(0)
        if _EMAIL_NOISE.search(token):
            continue
        try:
            cleaned = normalize_email(token)
        except FieldError:
            continue
        if not cleaned or cleaned.lower() in seen_emails:
            continue
        seen_emails.add(cleaned.lower())
        start = max(0, match.start() - 45)
        end = min(len(body), match.end() + 45)
        email_candidates.append(
            {"email": cleaned, "context": " ".join(body[start:end].split())}
        )
        if len(email_candidates) >= 8:
            break

    if not email_candidates:
        notes.append("No email address was found in this text.")
    elif len(email_candidates) > 1:
        notes.append(
            f"{len(email_candidates)} addresses were found - confirm which one belongs "
            "to this streamer's business before accepting it."
        )

    return {
        "follower_candidates": follower_candidates[:8],
        "email_candidates": email_candidates,
        "notes": notes,
    }
