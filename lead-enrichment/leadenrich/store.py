"""SQLite checkpoint store.

Resumability is the difference between a 2,000-row paid run being restartable
and being re-purchased. Each row's full state is persisted after every stage, so
a crash, a rate-limit wall or a deliberate Ctrl-C costs at most one stage of one
row -- never a repeated paid call for work already done.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Iterator

from .models import LeadRecord

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id      TEXT PRIMARY KEY,
    created_at  REAL NOT NULL,
    config_json TEXT NOT NULL,
    input_path  TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    notes       TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS rows (
    run_id      TEXT NOT NULL,
    row_id      TEXT NOT NULL,
    dedupe_key  TEXT,
    state       TEXT NOT NULL DEFAULT 'pending',
    record_json TEXT NOT NULL,
    updated_at  REAL NOT NULL,
    PRIMARY KEY (run_id, row_id)
);
CREATE INDEX IF NOT EXISTS idx_rows_state   ON rows(run_id, state);
CREATE INDEX IF NOT EXISTS idx_rows_dedupe  ON rows(run_id, dedupe_key);
CREATE TABLE IF NOT EXISTS budget_state (
    run_id   TEXT PRIMARY KEY,
    payload  TEXT NOT NULL
);
"""


class Store:
    """Thread-safe enough for the pipeline's bounded worker pool."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            # WAL keeps readers (the review UI) from blocking the writer (a run).
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------------ runs
    def create_run(self, run_id: str, config_json: str, input_path: str = "") -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO runs(run_id, created_at, config_json, input_path)"
                " VALUES (?,?,?,?)",
                (run_id, time.time(), config_json, input_path))
            self._conn.commit()

    def set_run_status(self, run_id: str, status: str, notes: str = "") -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE runs SET status=?, notes=? WHERE run_id=?",
                (status, notes, run_id))
            self._conn.commit()

    def get_run(self, run_id: str) -> dict | None:
        with self._lock:
            r = self._conn.execute(
                "SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        return dict(r) if r else None

    def list_runs(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM runs ORDER BY created_at DESC LIMIT ?",
                (limit,)).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------ rows
    def upsert_row(self, run_id: str, rec: LeadRecord, state: str,
                   dedupe_key: str = "") -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO rows(run_id,row_id,dedupe_key,state,record_json,updated_at)"
                " VALUES (?,?,?,?,?,?)"
                " ON CONFLICT(run_id,row_id) DO UPDATE SET"
                "   state=excluded.state, record_json=excluded.record_json,"
                "   dedupe_key=excluded.dedupe_key, updated_at=excluded.updated_at",
                (run_id, rec.inp.row_id, dedupe_key, state, rec.to_json(), time.time()))
            self._conn.commit()

    def seed_rows(self, run_id: str, records: list[tuple[LeadRecord, str]]) -> int:
        """Insert rows only if absent -- so re-running never resets progress."""
        added = 0
        with self._lock:
            for rec, key in records:
                cur = self._conn.execute(
                    "INSERT OR IGNORE INTO rows"
                    "(run_id,row_id,dedupe_key,state,record_json,updated_at)"
                    " VALUES (?,?,?,?,?,?)",
                    (run_id, rec.inp.row_id, key, "pending", rec.to_json(), time.time()))
                added += cur.rowcount or 0
            self._conn.commit()
        return added

    def get_row(self, run_id: str, row_id: str) -> LeadRecord | None:
        with self._lock:
            r = self._conn.execute(
                "SELECT record_json FROM rows WHERE run_id=? AND row_id=?",
                (run_id, row_id)).fetchone()
        return LeadRecord.from_json(r["record_json"]) if r else None

    def pending_rows(self, run_id: str) -> list[LeadRecord]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT record_json FROM rows WHERE run_id=? AND state IN"
                " ('pending','in_progress') ORDER BY rowid", (run_id,)).fetchall()
        return [LeadRecord.from_json(r["record_json"]) for r in rows]

    def iter_rows(self, run_id: str, state: str | None = None) -> Iterator[LeadRecord]:
        sql = "SELECT record_json FROM rows WHERE run_id=?"
        args: list = [run_id]
        if state:
            sql += " AND state=?"
            args.append(state)
        sql += " ORDER BY rowid"
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        for r in rows:
            yield LeadRecord.from_json(r["record_json"])

    def all_rows(self, run_id: str) -> list[LeadRecord]:
        return list(self.iter_rows(run_id))

    def counts(self, run_id: str) -> dict[str, int]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT state, COUNT(*) c FROM rows WHERE run_id=? GROUP BY state",
                (run_id,)).fetchall()
        return {r["state"]: r["c"] for r in rows}

    def dedupe_lookup(self, run_id: str, key: str) -> str | None:
        """First row_id already holding this dedupe key, if any."""
        if not key:
            return None
        with self._lock:
            r = self._conn.execute(
                "SELECT row_id FROM rows WHERE run_id=? AND dedupe_key=?"
                " ORDER BY rowid LIMIT 1", (run_id, key)).fetchone()
        return r["row_id"] if r else None

    # ---------------------------------------------------------------- budget
    def save_budget(self, run_id: str, payload: dict) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO budget_state(run_id,payload) VALUES (?,?)"
                " ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload",
                (run_id, json.dumps(payload)))
            self._conn.commit()

    def load_budget(self, run_id: str) -> dict:
        with self._lock:
            r = self._conn.execute(
                "SELECT payload FROM budget_state WHERE run_id=?", (run_id,)).fetchone()
        return json.loads(r["payload"]) if r else {}
