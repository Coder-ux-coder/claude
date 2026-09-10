"""Browser interface.

Deliberately small: upload a CSV, press Run, watch it, download the result.
Runs happen on a background thread and stream progress to the page, so a
2,000-row job can be left alone and checked on later. Every run is checkpointed
in the same SQLite file the CLI uses, so the two interfaces are interchangeable
-- start a run in the browser, resume it from the terminal, or the reverse.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path

import os

from flask import (Flask, Response, jsonify, redirect, render_template,
                   request, send_file, url_for)

from ..config import load_config, load_dotenv
from ..io_csv import (read_inputs, review_row, write_audit, write_delivery,
                      write_review, write_run_report)
from ..pipeline import Pipeline, prepare_run
from ..providers import registry
from ..store import Store

#: In-flight runs, keyed by run_id. Progress events are appended for the poller.
_RUNS: dict[str, dict] = {}
_LOCK = threading.Lock()


def create_app(config_path: str | None = None, data_dir: str = "data",
               demo: bool = False, env_path: str = ".env",
               local_only: bool = True) -> Flask:
    app = Flask(__name__)
    app.config["CONFIG_PATH"] = config_path
    app.config["DATA_DIR"] = data_dir
    app.config["DEMO"] = demo
    app.config["UPLOAD_DIR"] = str(Path(data_dir) / "uploads")
    app.config["ENV_PATH"] = env_path or ".env"
    app.config["LOCAL_ONLY"] = local_only
    Path(app.config["UPLOAD_DIR"]).mkdir(parents=True, exist_ok=True)

    def store() -> Store:
        return Store(Path(app.config["DATA_DIR"]) / "runs.sqlite3")

    def cfg(demo_override: bool | None = None):
        return load_config(app.config["CONFIG_PATH"],
                           demo=(app.config["DEMO"] if demo_override is None
                                 else demo_override))

    # ------------------------------------------------------------- pages
    @app.route("/")
    def index():
        st = store()
        runs = st.list_runs(limit=10)
        for r in runs:
            r["counts"] = st.counts(r["run_id"])
        return render_template("index.html", runs=runs,
                               readiness=_readiness(cfg(demo_override=False)))

    @app.route("/setup")
    def setup():
        from ..cli import KEY_PROMPTS, _mask, _read_env_file
        from ..sheets import preflight
        env_path = Path(app.config["ENV_PATH"])
        current = _read_env_file(env_path)
        keys = [{"var": v, "provider": prov, "why": why, "where": where,
                 "masked": _mask(current.get(v, "")),
                 "set": bool(current.get(v))}
                for v, prov, why, where in KEY_PROMPTS]
        return render_template("setup.html",
                               readiness=_readiness(cfg(demo_override=False)),
                               sheets=preflight(), keys=keys,
                               env_path=str(env_path),
                               local_only=app.config["LOCAL_ONLY"],
                               saved=request.args.get("saved"))

    @app.route("/setup/keys", methods=["POST"])
    def save_keys():
        """Write the pasted keys to .env.

        Refused outright unless the server is bound to loopback. A form that
        accepts API keys must never be reachable from another machine, and the
        check belongs here rather than in a warning nobody reads.
        """
        from ..cli import KEY_PROMPTS, _read_env_file, _write_env_file
        if not app.config["LOCAL_ONLY"]:
            return render_template(
                "error.html",
                message="Key entry is disabled because this server is not "
                        "bound to localhost.",
                details=["Restart without --host, or set the keys with "
                         "`python3 -m leadenrich.cli keys` instead."]), 403

        env_path = Path(app.config["ENV_PATH"])
        values = _read_env_file(env_path)
        changed = 0
        for var, *_rest in KEY_PROMPTS:
            entered = (request.form.get(var) or "").strip()
            if entered:
                values[var] = entered
                changed += 1
        _write_env_file(env_path, values)
        # Reload so the running process sees the new keys without a restart.
        for var, *_rest in KEY_PROMPTS:
            if values.get(var):
                os.environ[var] = values[var]
        return redirect(url_for("setup", saved=changed))

    @app.route("/run/<run_id>")
    def run_page(run_id: str):
        st = store()
        meta = st.get_run(run_id)
        if not meta:
            return redirect(url_for("index"))
        records = st.all_rows(run_id)
        return render_template("run.html", run_id=run_id, meta=meta,
                               counts=st.counts(run_id),
                               rows=[_row_view(r) for r in records],
                               review=[review_row(r) for r in records
                                       if r.needs_review()],
                               budget=st.load_budget(run_id),
                               live=run_id in _RUNS and _RUNS[run_id]["active"])

    # ------------------------------------------------------------- actions
    @app.route("/start", methods=["POST"])
    def start():
        use_demo = request.form.get("mode") == "demo"
        configuration = cfg(demo_override=use_demo)

        if use_demo:
            src = Path(__file__).resolve().parents[2] / "samples" / "sample_input.csv"
        else:
            upload = request.files.get("file")
            if not upload or not upload.filename:
                return redirect(url_for("index"))
            src = Path(app.config["UPLOAD_DIR"]) / f"{uuid.uuid4().hex[:8]}_{upload.filename}"
            upload.save(src)

        inputs, warnings = read_inputs(src)
        if not inputs:
            return render_template("error.html",
                                   message="No usable rows were found in that file.",
                                   details=warnings)

        limit = request.form.get("limit", "").strip()
        limit_n = int(limit) if limit.isdigit() and int(limit) > 0 else None

        st = store()
        run_id = prepare_run(configuration, st, inputs, input_path=str(src))
        _launch(app, configuration, run_id, limit_n, warnings)
        return redirect(url_for("run_page", run_id=run_id))

    @app.route("/resume/<run_id>", methods=["POST"])
    def resume(run_id: str):
        configuration = cfg()
        st = store()
        if st.pending_rows(run_id):
            _launch(app, configuration, run_id, None, [])
        return redirect(url_for("run_page", run_id=run_id))

    @app.route("/progress/<run_id>")
    def progress(run_id: str):
        with _LOCK:
            state = _RUNS.get(run_id)
            if state is None:
                st = store()
                counts = st.counts(run_id)
                return jsonify({"active": False, "events": [],
                                "done": counts.get("done", 0),
                                "total": sum(counts.values())})
            since = int(request.args.get("since", 0))
            events = state["events"][since:]
            return jsonify({"active": state["active"], "events": events,
                            "cursor": len(state["events"]),
                            "error": state.get("error", "")})

    @app.route("/download/<run_id>/<kind>")
    def download(run_id: str, kind: str):
        configuration = cfg()
        st = store()
        records = st.all_rows(run_id)
        out = Path(configuration.output_dir)
        out.mkdir(parents=True, exist_ok=True)
        paths = {
            "delivery": out / f"{run_id}_delivery.csv",
            "audit": out / f"{run_id}_audit.csv",
            "review": out / f"{run_id}_review.csv",
        }
        if kind not in paths:
            return redirect(url_for("run_page", run_id=run_id))
        if kind == "delivery":
            write_delivery(paths[kind], records,
                           label_contact_type=configuration.phone_policy.export_contact_type_label)
        elif kind == "audit":
            write_audit(paths[kind], records)
        else:
            write_review(paths[kind], records)
        return send_file(paths[kind].resolve(), as_attachment=True,
                         download_name=paths[kind].name)

    @app.route("/sheet/<run_id>", methods=["POST"])
    def push_sheet(run_id: str):
        from ..sheets import export_to_sheet
        configuration = cfg()
        res = export_to_sheet(
            store().all_rows(run_id),
            spreadsheet_id=request.form.get("sheet_id", "").strip(),
            sheet_name=request.form.get("sheet_name", "Leads").strip() or "Leads",
            label_contact_type=configuration.phone_policy.export_contact_type_label)
        return render_template("sheet_result.html", res=res, run_id=run_id)

    return app


# ------------------------------------------------------------------ helpers

def _launch(app, configuration, run_id: str, limit, warnings) -> None:
    """Run the pipeline on a background thread, buffering progress events."""
    with _LOCK:
        _RUNS[run_id] = {"active": True, "events": [], "error": "",
                         "started": time.time()}

    def worker():
        st = Store(Path(app.config["DATA_DIR"]) / "runs.sqlite3")

        def on_event(ev):
            with _LOCK:
                _RUNS[run_id]["events"].append(ev)

        try:
            pipe = Pipeline(configuration, st, run_id, progress=on_event)
            pipe.run(limit=limit)
            st.set_run_status(run_id, "done")
            records = st.all_rows(run_id)
            out = Path(configuration.output_dir)
            write_delivery(out / f"{run_id}_delivery.csv", records)
            write_audit(out / f"{run_id}_audit.csv", records)
            write_review(out / f"{run_id}_review.csv", records)
            write_run_report(out / f"{run_id}_report.json", run_id=run_id,
                             stats=st.counts(run_id), budget=st.load_budget(run_id),
                             records=records, warnings=warnings)
        except Exception as exc:                      # surface, never swallow
            with _LOCK:
                _RUNS[run_id]["error"] = str(exc)
            st.set_run_status(run_id, "failed", str(exc)[:500])
        finally:
            with _LOCK:
                _RUNS[run_id]["active"] = False
            st.close()

    threading.Thread(target=worker, name=f"run-{run_id}", daemon=True).start()


def _readiness(configuration) -> dict:
    """Per-stage credential status, for the setup page and the front-page banner."""
    out = {}
    for stage in ("identity", "email", "validation", "phone"):
        entries = []
        for name in configuration.enabled_in(stage):
            pc = configuration.provider(name)
            prov = registry.build(name, pc) if pc else None
            entries.append({
                "name": name,
                "ready": bool(prov and prov.available()),
                "needs": pc.api_key_env or ", ".join(pc.extra_env.values()) or "none",
                "note": (prov.NOTE if prov else ""),
                "docs": (prov.DOC_URL if prov else ""),
            })
        out[stage] = {"providers": entries,
                      "ready": any(e["ready"] for e in entries)}
    return out


def _row_view(rec) -> dict:
    from ..io_csv import delivery_row
    d = delivery_row(rec)
    return {
        "row_id": rec.inp.row_id,
        "linkedin": rec.inp.linkedin_url,
        "name": d["Name"], "role": d["Role"], "clinic": d["Clinic"],
        "phone": d["Phone"], "email": d["Email"],
        "email_status": rec.email.status,
        "phone_type": rec.phone.provenance.raw_status,
        "identity_check": rec.identity_check,
        "review": rec.needs_review(),
        "reasons": rec.review_reasons,
        "duplicate_of": rec.duplicate_of,
        "sources": d["Source"],
    }


def serve(config_path=None, data_dir="data", host="127.0.0.1", port=8000,
          demo=False, env_path=".env") -> None:
    load_dotenv(env_path)
    # Key entry is offered only on loopback. Bound anywhere else, the form is
    # withheld rather than shown with a warning.
    local_only = host in ("127.0.0.1", "localhost", "::1")
    app = create_app(config_path, data_dir, demo, env_path=env_path,
                     local_only=local_only)
    banner = "  DEMO MODE -- fictional data, no network" if demo else ""
    print(f"\n  Lead enrichment UI:  http://{host}:{port}{banner}")
    if local_only:
        print(f"  Paste your API keys at:  http://{host}:{port}/setup\n")
    else:
        print("  Key entry disabled: not bound to localhost\n")
    app.run(host=host, port=port, debug=False, threaded=True)
