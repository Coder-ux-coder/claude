"""The client handover bundle.

The cover note makes arithmetical claims to a paying client. These tests exist
so that those claims stay derived from the records rather than drifting into
optimism -- in particular that a withheld value is *counted and explained*, not
quietly dropped from both the deliverable and the report.
"""
from __future__ import annotations

import csv
import zipfile

import pytest

from conftest import lead
from leadenrich.handover import (AUDIT_CSV, COVER_MD, DICT_MD, LEADS_CSV,
                                 REVIEW_CSV, build_handover, compute_stats,
                                 cover_note)
from leadenrich.models import (ContactType, Deliverability, EmailCandidate,
                               FieldStatus, Ownership, PhoneCandidate)


# ------------------------------------------------------------- fixtures ---

def _delivered(name="Dr Anaya Varma", *, email=True, phone=True,
               contact_type=ContactType.CLINIC_MAIN_LINE.value):
    r = lead(linkedin_url=f"https://www.linkedin.com/in/{name.lower().replace(' ', '-')}")
    r.name.set(name, "apollo", status=FieldStatus.FOUND_VERIFIED.value)
    r.role.set("Founder", "apollo")
    r.clinic.set("Meridian Skin Clinic", "apollo")
    if email:
        r.email.set("a.varma@meridianskin.example", "hunter",
                    status=FieldStatus.FOUND_VERIFIED.value,
                    source_url="https://meridianskin.example/team")
    if phone:
        r.phone.set("+919999910001", "google_places",
                    status=FieldStatus.FOUND_VERIFIED.value,
                    source_url="https://maps.google.example/place/meridian",
                    raw_status=contact_type)
    return r


def _email_refused(kind: str):
    """A row whose address was found and then refused by the gate."""
    r = _delivered("Sanjay Iyer", email=False)
    cand = EmailCandidate(address="sanjay@northgate.example", provider="findymail",
                          ownership=Ownership.PROVIDER_ASSERTED.value)
    if kind == "role":
        cand.address, cand.is_role_account = "info@northgate.example", True
        cand.deliverability = Deliverability.DELIVERABLE.value
    elif kind == "catch_all":
        cand.deliverability = Deliverability.RISKY_CATCH_ALL.value
    elif kind == "unknown":
        cand.deliverability = Deliverability.RISKY_UNKNOWN.value
    elif kind == "undeliverable":
        cand.deliverability = Deliverability.UNDELIVERABLE.value
    r.email_candidates.append(cand)
    r.email.status = FieldStatus.REJECTED.value
    return r


# --------------------------------------------------------------- counting ---

def test_duplicates_are_excluded_from_every_denominator():
    dup = _delivered("Dr Anaya Varma")
    dup.duplicate_of = "abc123"
    stats = compute_stats([_delivered(), _delivered("Rohan Desai"), dup])

    assert stats["rows_supplied"] == 3
    assert stats["duplicates_removed"] == 1
    assert stats["rows_delivered"] == 2
    # 2 of 2, not 2 of 3 -- a duplicate must not depress the fill rate either.
    assert stats["fill"]["Email"] == {"filled": 2, "percent": 100.0}


def test_fill_rate_is_a_count_not_an_estimate():
    rows = [_delivered(), _delivered("Rohan Desai", email=False),
            _delivered("Kavya Nair", email=False), _delivered("Arjun Menon")]
    stats = compute_stats(rows)
    assert stats["fill"]["Email"] == {"filled": 2, "percent": 50.0}
    assert stats["fill"]["Phone"] == {"filled": 4, "percent": 100.0}


def test_phone_cells_are_broken_down_by_kind_of_line():
    rows = [
        _delivered("A", contact_type=ContactType.CLINIC_MAIN_LINE.value),
        _delivered("B", contact_type=ContactType.CLINIC_MAIN_LINE.value),
        _delivered("C", contact_type=ContactType.PUBLISHED_DIRECT_LINE.value),
    ]
    types = compute_stats(rows)["phone_contact_types"]
    assert types == {ContactType.CLINIC_MAIN_LINE.value: 2,
                     ContactType.PUBLISHED_DIRECT_LINE.value: 1}


@pytest.mark.parametrize("kind,fragment", [
    ("role", "shared mailbox"),
    ("catch_all", "catch-all"),
    ("unknown", "could not reach"),
    ("undeliverable", "does not exist"),
])
def test_each_blank_email_is_explained_by_the_gate_that_refused_it(kind, fragment):
    stats = compute_stats([_email_refused(kind)])
    assert len(stats["email_blank_reasons"]) == 1
    reason = next(iter(stats["email_blank_reasons"]))
    assert fragment in reason


def test_a_row_nobody_could_answer_is_not_reported_as_a_refusal():
    r = _delivered("Nobody", email=False)          # no candidates at all
    reasons = compute_stats([r])["email_blank_reasons"]
    assert "no address found by any provider" in reasons


# ------------------------------------------- the compliance-critical count ---

def test_withheld_personal_mobile_is_counted_and_named_never_silently_dropped():
    """The number was found, refused, and the client is told it was refused.

    Losing this row from the report would let the same list be re-bought from
    someone with a looser policy, believing nothing was there.
    """
    r = _delivered("Meera Joshi", phone=False)
    r.phone_candidates.append(PhoneCandidate(
        number_e164="+919999910099", number_raw="99999 10099",
        contact_type=ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value,
        provider="apollo", source_url="", is_mobile_range=True))

    stats = compute_stats([r])
    reason = next(iter(stats["phone_blank_reasons"]))
    assert "no public evidence" in reason
    assert "withheld" in reason
    assert stats["phone_blank_reasons"][reason] == 1

    note = cover_note(stats, run_id="run-x")
    assert "no public evidence" in note
    assert "+919999910099" not in note, "a withheld number must not leak into the note"


def test_cover_note_never_calls_anything_a_verified_personal_mobile():
    note = cover_note(compute_stats([_delivered()]), run_id="run-x")
    lowered = note.lower()
    assert "verified personal mobile" not in lowered.replace(
        "presented as a verified personal mobile, because nothing in it is one", "")
    assert "published by the business" in lowered


# ------------------------------------------------------------ the document ---

def test_cover_note_carries_the_real_numbers():
    stats = compute_stats([_delivered(), _delivered("Rohan Desai", email=False)])
    note = cover_note(stats, run_id="run-2026", client="Acme Clinics",
                      operator="Zeeshan", delivered_on="10 September 2026")
    assert "Acme Clinics" in note
    assert "run-2026" in note
    assert "10 September 2026" in note
    assert "Prepared by Zeeshan." in note
    assert "1 of 2  (50.0%)" in note      # Email
    assert "2 of 2  (100.0%)" in note     # Name


def test_demo_bundles_are_stamped_and_real_ones_are_not():
    stats = compute_stats([_delivered()])
    assert "FICTIONAL DATA" in cover_note(stats, run_id="r", demo=True)
    assert "FICTIONAL DATA" not in cover_note(stats, run_id="r", demo=False)


# -------------------------------------------------------------- the bundle ---

def test_bundle_contains_exactly_the_five_client_files(tmp_path):
    res = build_handover([_delivered(), _email_refused("catch_all")],
                         run_id="run-9", outdir=tmp_path, client="Acme")

    names = sorted(p.name for p in res.directory.iterdir())
    assert names == sorted([LEADS_CSV, REVIEW_CSV, AUDIT_CSV, COVER_MD, DICT_MD])
    assert all(p.exists() for p in res.files)


def test_leads_csv_holds_the_six_requested_columns_and_nothing_else(tmp_path):
    res = build_handover([_delivered()], run_id="run-9", outdir=tmp_path)
    with (res.directory / LEADS_CSV).open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert list(rows[0]) == ["Name", "Role", "Clinic", "Phone", "Email", "Source"]
    assert rows[0]["Phone"].endswith("(clinic main line (published))")
    assert "maps.google.example" in rows[0]["Source"], "provenance must survive"


def test_zip_is_written_with_a_single_named_folder_inside(tmp_path):
    res = build_handover([_delivered()], run_id="run-9", outdir=tmp_path)
    assert res.zip_path and res.zip_path.exists()
    with zipfile.ZipFile(res.zip_path) as z:
        entries = z.namelist()
    assert all(e.startswith("run-9_handover/") for e in entries)
    assert f"run-9_handover/{LEADS_CSV}" in entries


def test_no_zip_leaves_only_the_folder(tmp_path):
    res = build_handover([_delivered()], run_id="run-9", outdir=tmp_path,
                         make_zip=False)
    assert res.zip_path is None
    assert not list(tmp_path.glob("*.zip"))


def test_bundle_carries_no_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNTER_API_KEY", "sk-should-never-appear")
    res = build_handover([_delivered()], run_id="run-9", outdir=tmp_path)
    blob = "\n".join(p.read_text(encoding="utf-8") for p in res.files)
    assert "sk-should-never-appear" not in blob


# ------------------------------------------------------------- end to end ---

def _cli(tmp_path, *argv):
    import leadenrich.cli as cli
    return cli.main(["--data-dir", str(tmp_path / "data"),
                     "--out", str(tmp_path / "out"), "--quiet", *argv])


def _only_run_id(tmp_path):
    from leadenrich.store import Store
    s = Store(tmp_path / "data" / "runs.sqlite3")
    try:
        return s.list_runs()[0]["run_id"]
    finally:
        s.close()


def test_deliver_end_to_end_produces_a_sendable_folder(tmp_path):
    assert _cli(tmp_path, "demo") == 0
    run_id = _only_run_id(tmp_path)
    assert _cli(tmp_path, "deliver", run_id, "--demo",
                "--client", "Acme Clinics") == 0

    folder = tmp_path / "out" / f"{run_id}_handover"
    note = (folder / COVER_MD).read_text(encoding="utf-8")
    assert "Acme Clinics" in note
    assert "FICTIONAL DATA" in note, "a demo bundle must say so on its face"
    assert (tmp_path / "out" / f"{run_id}_handover.zip").exists()

    with (folder / LEADS_CSV).open(encoding="utf-8") as fh:
        assert list(csv.DictReader(fh))[0]["Name"]


def test_deliver_refuses_a_half_finished_run_until_forced(tmp_path):
    assert _cli(tmp_path, "demo", "--limit", "2") == 0
    run_id = _only_run_id(tmp_path)

    # Packaging a partial run would ship a fill rate computed over rows that
    # were never attempted -- a number the client would read as coverage.
    assert _cli(tmp_path, "deliver", run_id, "--demo") == 2
    assert not (tmp_path / "out" / f"{run_id}_handover").exists()

    assert _cli(tmp_path, "deliver", run_id, "--demo", "--force") == 0
    assert (tmp_path / "out" / f"{run_id}_handover" / LEADS_CSV).exists()


# ----------------------------------------------------------- package.sh ---

PACKAGE_SH = __import__("pathlib").Path(__file__).resolve().parents[1] / "package.sh"


def _run_package(workdir):
    import shutil, subprocess
    shutil.copy(PACKAGE_SH, workdir / "package.sh")
    (workdir / "package.sh").chmod(0o755)
    return subprocess.run(["bash", str(workdir / "package.sh")],
                          capture_output=True, text=True, cwd=str(workdir))


# Assembled at runtime rather than written as literals: package.sh scans this
# repository too, and a credential-shaped string sitting in a source file is
# exactly what it is supposed to refuse. The temp tree gets the full string.
_PLANTED = {
    "config.yml": "hunter_key: " + "sk-" + "livekey0123456789abcdef\n",
    "notes.txt": "google: " + "AIza" + "SyD-0123456789abcdefghijklmnopqrstuv\n",
    "sa.json": "-----" + "BEGIN " + "PRIVATE " + "KEY" + "-----\nMIIEv...\n",
}


@pytest.mark.parametrize("filename", sorted(_PLANTED))
def test_packaging_refuses_when_a_credential_is_in_the_tree(tmp_path, filename):
    """The one failure mode that cannot be undone once the zip is sent."""
    (tmp_path / filename).write_text(_PLANTED[filename], encoding="utf-8")
    r = _run_package(tmp_path)
    assert r.returncode != 0
    assert "REFUSING TO PACKAGE" in r.stderr
    assert filename in r.stderr
    assert not list(tmp_path.rglob("*.zip")), "nothing may be sealed after a refusal"


def test_packaging_refuses_when_an_env_file_is_present(tmp_path):
    (tmp_path / ".env").write_text("HUNTER_API_KEY=whatever\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("hello\n", encoding="utf-8")
    r = _run_package(tmp_path)
    # .env is excluded from the copy, so the run must succeed *and* the archive
    # must not contain it -- an exclude that silently stopped working is the risk.
    assert r.returncode == 0, r.stderr
    archive = next((tmp_path / "dist").glob("*.zip"))
    with zipfile.ZipFile(archive) as z:
        assert not [n for n in z.namelist() if n.endswith(".env")]


def test_packaging_succeeds_on_a_clean_tree(tmp_path):
    (tmp_path / "README.md").write_text("start here\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("print('hi')\n", encoding="utf-8")
    r = _run_package(tmp_path)
    assert r.returncode == 0, r.stderr
    archive = next((tmp_path / "dist").glob("*.zip"))
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
    assert any(n.endswith("README.md") for n in names)
    assert not (tmp_path / "dist" / "lead-enrichment").exists(), "staging must be cleaned up"


# --------------------------------------------------------------- launchers ---

ROOT = PACKAGE_SH.parent


def test_every_platform_has_a_double_clickable_start():
    """Windows can double-click a .bat and macOS a .command; neither can a .sh.

    The terminal is the step that loses non-technical operators, so all three
    launchers have to keep working -- and keep pointing at the same entry point.
    """
    import stat as _stat

    launchers = {
        "run.sh": "leadenrich.cli ui",
        "run.bat": "leadenrich.cli ui",
        "Start on Mac.command": "run.sh",
    }
    for name, must_contain in launchers.items():
        path = ROOT / name
        assert path.exists(), f"{name} is missing"
        assert must_contain in path.read_text(encoding="utf-8")
        if name != "run.bat":       # exec bit is meaningless on Windows
            assert path.stat().st_mode & _stat.S_IXUSR, f"{name} is not executable"


def test_the_repository_itself_carries_no_credential_shaped_string():
    """Runs the same scan package.sh does, against the working tree.

    Catches the mistake before it reaches a commit rather than at the moment
    somebody tries to seal an archive.
    """
    import re
    import subprocess

    pattern = re.compile(r"sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}"
                         r"|BEGIN [A-Z ]*PRIVATE KEY")
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True,
                             text=True)
    if tracked.returncode != 0:          # not a checkout; nothing to scan
        pytest.skip("not a git working tree")

    offenders = []
    for rel in tracked.stdout.split():
        f = ROOT / rel
        try:
            if pattern.search(f.read_text(encoding="utf-8")):
                offenders.append(rel)
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
    assert not offenders, f"credential-shaped strings in: {offenders}"
