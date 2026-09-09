"""Google Sheets delivery.

Service-account auth. The step people miss: after creating the service account
and downloading its JSON key, **share the target spreadsheet with the service
account's ``client_email`` as an Editor**. Without that share the API returns 403
even though the key is perfectly valid.

The dependency is optional. If ``google-api-python-client`` is not installed, or
no credentials file is configured, :func:`export_to_sheet` returns a clear,
actionable failure instead of raising -- CSV delivery still works, so a missing
Sheets setup never blocks a run.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from .io_csv import DELIVERY_COLUMNS, delivery_row
from .models import LeadRecord

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
CREDENTIALS_ENV = "GOOGLE_SHEETS_CREDENTIALS_FILE"
SHEET_ID_ENV = "GOOGLE_SHEET_ID"


@dataclass
class SheetsResult:
    ok: bool
    message: str
    updated_cells: int = 0
    spreadsheet_url: str = ""
    service_account_email: str = ""


def credentials_path() -> str:
    return os.environ.get(CREDENTIALS_ENV, "") or ""


def service_account_email() -> str:
    """Read ``client_email`` out of the key file -- the address to share with."""
    path = credentials_path()
    if not path or not Path(path).exists():
        return ""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8")).get("client_email", "")
    except Exception:
        return ""


def preflight() -> SheetsResult:
    """Check everything Sheets export needs, without writing anything."""
    try:
        import googleapiclient  # noqa: F401
        from google.oauth2 import service_account  # noqa: F401
    except Exception:
        return SheetsResult(
            False,
            "google-api-python-client / google-auth not installed. Run: "
            "pip install google-api-python-client google-auth")

    path = credentials_path()
    if not path:
        return SheetsResult(
            False, f"{CREDENTIALS_ENV} is not set. Point it at your service "
                   f"account JSON key file.")
    if not Path(path).exists():
        return SheetsResult(False, f"credentials file not found: {path}")

    email = service_account_email()
    if not email:
        return SheetsResult(False, f"{path} does not look like a service account key "
                                   f"(no client_email field)")
    return SheetsResult(True, "ready", service_account_email=email)


def export_to_sheet(records: list[LeadRecord], *, spreadsheet_id: str = "",
                    sheet_name: str = "Leads",
                    label_contact_type: bool = True) -> SheetsResult:
    """Replace ``sheet_name`` with the six delivered columns.

    Writes a header row plus one row per non-duplicate record.
    """
    pre = preflight()
    if not pre.ok:
        return pre

    sid = spreadsheet_id or os.environ.get(SHEET_ID_ENV, "")
    if not sid:
        return SheetsResult(False, f"no spreadsheet id given and {SHEET_ID_ENV} is unset",
                            service_account_email=pre.service_account_email)

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        credentials_path(), scopes=SCOPES)
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    sheets = service.spreadsheets()

    values = [DELIVERY_COLUMNS]
    for rec in records:
        if rec.duplicate_of:
            continue
        row = delivery_row(rec, label_contact_type=label_contact_type)
        values.append([row[c] for c in DELIVERY_COLUMNS])

    try:
        _ensure_tab(sheets, sid, sheet_name)
        sheets.values().clear(
            spreadsheetId=sid, range=f"{sheet_name}!A:Z").execute()
        resp = sheets.values().update(
            spreadsheetId=sid,
            range=f"{sheet_name}!A1",
            valueInputOption="RAW",
            body={"values": values},
        ).execute()
    except Exception as exc:
        hint = ""
        if "403" in str(exc) or "permission" in str(exc).lower():
            hint = (f" -- share the spreadsheet with {pre.service_account_email} "
                    f"as an Editor, then retry")
        return SheetsResult(False, f"Sheets write failed: {exc}{hint}",
                            service_account_email=pre.service_account_email)

    return SheetsResult(
        True, f"wrote {len(values) - 1} row(s) to '{sheet_name}'",
        updated_cells=int(resp.get("updatedCells", 0)),
        spreadsheet_url=f"https://docs.google.com/spreadsheets/d/{sid}",
        service_account_email=pre.service_account_email)


def _ensure_tab(sheets, spreadsheet_id: str, sheet_name: str) -> None:
    """Create the tab if the spreadsheet does not already have it."""
    meta = sheets.get(spreadsheetId=spreadsheet_id).execute()
    titles = {s["properties"]["title"] for s in meta.get("sheets", [])}
    if sheet_name in titles:
        return
    sheets.batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": [{"addSheet": {"properties": {"title": sheet_name}}}]},
    ).execute()
