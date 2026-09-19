"""Streamer Lead Workspace - local API.

Runs on http://127.0.0.1:8000 and talks only to the local SQLite file.  It
makes no outbound requests of any kind: search URLs are built as strings and
opened by the operator's own browser.
"""

from __future__ import annotations

import logging
import sqlite3
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import Body, FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import csv_export, extract as extract_mod, searches
from .db import connect, db_path, init_db, now_iso
from .normalize import (
    FieldError,
    normalize_email,
    normalize_profile_url,
    parse_follower_count,
)

log = logging.getLogger("streamer_leads")

STATUS_INCOMPLETE = "incomplete"
STATUS_READY = "ready"
STATUS_APPROVED = "approved"

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    log.info("Database ready at %s", db_path())
    yield


app = FastAPI(
    title="Streamer Lead Workspace",
    version="1.0.0",
    docs_url="/api/docs",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:4173", "http://127.0.0.1:4173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# Errors - the UI always receives a readable sentence, never a traceback
# --------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, message: str, *, status: int = 400, field: str | None = None,
                 code: str | None = None, extra: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.field = field
        self.code = code
        self.extra = extra or {}


@app.exception_handler(ApiError)
async def _api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    body = {"message": exc.message, "field": exc.field, "code": exc.code, **exc.extra}
    return JSONResponse(status_code=exc.status, content=body)


@app.exception_handler(Exception)
async def _unexpected_handler(_: Request, exc: Exception) -> JSONResponse:
    log.error("Unhandled error: %s\n%s", exc, traceback.format_exc())
    return JSONResponse(
        status_code=500,
        content={
            "message": "Something went wrong inside the application. "
                       "The details were written to the backend console.",
            "field": None,
            "code": "internal_error",
        },
    )


# --------------------------------------------------------------------------
# Request models
# --------------------------------------------------------------------------

class LeadIn(BaseModel):
    profile_url: str = ""
    follower_count: str = ""
    email_address: str = ""


class LeadPatch(BaseModel):
    profile_url: str | None = None
    follower_count: str | None = None
    email_address: str | None = None


class IdList(BaseModel):
    ids: list[int] = Field(default_factory=list)


class TextIn(BaseModel):
    text: str = ""


class UrlIn(BaseModel):
    profile_url: str = ""
    exclude_id: int | None = None


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _row_to_lead(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "profile_url": row["profile_url"],
        "url_key": row["url_key"],
        "follower_count": row["follower_count"],
        "follower_raw": row["follower_raw"],
        "follower_approximate": bool(row["follower_approx"]),
        "email_address": row["email_address"],
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _status_for(follower_count: int | None, email: str | None) -> str:
    """A lead is only 'ready' once all three fields are present."""
    if follower_count is None or not email:
        return STATUS_INCOMPLETE
    return STATUS_READY


def _fetch(conn: sqlite3.Connection, lead_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
    if row is None:
        raise ApiError(f"Lead #{lead_id} no longer exists.", status=404, code="not_found")
    return row


def _find_by_key(conn: sqlite3.Connection, key: str, exclude_id: int | None = None) -> sqlite3.Row | None:
    if exclude_id is None:
        return conn.execute("SELECT * FROM leads WHERE url_key = ?", (key,)).fetchone()
    return conn.execute(
        "SELECT * FROM leads WHERE url_key = ? AND id != ?", (key, exclude_id)
    ).fetchone()


def _duplicate_error(existing: sqlite3.Row) -> ApiError:
    return ApiError(
        "This profile is already in your leads.",
        status=409,
        field="profile_url",
        code="duplicate",
        extra={"lead": _row_to_lead(existing)},
    )


# --------------------------------------------------------------------------
# Health and counters
# --------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "service": "streamer-lead-workspace"}


@app.get("/api/stats")
def stats() -> dict:
    with connect() as conn:
        rows = conn.execute("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").fetchall()
    counts = {r["status"]: r["n"] for r in rows}
    incomplete = counts.get(STATUS_INCOMPLETE, 0)
    ready = counts.get(STATUS_READY, 0)
    approved = counts.get(STATUS_APPROVED, 0)
    return {
        "total": incomplete + ready + approved,
        "incomplete": incomplete,
        "ready": ready,
        "approved": approved,
        "complete": ready + approved,
    }


# --------------------------------------------------------------------------
# Field validation (live feedback, one source of truth on the server)
# --------------------------------------------------------------------------

@app.post("/api/validate")
def validate(payload: LeadIn) -> dict:
    result: dict[str, Any] = {"profile_url": None, "follower_count": None, "email_address": None}

    if payload.profile_url.strip():
        try:
            parsed = normalize_profile_url(payload.profile_url)
            result["profile_url"] = {
                "ok": True, "value": parsed.url, "key": parsed.key,
                "identifier": parsed.identifier, "hints": parsed.hints, "message": None,
            }
        except FieldError as exc:
            result["profile_url"] = {"ok": False, "value": None, "message": str(exc)}

    if payload.follower_count.strip():
        try:
            followers = parse_follower_count(payload.follower_count)
            result["follower_count"] = {
                "ok": True, "value": followers.value,
                "approximate": followers.approximate, "message": None,
            }
        except FieldError as exc:
            result["follower_count"] = {"ok": False, "value": None, "message": str(exc)}

    if payload.email_address.strip():
        try:
            email = normalize_email(payload.email_address)
            result["email_address"] = {"ok": True, "value": email, "message": None}
        except FieldError as exc:
            result["email_address"] = {"ok": False, "value": None, "message": str(exc)}

    return result


@app.post("/api/leads/check-duplicate")
def check_duplicate(payload: UrlIn) -> dict:
    try:
        parsed = normalize_profile_url(payload.profile_url)
    except FieldError as exc:
        return {"valid": False, "duplicate": False, "message": str(exc)}

    with connect() as conn:
        existing = _find_by_key(conn, parsed.key, payload.exclude_id)

    return {
        "valid": True,
        "duplicate": existing is not None,
        "normalized_url": parsed.url,
        "identifier": parsed.identifier,
        "hints": parsed.hints,
        "lead": _row_to_lead(existing) if existing else None,
        "message": "This profile is already in your leads." if existing else None,
    }


# --------------------------------------------------------------------------
# Leads
# --------------------------------------------------------------------------

@app.get("/api/leads")
def list_leads(
    q: str = Query("", description="Free-text search across the three fields"),
    status: Literal["all", "incomplete", "ready", "approved"] = "all",
) -> dict:
    sql = "SELECT * FROM leads"
    clauses: list[str] = []
    params: list[Any] = []

    if status != "all":
        clauses.append("status = ?")
        params.append(status)

    term = q.strip()
    if term:
        clauses.append(
            "(profile_url LIKE ? OR IFNULL(email_address,'') LIKE ? "
            "OR IFNULL(follower_raw,'') LIKE ? OR IFNULL(follower_count,'') LIKE ?)"
        )
        params.extend([f"%{term}%"] * 4)

    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY datetime(updated_at) DESC, id DESC"

    with connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return {"leads": [_row_to_lead(r) for r in rows]}


@app.get("/api/leads/{lead_id}")
def get_lead(lead_id: int) -> dict:
    with connect() as conn:
        return _row_to_lead(_fetch(conn, lead_id))


@app.post("/api/leads", status_code=201)
def create_lead(payload: LeadIn) -> dict:
    try:
        parsed = normalize_profile_url(payload.profile_url)
    except FieldError as exc:
        raise ApiError(str(exc), field="profile_url") from exc

    try:
        followers = parse_follower_count(payload.follower_count)
    except FieldError as exc:
        raise ApiError(str(exc), field="follower_count") from exc

    try:
        email = normalize_email(payload.email_address)
    except FieldError as exc:
        raise ApiError(str(exc), field="email_address") from exc

    status = _status_for(followers.value, email)
    stamp = now_iso()

    with connect() as conn:
        existing = _find_by_key(conn, parsed.key)
        if existing is not None:
            raise _duplicate_error(existing)
        try:
            cursor = conn.execute(
                """INSERT INTO leads
                   (profile_url, url_key, follower_count, follower_raw, follower_approx,
                    email_address, status, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (parsed.url, parsed.key, followers.value, followers.raw,
                 int(followers.approximate), email, status, stamp, stamp),
            )
        except sqlite3.IntegrityError as exc:  # unique constraint, race-safe
            again = _find_by_key(conn, parsed.key)
            if again is not None:
                raise _duplicate_error(again) from exc
            raise
        lead = _row_to_lead(_fetch(conn, int(cursor.lastrowid)))

    return {"lead": lead, "hints": parsed.hints, "next_action": _next_action(lead)}


@app.patch("/api/leads/{lead_id}")
def update_lead(lead_id: int, payload: LeadPatch) -> dict:
    with connect() as conn:
        row = _fetch(conn, lead_id)
        current = _row_to_lead(row)

        url_value, url_key = current["profile_url"], current["url_key"]
        hints: list[str] = []
        if payload.profile_url is not None:
            try:
                parsed = normalize_profile_url(payload.profile_url)
            except FieldError as exc:
                raise ApiError(str(exc), field="profile_url") from exc
            url_value, url_key, hints = parsed.url, parsed.key, parsed.hints
            clash = _find_by_key(conn, url_key, exclude_id=lead_id)
            if clash is not None:
                raise _duplicate_error(clash)

        follower_value = current["follower_count"]
        follower_raw = current["follower_raw"]
        follower_approx = current["follower_approximate"]
        if payload.follower_count is not None:
            try:
                followers = parse_follower_count(payload.follower_count)
            except FieldError as exc:
                raise ApiError(str(exc), field="follower_count") from exc
            follower_value, follower_raw, follower_approx = (
                followers.value, followers.raw, followers.approximate,
            )

        email = current["email_address"]
        if payload.email_address is not None:
            try:
                email = normalize_email(payload.email_address)
            except FieldError as exc:
                raise ApiError(str(exc), field="email_address") from exc

        core_changed = (
            url_key != current["url_key"]
            or follower_value != current["follower_count"]
            or (email or "") != (current["email_address"] or "")
        )

        if follower_value is None or not email:
            status = STATUS_INCOMPLETE
        elif current["status"] == STATUS_APPROVED and not core_changed:
            status = STATUS_APPROVED
        else:
            status = STATUS_READY

        demoted = current["status"] == STATUS_APPROVED and status != STATUS_APPROVED

        conn.execute(
            """UPDATE leads SET profile_url=?, url_key=?, follower_count=?, follower_raw=?,
                   follower_approx=?, email_address=?, status=?, updated_at=? WHERE id=?""",
            (url_value, url_key, follower_value, follower_raw, int(follower_approx),
             email, status, now_iso(), lead_id),
        )
        lead = _row_to_lead(_fetch(conn, lead_id))

    return {
        "lead": lead,
        "hints": hints,
        "demoted": demoted,
        "message": (
            "Key details changed, so this lead went back to Ready for review."
            if demoted else None
        ),
        "next_action": _next_action(lead),
    }


@app.post("/api/leads/{lead_id}/approve")
def approve_lead(lead_id: int) -> dict:
    with connect() as conn:
        lead = _row_to_lead(_fetch(conn, lead_id))
        missing = [
            label for label, value in (
                ("profile link", lead["profile_url"]),
                ("follower count", lead["follower_count"]),
                ("email address", lead["email_address"]),
            ) if value in (None, "")
        ]
        if missing:
            raise ApiError(
                "This lead is still missing its " + " and ".join(missing) +
                ". Fill every field before approving it.",
                code="incomplete",
            )
        conn.execute(
            "UPDATE leads SET status=?, updated_at=? WHERE id=?",
            (STATUS_APPROVED, now_iso(), lead_id),
        )
        return {"lead": _row_to_lead(_fetch(conn, lead_id))}


@app.post("/api/leads/{lead_id}/unapprove")
def unapprove_lead(lead_id: int) -> dict:
    with connect() as conn:
        lead = _row_to_lead(_fetch(conn, lead_id))
        status = _status_for(lead["follower_count"], lead["email_address"])
        conn.execute(
            "UPDATE leads SET status=?, updated_at=? WHERE id=?",
            (status, now_iso(), lead_id),
        )
        return {"lead": _row_to_lead(_fetch(conn, lead_id))}


@app.delete("/api/leads/{lead_id}")
def delete_lead(lead_id: int) -> dict:
    with connect() as conn:
        _fetch(conn, lead_id)
        conn.execute("DELETE FROM leads WHERE id=?", (lead_id,))
    return {"deleted": 1}


@app.post("/api/leads/bulk-delete")
def bulk_delete(payload: IdList) -> dict:
    ids = [int(i) for i in payload.ids]
    if not ids:
        return {"deleted": 0}
    placeholders = ",".join("?" * len(ids))
    with connect() as conn:
        cursor = conn.execute(f"DELETE FROM leads WHERE id IN ({placeholders})", ids)
        return {"deleted": cursor.rowcount}


# --------------------------------------------------------------------------
# Guided next action - the application says what it needs from the operator
# --------------------------------------------------------------------------

def _next_action(lead: dict) -> dict:
    if not lead.get("profile_url"):
        return {
            "state": "need_profile",
            "message": "Find a streamer using the search tools, then paste the profile URL here.",
        }
    if lead.get("follower_count") is None:
        return {
            "state": "need_followers",
            "message": "Please open the profile and enter its follower count.",
        }
    if not lead.get("email_address"):
        return {
            "state": "need_email",
            "message": "Please locate an appropriate publicly listed business email.",
        }
    if lead.get("status") == STATUS_APPROVED:
        return {"state": "approved", "message": "Approved and ready to export."}
    return {
        "state": "review",
        "message": "All three fields are filled. Please review the information.",
    }


@app.post("/api/next-action")
def next_action(payload: LeadIn) -> dict:
    """What the operator should do next for an in-progress (unsaved) form."""
    follower_value: int | None = None
    email: str | None = None
    url = ""
    try:
        if payload.profile_url.strip():
            url = normalize_profile_url(payload.profile_url).url
    except FieldError:
        url = ""
    try:
        follower_value = parse_follower_count(payload.follower_count).value
    except FieldError:
        follower_value = None
    try:
        email = normalize_email(payload.email_address)
    except FieldError:
        email = None

    return _next_action(
        {"profile_url": url, "follower_count": follower_value,
         "email_address": email, "status": STATUS_READY}
    )


# --------------------------------------------------------------------------
# Research helpers
# --------------------------------------------------------------------------

@app.get("/api/searches")
def get_searches(
    platform: Literal["whatnot", "ebay_live"] = "whatnot",
    topic: str = "all",
) -> dict:
    return {
        "platform": searches.PLATFORMS[platform],
        "topics": searches.TOPICS,
        "searches": searches.build_searches(platform, topic),
    }


@app.get("/api/platforms")
def get_platforms() -> dict:
    return {"platforms": searches.PLATFORMS, "topics": searches.TOPICS}


@app.post("/api/searches/email")
def get_email_searches(payload: UrlIn) -> dict:
    try:
        parsed = normalize_profile_url(payload.profile_url)
    except FieldError as exc:
        raise ApiError(
            "Paste a valid profile link first - the email search is built from its username.",
            field="profile_url",
        ) from exc
    results = searches.email_searches(parsed.identifier, parsed.url)
    if not results:
        raise ApiError(
            "That link has no username in it, so no email search can be built from it. "
            "Please search manually."
        )
    return {"identifier": parsed.identifier, "searches": results}


@app.post("/api/extract")
def extract_text(payload: TextIn = Body(...)) -> dict:
    return extract_mod.extract(payload.text)


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

def _approved_leads() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM leads WHERE status = ? ORDER BY id ASC", (STATUS_APPROVED,)
        ).fetchall()
    return [_row_to_lead(r) for r in rows]


@app.get("/api/export/preview")
def export_preview() -> dict:
    leads = _approved_leads()
    rows = csv_export.rows_for_export(leads)
    approximate = sum(1 for lead in leads if lead["follower_approximate"])
    return {
        "headers": csv_export.HEADERS,
        "rows": rows,
        "counts": stats(),
        "approximate_follower_rows": approximate,
        "filename": csv_export.export_filename(),
    }


@app.get("/api/export/csv")
def export_csv() -> Response:
    body = csv_export.build_csv(_approved_leads())
    filename = csv_export.export_filename()
    return Response(
        content=("﻿" + body).encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------
# Optional: serve the built frontend when `npm run build` has been run
# --------------------------------------------------------------------------

_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")
