"""The demo run end to end, and the spend controls that keep a real run bounded."""
from __future__ import annotations

import csv
from pathlib import Path

import pytest

from leadenrich.budget import Budget, BudgetExceeded
from leadenrich.config import load_config
from leadenrich.io_csv import (DELIVERY_COLUMNS, read_inputs, write_audit,
                               write_delivery, write_review)
from leadenrich.models import ContactType, FieldStatus
from leadenrich.pipeline import Pipeline, prepare_run
from leadenrich.providers.demo import fixture_digest

SAMPLE = Path(__file__).resolve().parents[1] / "samples" / "sample_input.csv"


# -------------------------------------------------------------------- demo ---

@pytest.fixture
def demo_run(store):
    cfg = load_config(demo=True)
    inputs, _warnings = read_inputs(SAMPLE)
    rid = prepare_run(cfg, store, inputs)
    stats = Pipeline(cfg, store, rid).run()
    return cfg, rid, stats, store.all_rows(rid)


def test_demo_needs_no_credentials_and_no_network(demo_run):
    cfg, _rid, stats, rows = demo_run
    assert stats.processed == 7 and stats.skipped_duplicates == 1
    for rec in rows:
        for call in rec.calls:
            assert call.provider.startswith(("demo:", "linkedin_slug", "client_input")), \
                f"demo run must not touch a real provider ({call.provider})"


def test_demo_exercises_the_full_waterfall(demo_run):
    """Each of A, B and C must be the winning provider for at least one row."""
    _cfg, _rid, _stats, rows = demo_run
    winners = {r.email.provenance.provider for r in rows if r.email.is_present()}
    assert {"demo:prospeo", "demo:findymail", "demo:hunter"} <= winners


def test_demo_transient_failure_is_retried_then_the_chain_continues(demo_run):
    """Row 4 makes provider A fail with a 503 before B answers."""
    from leadenrich.models import CallOutcome
    _cfg, _rid, _stats, rows = demo_run
    rec = next(r for r in rows if "sanjay" in r.inp.linkedin_url)
    a_call = next(c for c in rec.calls if c.provider == "demo:prospeo")
    assert a_call.outcome == CallOutcome.TRANSIENT_ERROR.value
    assert any(c.provider == "demo:findymail" for c in rec.calls), \
        "the chain must continue past a transient failure"


def test_demo_catch_all_is_refused(demo_run):
    _cfg, _rid, _stats, rows = demo_run
    rec = next(r for r in rows if "sanjay" in r.inp.linkedin_url)
    assert rec.email.value is None
    assert rec.email.status == FieldStatus.REJECTED.value
    assert rec.email_candidates, "the rejected address is still recorded internally"


def test_demo_role_mailbox_is_refused_but_direct_line_is_delivered(demo_run):
    _cfg, _rid, _stats, rows = demo_run
    rec = next(r for r in rows if "meera" in r.inp.linkedin_url)
    assert rec.email.value is None, "info@ is not a named person's mailbox"
    assert rec.phone.value == "+919999910005"
    assert rec.phone.provenance.raw_status == ContactType.PUBLISHED_DIRECT_LINE.value
    assert rec.phone.provenance.source_url, "a delivered number must cite its page"


def test_demo_unresolvable_row_falls_back_to_the_slug_and_is_queued(demo_run):
    _cfg, _rid, _stats, rows = demo_run
    rec = next(r for r in rows if "unknown-person" in r.inp.linkedin_url)
    assert rec.name.provenance.provider == "linkedin_slug"
    assert rec.clinic.value is None
    assert rec.needs_review()


def test_demo_duplicate_is_detected(demo_run):
    _cfg, _rid, _stats, rows = demo_run
    assert sum(1 for r in rows if r.duplicate_of) == 1


def test_demo_output_is_clearly_fictional(demo_run):
    """Nothing from a demo run should ever be mistaken for real client data."""
    _cfg, _rid, _stats, rows = demo_run
    for rec in rows:
        if rec.email.is_present():
            assert rec.email.value.endswith(".example")
        if rec.phone.is_present():
            # India's +91 99999 documentation range, or the fictional STD block.
            assert rec.phone.value.startswith(("+9199999", "+91141"))


def test_demo_is_deterministic(store, tmp_path):
    """Two runs of the same fixtures must produce identical delivery files."""
    cfg = load_config(demo=True)
    inputs, _ = read_inputs(SAMPLE)
    outputs = []
    for i in range(2):
        rid = prepare_run(cfg, store, inputs, run_id=f"det-{i}")
        Pipeline(cfg, store, rid).run()
        path = tmp_path / f"{i}.csv"
        write_delivery(path, store.all_rows(rid))
        outputs.append(path.read_text(encoding="utf-8"))
    assert outputs[0] == outputs[1]
    assert fixture_digest(), "fixtures should have a stable digest"


def test_demo_writes_all_three_files_with_the_right_shapes(demo_run, tmp_path):
    _cfg, _rid, _stats, rows = demo_run
    assert write_delivery(tmp_path / "d.csv", rows) == 7
    write_audit(tmp_path / "a.csv", rows)
    assert write_review(tmp_path / "r.csv", rows) >= 4

    delivered = list(csv.DictReader((tmp_path / "d.csv").open()))
    assert list(delivered[0].keys()) == DELIVERY_COLUMNS
    audit = list(csv.DictReader((tmp_path / "a.csv").open()))
    assert audit[0]["phone_source_url"] or audit[0]["email_source_url"]


# ------------------------------------------------------------------ budget ---

def test_total_request_cap_is_enforced():
    b = Budget(max_total_requests=2)
    b.charge("p"); b.charge("p")
    assert not b.allows("p")
    with pytest.raises(BudgetExceeded):
        b.charge("p")


def test_credit_cap_accounts_for_per_call_cost():
    b = Budget(max_estimated_credits=2.5)
    b.charge("p", 1.0); b.charge("p", 1.0)
    with pytest.raises(BudgetExceeded):
        b.charge("p", 1.0)
    assert b.total_credits == 2.0


def test_per_provider_cap_does_not_block_other_providers():
    b = Budget(per_provider={"expensive": 1})
    b.charge("expensive")
    assert not b.allows("expensive")
    assert b.allows("cheap"), "one provider's cap must not stop the waterfall"


def test_summary_reports_spend_per_provider():
    b = Budget()
    b.charge("apollo", 1.0); b.charge("apollo", 1.0); b.charge("hunter", 0.5)
    b.note_skip("pdl")
    s = b.summary()
    assert s["total_requests"] == 3
    assert s["per_provider_requests"] == {"apollo": 2, "hunter": 1}
    assert s["per_provider_credits"]["apollo"] == 2.0
    assert s["budget_skips"] == {"pdl": 1}


def test_a_run_stays_inside_its_configured_caps(store):
    """The end-to-end guarantee: a capped run cannot overspend."""
    from conftest import lead, make_config, provider_cfg
    from leadenrich.models import CallOutcome
    from leadenrich.providers.base import Provider, ProviderResult, registry

    class _Greedy(Provider):
        name = "greedy"
        stage = "email"

        def available(self):
            return True

        def can_handle(self, rec, ctx=None):
            return True

        def _call(self, rec, ctx):
            return ProviderResult(outcome=CallOutcome.NO_MATCH.value)

    registry.register(_Greedy)
    cfg = make_config()
    cfg.waterfalls = {"identity": [], "email": ["greedy"], "validation": [], "phone": []}
    cfg.providers = {"greedy": provider_cfg("greedy")}
    cfg.budget.max_total_requests = 3

    rid = prepare_run(cfg, store, [
        lead(linkedin_url=f"https://linkedin.com/in/p{i}").inp for i in range(10)])
    pipe = Pipeline(cfg, store, rid)
    pipe.run()

    assert pipe.budget.total_requests <= 3
    assert pipe.stats.processed == 10, "every row still completes, just unenriched"
    assert pipe.budget.skips.get("greedy", 0) > 0


# --------------------------------------------------------------------- cli ---

def _invoke(argv, fake_run):
    """Drive ``cli.main`` with the run command swapped for a recorder.

    Both the module attribute and the parser's stored default are replaced,
    because argparse captures the function object at parser-build time.
    """
    import leadenrich.cli as cli

    real = cli.cmd_run
    cli.cmd_run = fake_run
    original_build = cli.build_parser

    def build_with_fake():
        parser = original_build()
        choices = parser._subparsers._group_actions[0].choices
        for sub in choices.values():
            if sub.get_default("func") is real:
                sub.set_defaults(func=fake_run)
        return parser

    cli.build_parser = build_with_fake
    try:
        return cli.main(argv)
    finally:
        cli.cmd_run = real
        cli.build_parser = original_build


def test_shared_flags_work_on_either_side_of_the_subcommand():
    """``--demo run x`` and ``run x --demo`` must behave identically.

    argparse alone gets this wrong: the subparser's own defaults overwrite
    anything given before the subcommand, silently dropping ``--demo`` and
    sending what the operator believed was a dry run at live paid providers.
    """
    for argv in (["--demo", "run", str(SAMPLE)], ["run", str(SAMPLE), "--demo"]):
        seen: dict = {}
        rc = _invoke(argv, lambda a: seen.update(
            {"demo": a.demo, "input": a.input}) or 0)
        assert rc == 0
        assert seen["demo"] is True, f"--demo was lost for {argv}"
        assert seen["input"] == str(SAMPLE)


def test_quiet_flag_works_after_the_subcommand():
    seen: dict = {}
    _invoke(["run", str(SAMPLE), "--quiet"],
            lambda a: seen.update({"quiet": a.quiet}) or 0)
    assert seen["quiet"] is True


def test_path_flag_given_first_is_not_reset_by_the_subparser(tmp_path):
    seen: dict = {}
    rc = _invoke(["--out", str(tmp_path), "--demo", "run", str(SAMPLE)],
                 lambda a: seen.update({"out": a.out, "demo": a.demo}) or 0)
    assert rc == 0
    assert seen["out"] == str(tmp_path)
    assert seen["demo"] is True


# --------------------------------------------------------------- env file ---

def test_env_file_round_trips_values(tmp_path):
    from leadenrich.cli import _read_env_file, _write_env_file
    path = tmp_path / ".env"
    _write_env_file(path, {"HUNTER_API_KEY": "abc123", "PROSPEO_API_KEY": ""})
    back = _read_env_file(path)
    assert back["HUNTER_API_KEY"] == "abc123"
    assert back["PROSPEO_API_KEY"] == ""


def test_env_file_is_written_owner_only(tmp_path):
    """A world-readable file of API keys is the same mistake as committing them."""
    import stat
    from leadenrich.cli import _write_env_file
    path = tmp_path / ".env"
    _write_env_file(path, {"HUNTER_API_KEY": "secret"})
    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600, f"expected owner-only, got {oct(mode)}"


def test_env_file_preserves_unknown_variables(tmp_path):
    """Someone's own extra variable must survive a re-run of the wizard."""
    from leadenrich.cli import _read_env_file, _write_env_file
    path = tmp_path / ".env"
    path.write_text("MY_OWN_THING=keepme\nHUNTER_API_KEY=old\n", encoding="utf-8")
    values = _read_env_file(path)
    values["HUNTER_API_KEY"] = "new"
    _write_env_file(path, values)
    back = _read_env_file(path)
    assert back["MY_OWN_THING"] == "keepme"
    assert back["HUNTER_API_KEY"] == "new"


def test_comments_and_blank_lines_are_ignored_when_reading(tmp_path):
    from leadenrich.cli import _read_env_file
    path = tmp_path / ".env"
    path.write_text("# a comment\n\nHUNTER_API_KEY=abc\n  \n", encoding="utf-8")
    assert _read_env_file(path) == {"HUNTER_API_KEY": "abc"}


@pytest.mark.parametrize("value,expected", [
    ("abcd1234efgh", "abcd****efgh"),
    ("short", "*****"),
    ("", ""),
])
def test_masking_shows_enough_to_recognise_never_enough_to_use(value, expected):
    from leadenrich.cli import _mask
    assert _mask(value) == expected


def test_every_prompted_key_exists_in_the_env_template():
    """The wizard and the template must not drift apart."""
    from pathlib import Path
    from leadenrich.cli import KEY_PROMPTS
    template = (Path(__file__).resolve().parents[1] / ".env.example").read_text()
    for var, *_rest in KEY_PROMPTS:
        assert var in template, f"{var} is prompted for but missing from .env.example"
