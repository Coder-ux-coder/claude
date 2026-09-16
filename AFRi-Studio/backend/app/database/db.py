"""SQLite schema and access.

Large assets live on disk; the database holds structure, configuration
snapshots, validation results and job state.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.app.core.config import DB_PATH

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS concepts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT DEFAULT '', split_type TEXT DEFAULT '',
    archived INTEGER DEFAULT 0, head_version TEXT,
    created_at REAL NOT NULL, updated_at REAL NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY, concept_id TEXT NOT NULL, parent_id TEXT,
    number INTEGER NOT NULL, config TEXT NOT NULL, description TEXT DEFAULT '',
    author TEXT DEFAULT 'user', validation TEXT DEFAULT '{}',
    stats TEXT DEFAULT '{}', assets TEXT DEFAULT '{}',
    preferred INTEGER DEFAULT 0, approved INTEGER DEFAULT 0,
    hypothesis TEXT DEFAULT '', created_at REAL NOT NULL,
    FOREIGN KEY(concept_id) REFERENCES concepts(id)
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, concept_id TEXT, version_id TEXT, type TEXT NOT NULL,
    status TEXT NOT NULL, spec TEXT NOT NULL, stage TEXT DEFAULT '',
    message TEXT DEFAULT '', progress_index INTEGER DEFAULT 0,
    progress_total INTEGER DEFAULT 0, error TEXT DEFAULT '',
    outputs TEXT DEFAULT '{}', logs TEXT DEFAULT '[]',
    created_at REAL NOT NULL, started_at REAL, finished_at REAL,
    dedupe_key TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS assistant_messages (
    id TEXT PRIMARY KEY, concept_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
    commands TEXT DEFAULT '[]', provider TEXT DEFAULT '', status TEXT DEFAULT 'ok',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS refine_runs (
    id TEXT PRIMARY KEY, concept_id TEXT NOT NULL, status TEXT NOT NULL,
    config TEXT NOT NULL, iterations TEXT DEFAULT '[]', stop_reason TEXT DEFAULT '',
    created_at REAL NOT NULL, finished_at REAL
);
CREATE TABLE IF NOT EXISTS references_ (
    id TEXT PRIMARY KEY, concept_id TEXT, filename TEXT NOT NULL,
    kind TEXT NOT NULL, path TEXT NOT NULL, notes TEXT DEFAULT '',
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_concept ON versions(concept_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_concepts_project ON concepts(project_id);
"""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        _local.conn = conn
    return conn


@contextmanager
def tx():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def init_db():
    with tx() as c:
        c.executescript(SCHEMA)


def row_to_dict(row: sqlite3.Row | None, json_fields=()) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    for f in json_fields:
        if f in d and isinstance(d[f], str):
            try:
                d[f] = json.loads(d[f])
            except json.JSONDecodeError:
                d[f] = {}
    return d


def now() -> float:
    return time.time()
