"""CSV generation for the client deliverable.

Exactly three columns, approved leads only, UTF-8 with a BOM so Excel and
Google Sheets both read non-ASCII characters correctly.
"""

from __future__ import annotations

import csv
import io
from datetime import date

HEADERS = ["Profile Link", "Follower Count", "Email Address"]

#: A leading character in this set makes a spreadsheet treat the cell as a
#: formula.  Tab and carriage return are included because Excel strips them
#: before evaluating the cell.
_RISKY_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def guard_cell(value: object) -> str:
    """Neutralise spreadsheet formula injection without altering real data.

    A leading apostrophe is prepended to anything a spreadsheet would evaluate.
    Valid URLs, whole numbers and email addresses never start with a risky
    character, so they pass through byte for byte.
    """
    text = "" if value is None else str(value)
    if text.startswith(_RISKY_PREFIXES):
        return "'" + text
    return text


def rows_for_export(leads: list[dict]) -> list[list[str]]:
    """Build the exact rows that will be written, de-duplicated by URL key."""
    seen: set[str] = set()
    rows: list[list[str]] = []
    for lead in leads:
        key = lead.get("url_key") or lead.get("profile_url", "")
        if key in seen:
            continue
        seen.add(key)
        followers = lead.get("follower_count")
        rows.append(
            [
                guard_cell(lead.get("profile_url", "")),
                guard_cell("" if followers is None else int(followers)),
                guard_cell(lead.get("email_address") or ""),
            ]
        )
    return rows


def build_csv(leads: list[dict]) -> str:
    """Render the approved leads as a CSV document."""
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(HEADERS)
    writer.writerows(rows_for_export(leads))
    return buffer.getvalue()


def export_filename(today: date | None = None) -> str:
    stamp = (today or date.today()).isoformat()
    return f"streamer_leads_{stamp}.csv"
