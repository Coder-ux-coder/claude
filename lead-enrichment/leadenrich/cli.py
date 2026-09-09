"""Command line interface.

    leadenrich demo                     run the built-in fictional sample
    leadenrich run leads.csv            enrich a CSV
    leadenrich resume <run-id>          continue an interrupted run
    leadenrich export <run-id>          re-export without re-enriching
    leadenrich review <run-id>          show what needs a human
    leadenrich doctor                   what is configured, what is missing
    leadenrich smoke --provider hunter  one live call, printed raw
    leadenrich ui                       open the browser interface
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import load_config, load_dotenv
from .io_csv import (read_inputs, write_audit, write_delivery, write_review,
                     write_run_report)
from .models import LeadInput, LeadRecord
from .pipeline import Pipeline, prepare_run
from .providers import registry
from .store import Store

SAMPLE = Path(__file__).resolve().parent.parent / "samples" / "sample_input.csv"

# ANSI stays off when output is redirected, so logs and CI stay clean.
_TTY = sys.stdout.isatty()
def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _TTY else s
def bold(s): return _c("1", s)
def green(s): return _c("32", s)
def yellow(s): return _c("33", s)
def red(s): return _c("31", s)
def dim(s): return _c("2", s)


def _store(args) -> Store:
    return Store(Path(args.data_dir) / "runs.sqlite3")


def _outdir(cfg, args) -> Path:
    d = Path(args.out or cfg.output_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _progress(quiet: bool):
    def cb(ev):
        if quiet or ev.get("event") != "row_done":
            return
        i, n = ev.get("index", 0), ev.get("total", 0)
        mark = yellow("REVIEW") if ev.get("review") else green("ok")
        name = (ev.get("name") or "(unresolved)")[:28]
        email = ev.get("email") or "-"
        phone = ev.get("phone") or "-"
        print(f"  [{i:>4}/{n}] {name:<28} {email:<34} {phone:<18} {mark}")
    return cb


def _set_final_status(store, run_id: str) -> None:
    """A --limit run is 'partial', not 'done' -- rows are still waiting."""
    remaining = len(store.pending_rows(run_id))
    store.set_run_status(run_id, "done" if not remaining else "partial",
                         f"{remaining} row(s) not yet processed" if remaining else "")


def _finish(cfg, store, run_id, args, warnings=None) -> dict:
    """Write all four outputs and print a summary."""
    records = store.all_rows(run_id)
    out = _outdir(cfg, args)
    d = write_delivery(out / f"{run_id}_delivery.csv", records,
                       label_contact_type=cfg.phone_policy.export_contact_type_label)
    a = write_audit(out / f"{run_id}_audit.csv", records)
    r = write_review(out / f"{run_id}_review.csv", records)
    report = write_run_report(
        out / f"{run_id}_report.json", run_id=run_id,
        stats=store.counts(run_id), budget=store.load_budget(run_id),
        records=records, warnings=warnings or [])

    print()
    print(bold(f"  Run {run_id} complete"))
    print(f"    delivery : {out / f'{run_id}_delivery.csv'}  ({d} rows)")
    print(f"    audit    : {out / f'{run_id}_audit.csv'}  ({a} rows)")
    print(f"    review   : {out / f'{run_id}_review.csv'}  ({r} rows)")
    print(f"    report   : {out / f'{run_id}_report.json'}")
    print()
    print(bold("  Fill rate"))
    for col, pct in report["fill_rate_percent"].items():
        bar = "#" * int(pct / 5)
        colour = green if pct >= 70 else (yellow if pct >= 40 else red)
        print(f"    {col:<7} {colour(f'{pct:5.1f}%')} {dim(bar)}")
    budget = report.get("budget") or {}
    if budget.get("total_requests"):
        print()
        print(f"  {dim('provider calls')}: {budget['total_requests']}"
              f"   {dim('estimated credits')}: {budget.get('total_estimated_credits', 0)}")
    if r:
        print()
        print(yellow(f"  {r} row(s) need a human. See the review file above."))
    remaining = len(store.pending_rows(run_id))
    if remaining:
        print()
        print(yellow(f"  {remaining} row(s) not yet processed. Continue with:"))
        print(f"    python3 -m leadenrich.cli resume {run_id}")
    return report


# ------------------------------------------------------------------ commands

def cmd_run(args) -> int:
    load_dotenv(args.env)
    cfg = load_config(args.config, demo=args.demo)
    src = Path(args.input) if args.input else SAMPLE
    if not src.exists():
        print(red(f"input file not found: {src}"))
        return 2

    inputs, warnings = read_inputs(src)
    if not inputs:
        print(red("no usable rows in the input file"))
        for w in warnings:
            print(f"  - {w}")
        return 2
    for w in warnings:
        print(yellow(f"  note: {w}"))

    store = _store(args)
    run_id = prepare_run(cfg, store, inputs, input_path=str(src))
    print(bold(f"\n  Run {run_id}  --  {len(inputs)} row(s)"
               f"{'  [DEMO: fictional data, no network]' if cfg.demo_mode else ''}\n"))

    pipe = Pipeline(cfg, store, run_id, progress=_progress(args.quiet))
    try:
        pipe.run(limit=args.limit)
    except KeyboardInterrupt:
        store.set_run_status(run_id, "interrupted")
        print(yellow(f"\n  Interrupted. Resume with:  leadenrich resume {run_id}"))
        _finish(cfg, store, run_id, args, warnings)
        return 130
    _set_final_status(store, run_id)
    _finish(cfg, store, run_id, args, warnings)
    if args.sheet or args.sheet_id:
        _push_sheet(cfg, store, run_id, args)
    return 0


def cmd_demo(args) -> int:
    args.demo = True
    args.input = args.input or str(SAMPLE)
    return cmd_run(args)


def cmd_resume(args) -> int:
    load_dotenv(args.env)
    cfg = load_config(args.config, demo=args.demo)
    store = _store(args)
    if not store.get_run(args.run_id):
        print(red(f"unknown run: {args.run_id}"))
        return 2
    pending = store.pending_rows(args.run_id)
    if not pending:
        print(green("  nothing pending -- run already complete. Re-exporting."))
        _finish(cfg, store, args.run_id, args)
        return 0
    print(bold(f"\n  Resuming {args.run_id}  --  {len(pending)} row(s) left\n"))
    pipe = Pipeline(cfg, store, args.run_id, progress=_progress(args.quiet))
    pipe.run(pending, limit=args.limit)
    _set_final_status(store, args.run_id)
    _finish(cfg, store, args.run_id, args)
    return 0


def cmd_export(args) -> int:
    load_dotenv(args.env)
    cfg = load_config(args.config, demo=args.demo)
    store = _store(args)
    if not store.get_run(args.run_id):
        print(red(f"unknown run: {args.run_id}"))
        return 2
    _finish(cfg, store, args.run_id, args)
    if args.sheet or args.sheet_id:
        _push_sheet(cfg, store, args.run_id, args)
    return 0


def _push_sheet(cfg, store, run_id, args) -> None:
    from .sheets import export_to_sheet
    res = export_to_sheet(store.all_rows(run_id), spreadsheet_id=args.sheet_id or "",
                          sheet_name=args.sheet_name,
                          label_contact_type=cfg.phone_policy.export_contact_type_label)
    print()
    if res.ok:
        print(green(f"  Google Sheet updated: {res.spreadsheet_url}  ({res.message})"))
    else:
        print(yellow(f"  Google Sheets export skipped: {res.message}"))
        if res.service_account_email:
            print(dim(f"    share the sheet with {res.service_account_email} as Editor"))


def cmd_review(args) -> int:
    cfg = load_config(args.config, demo=args.demo)
    store = _store(args)
    records = [r for r in store.all_rows(args.run_id) if r.needs_review()]
    if not records:
        print(green("  Nothing in the review queue."))
        return 0
    print(bold(f"\n  {len(records)} row(s) need a human\n"))
    for rec in records[: args.limit or 50]:
        print(bold(f"  {rec.inp.row_id}  {rec.name.value or '(unresolved)'}"))
        if rec.inp.linkedin_url:
            print(dim(f"    {rec.inp.linkedin_url}"))
        for reason in rec.review_reasons:
            print(f"    - {yellow(reason)}")
        from .io_csv import _suggest
        print(f"    {green('do:')} {_suggest(rec)}")
        print()
    return 0


def cmd_doctor(args) -> int:
    """Say exactly what is configured, what is missing, and what that costs you."""
    loaded = load_dotenv(args.env)
    cfg = load_config(args.config)
    print(bold("\n  Configuration check\n"))
    print(f"  config file : {args.config or 'config/pipeline.yml'}")
    print(f"  env file    : {args.env} ({loaded} variable(s) loaded)")
    print()

    ready_stages = []
    for stage in ("identity", "email", "validation", "phone"):
        names = cfg.enabled_in(stage)
        print(bold(f"  {stage}"))
        any_ready = False
        for name in names:
            pc = cfg.provider(name)
            prov = registry.build(name, pc) if pc else None
            if prov is None:
                print(f"    {red('X')} {name:<16} not registered")
                continue
            ok = prov.available()
            any_ready = any_ready or ok
            mark = green("OK ") if ok else yellow("-- ")
            need = pc.api_key_env or ", ".join(pc.extra_env.values()) or "no key needed"
            print(f"    {mark} {name:<16} {dim(need)}")
            if not ok and prov.NOTE:
                print(f"        {dim(prov.NOTE)}")
        if any_ready:
            ready_stages.append(stage)
        else:
            print(f"    {yellow('no provider in this stage has credentials')}")
        print()

    from .sheets import preflight
    res = preflight()
    print(bold("  Google Sheets"))
    print(f"    {green('OK ') if res.ok else yellow('-- ')} {res.message}")
    if res.service_account_email:
        print(dim(f"        share your sheet with {res.service_account_email} as Editor"))
    print()

    print(bold("  Verdict"))
    if len(ready_stages) == 4:
        print(green("    All four stages have at least one working provider."))
        print(dim("    Next: leadenrich smoke --provider <name> to confirm a live call."))
    elif ready_stages:
        missing = [s for s in ("identity", "email", "validation", "phone")
                   if s not in ready_stages]
        print(yellow(f"    Ready: {', '.join(ready_stages)}. "
                     f"No credentials for: {', '.join(missing)}."))
        print(dim("    Rows will still run; unconfigured stages are skipped, not faked."))
    else:
        print(yellow("    No provider credentials found. Demo mode still works:"))
        print(dim("    leadenrich demo"))
    print()
    return 0


def cmd_smoke(args) -> int:
    """One live call against one provider, printing raw response beside our parse.

    This is the step that converts an adapter from 'written against the docs' to
    'confirmed against the live API'. It costs a credit or two.
    """
    load_dotenv(args.env)
    cfg = load_config(args.config)
    pc = cfg.provider(args.provider)
    if not pc:
        print(red(f"unknown provider '{args.provider}'. Known: "
                  f"{', '.join(registry.names())}"))
        return 2
    prov = registry.build(args.provider, pc)
    if prov is None:
        print(red(f"provider '{args.provider}' is not registered"))
        return 2
    if not prov.available():
        print(red(f"no credentials for {args.provider} "
                  f"(set {pc.api_key_env or ', '.join(pc.extra_env.values())})"))
        return 2

    inp = LeadInput(linkedin_url=args.linkedin_url or "", full_name=args.name or "",
                    company=args.company or "", domain=args.domain or "")
    rec = LeadRecord(inp=inp)
    ctx = {"full_name": args.name or "", "company": args.company or "",
           "domain": args.domain or "", "email": args.email or ""}

    print(bold(f"\n  Live call: {args.provider}"))
    print(dim(f"  docs: {prov.DOC_URL or '(local adapter)'}\n"))
    if not prov.can_handle(rec, ctx):
        print(yellow(f"  insufficient input: {prov.missing_input_reason(rec, ctx)}"))
        return 2

    result, call = prov.execute(rec, ctx)
    print(f"  outcome     : {result.outcome}")
    print(f"  http status : {result.http_status}")
    print(f"  attempts    : {call.attempts}   duration: {call.duration_ms}ms")
    print(f"  detail      : {result.detail}")
    print()
    print(bold("  Parsed by the adapter:"))
    if result.identity:
        print(json.dumps(result.identity.__dict__, indent=4, default=str))
    if result.emails:
        print(json.dumps([e.to_dict() for e in result.emails], indent=4, default=str))
    if result.phones:
        print(json.dumps([p.to_dict() for p in result.phones], indent=4, default=str))
    if result.validation:
        print(json.dumps(result.validation.__dict__, indent=4, default=str))
    if not any((result.identity, result.emails, result.phones, result.validation)):
        print(dim("    (nothing parsed)"))
    print()
    print(dim("  Compare the parse above against the provider's documented response."
              " If they disagree, the adapter needs updating -- not the docs."))
    return 0


def cmd_runs(args) -> int:
    store = _store(args)
    runs = store.list_runs()
    if not runs:
        print("  no runs yet")
        return 0
    print(bold("\n  Runs\n"))
    for r in runs:
        counts = store.counts(r["run_id"])
        done = counts.get("done", 0)
        total = sum(counts.values())
        print(f"    {r['run_id']}  {r['status']:<12} {done}/{total} rows"
              f"  {dim(r.get('input_path') or '')}")
    print()
    return 0


def cmd_ui(args) -> int:
    from .web.app import serve
    load_dotenv(args.env)
    serve(config_path=args.config, data_dir=args.data_dir,
          host=args.host, port=args.port, demo=args.demo)
    return 0


# -------------------------------------------------------------------- parser

def _common_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", default=None, help="path to pipeline.yml")
    parser.add_argument("--env", default=".env", help="path to the .env file")
    parser.add_argument("--data-dir", default="data",
                        help="where the run database lives")
    parser.add_argument("--out", default=None, help="output directory")
    parser.add_argument("--demo", action="store_true",
                        help="use fictional fixtures; no network, no credentials")
    parser.add_argument("--quiet", action="store_true")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="leadenrich",
        description="Waterfall lead enrichment for LinkedIn-sourced clinic "
                    "decision-makers, with per-field provenance.")
    _common_flags(p)

    # The same flags are accepted after the subcommand too, so
    # `leadenrich demo --quiet` works as readily as `leadenrich --quiet demo`.
    common = argparse.ArgumentParser(add_help=False)
    _common_flags(common)

    sub = p.add_subparsers(dest="command", required=True, parser_class=(
        lambda **kw: argparse.ArgumentParser(parents=[common], **kw)))

    def add_sheet_flags(sp):
        sp.add_argument("--sheet", action="store_true",
                        help="also write to Google Sheets")
        sp.add_argument("--sheet-id", default=None, help="spreadsheet id")
        sp.add_argument("--sheet-name", default="Leads", help="tab name")

    r = sub.add_parser("run", help="enrich a CSV of leads")
    r.add_argument("input", nargs="?", help="input CSV")
    r.add_argument("--limit", type=int, default=None, help="process only N rows")
    add_sheet_flags(r)
    r.set_defaults(func=cmd_run)

    d = sub.add_parser("demo", help="run the built-in fictional sample")
    d.add_argument("input", nargs="?", default=None)
    d.add_argument("--limit", type=int, default=None)
    add_sheet_flags(d)
    d.set_defaults(func=cmd_demo)

    rs = sub.add_parser("resume", help="continue an interrupted run")
    rs.add_argument("run_id")
    rs.add_argument("--limit", type=int, default=None)
    rs.set_defaults(func=cmd_resume)

    e = sub.add_parser("export", help="re-export a run without re-enriching")
    e.add_argument("run_id")
    add_sheet_flags(e)
    e.set_defaults(func=cmd_export)

    v = sub.add_parser("review", help="show rows that need a human")
    v.add_argument("run_id")
    v.add_argument("--limit", type=int, default=50)
    v.set_defaults(func=cmd_review)

    sub.add_parser("doctor", help="what is configured and what is missing"
                   ).set_defaults(func=cmd_doctor)
    sub.add_parser("runs", help="list previous runs").set_defaults(func=cmd_runs)

    s = sub.add_parser("smoke", help="one live call against one provider")
    s.add_argument("--provider", required=True)
    s.add_argument("--linkedin-url", default=None)
    s.add_argument("--name", default=None)
    s.add_argument("--company", default=None)
    s.add_argument("--domain", default=None)
    s.add_argument("--email", default=None, help="for validation providers")
    s.set_defaults(func=cmd_smoke)

    u = sub.add_parser("ui", help="open the browser interface")
    u.add_argument("--host", default="127.0.0.1")
    u.add_argument("--port", type=int, default=8000)
    u.set_defaults(func=cmd_ui)
    return p


SUBCOMMANDS = {"run", "demo", "resume", "export", "review", "doctor", "runs",
               "smoke", "ui"}


def main(argv: list[str] | None = None) -> int:
    """Accept the shared flags on either side of the subcommand.

    ``leadenrich --demo run leads.csv`` and ``leadenrich run leads.csv --demo``
    both work. argparse alone cannot do this: the subparser's defaults would
    overwrite anything given before the subcommand, so the leading flags are
    parsed separately and merged in.
    """
    parser = build_parser()
    argv = list(sys.argv[1:] if argv is None else argv)

    split = next((i for i, tok in enumerate(argv) if tok in SUBCOMMANDS), len(argv))
    leading, remainder = argv[:split], argv[split:]

    flags_only = argparse.ArgumentParser(add_help=False)
    _common_flags(flags_only)
    pre, _unknown = flags_only.parse_known_args(leading)

    args = parser.parse_args(remainder or argv)

    # A flag given before the subcommand wins over the subparser's default.
    defaults = {"config": None, "env": ".env", "data_dir": "data", "out": None}
    for flag, default in defaults.items():
        if getattr(args, flag, default) == default and getattr(pre, flag, default) != default:
            setattr(args, flag, getattr(pre, flag))
    for flag in ("demo", "quiet"):
        if getattr(pre, flag, False):
            setattr(args, flag, True)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
