"""SQLite storage for leads.

One table, one file, no migrations framework.  The database lives next to the
backend by default so a lead session survives restarts of both the API and the
browser.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "leads.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_url     TEXT    NOT NULL,
    url_key         TEXT    NOT NULL UNIQUE,
    follower_count  INTEGER,
    follower_raw    TEXT    NOT NULL DEFAULT '',
    follower_approx INTEGER NOT NULL DEFAULT 0,
    email_address   TEXT,
    status          TEXT    NOT NULL DEFAULT 'incomplete',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_updated ON leads(updated_at DESC);
"""


def db_path() -> Path:
    """Where the SQLite file lives (override with STREAMER_LEADS_DB)."""
    override = os.environ.get("STREAMER_LEADS_DB")
    return Path(override).expanduser().resolve() if override else DEFAULT_DB_PATH


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """Open a short-lived connection with foreign keys and row access by name."""
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
