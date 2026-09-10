"""The waterfall orchestrator.

Stage order is fixed (identity -> email -> validation -> phone -> identity check)
because each stage feeds the next; *provider* order inside a stage is pure
configuration. The rules that make a waterfall actually work, all enforced here:

* Stop at the first **accepted** result, where acceptance is a policy decision
  rather than "the provider returned HTTP 200".
* Treat a clean no-match as terminal for that provider and advance at once. Only
  transport failures are retried, and only by the HTTP layer.
* Skip a provider -- never fail the row -- when credentials are absent, the
  budget is spent, or the row lacks the input that provider requires.
* Checkpoint after every stage so a killed run resumes without re-buying work.
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from .breaker import FATAL_STATUSES, CircuitBreaker
from .budget import Budget, BudgetExceeded
from .config import Config
from .httpclient import HttpClient
from .models import (CONTACT_TYPE_LABELS, CallOutcome, ContactType, Deliverability,
                     FieldStatus, IdentityCheck, LeadInput, LeadRecord, Ownership,
                     PhoneCandidate, ProviderCall)
from .normalize import (canonical_linkedin_url, company_similarity, dedupe_key,
                        looks_like_clinic, name_similarity, normalise_domain,
                        normalise_role, split_name)
from .phone import select_exportable
from .providers import registry
from .ratelimit import LimiterRegistry
from .store import Store
from .validation import map_status, select_email

STAGES = ("identity", "email", "validation", "phone")


@dataclass
class RunStats:
    total: int = 0
    processed: int = 0
    skipped_duplicates: int = 0
    with_email: int = 0
    with_phone: int = 0
    needs_review: int = 0
    errors: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "total": self.total, "processed": self.processed,
            "skipped_duplicates": self.skipped_duplicates,
            "with_email": self.with_email, "with_phone": self.with_phone,
            "needs_review": self.needs_review, "errors": self.errors,
        }


class Pipeline:
    """Runs rows through the stages, persisting after each one."""

    def __init__(self, cfg: Config, store: Store, run_id: str,
                 *, http: HttpClient | None = None,
                 progress: Callable[[dict[str, Any]], None] | None = None):
        self.cfg = cfg
        self.store = store
        self.run_id = run_id
        self.progress = progress or (lambda _e: None)
        self.http = http or HttpClient(
            max_attempts=cfg.retry.max_attempts, base_delay=cfg.retry.base_delay,
            max_delay=cfg.retry.max_delay, jitter=cfg.retry.jitter)
        self.budget = Budget(
            max_total_requests=cfg.budget.max_total_requests,
            max_estimated_credits=cfg.budget.max_estimated_credits,
            per_provider=dict(cfg.budget.per_provider))
        self.stats = RunStats()
        self.limiters = LimiterRegistry()
        self.breaker = CircuitBreaker(threshold=cfg.breaker_threshold)
        self._providers: dict[str, Any] = {}
        self._warnings: list[str] = []

    # ------------------------------------------------------------- helpers
    def _update_breaker(self, name: str, result) -> None:
        """Feed one call's outcome to the breaker.

        Only *permanent* failures count. A transient error is what the retry
        layer exists for, and tripping on it would disable a healthy provider
        during a bad minute.
        """
        outcome = result.outcome
        if outcome in (CallOutcome.HIT.value, CallOutcome.NO_MATCH.value):
            self.breaker.record_success(name)
            return
        if outcome != CallOutcome.PERMANENT_ERROR.value:
            return
        status = result.http_status
        if status in FATAL_STATUSES:
            # These never resolve mid-run, so one is enough.
            self.breaker.open_now(
                name, f"HTTP {status}: {FATAL_STATUSES[status]}")
        elif self.breaker.record_permanent_failure(name, result.detail):
            pass

    def _provider(self, name: str):
        """Instantiate lazily and cache -- Snov's token cache depends on this."""
        if name not in self._providers:
            pc = self.cfg.provider(name)
            if pc is None:
                self._providers[name] = None
            else:
                self._providers[name] = registry.build(name, pc, self.http)
        return self._providers[name]

    def _run_provider(self, name: str, rec: LeadRecord, ctx: dict[str, Any],
                      stage: str):
        """Execute one provider, honouring credentials, budget and input needs.

        Returns ``(result_or_None, call)``. A ``None`` result means the provider
        was skipped; the reason is recorded in the ledger either way.
        """
        prov = self._provider(name)
        if prov is None:
            call = ProviderCall(provider=name, stage=stage,
                                outcome=CallOutcome.PERMANENT_ERROR.value,
                                started_at=time.time(),
                                detail="provider not registered or not configured")
            rec.log_call(call)
            return None, call

        if not prov.available():
            call = ProviderCall(provider=name, stage=stage,
                                outcome=CallOutcome.SKIPPED_NO_CREDENTIALS.value,
                                started_at=time.time(),
                                detail=f"missing credentials "
                                       f"({prov.cfg.api_key_env or 'see extra_env'})")
            rec.log_call(call)
            return None, call

        if not prov.can_handle(rec, ctx):
            call = ProviderCall(provider=name, stage=stage,
                                outcome=CallOutcome.SKIPPED_INSUFFICIENT_INPUT.value,
                                started_at=time.time(),
                                detail=prov.missing_input_reason(rec, ctx))
            rec.log_call(call)
            return None, call

        if not self.budget.allows(name):
            self.budget.note_skip(name)
            call = ProviderCall(provider=name, stage=stage,
                                outcome=CallOutcome.SKIPPED_BUDGET.value,
                                started_at=time.time(),
                                detail="budget cap reached for this provider or run")
            rec.log_call(call)
            return None, call

        # A provider whose key is wrong or whose credits are gone will fail on
        # every remaining row. Skip it rather than re-proving that 2,000 times.
        if self.breaker.is_open(name):
            call = ProviderCall(provider=name, stage=stage,
                                outcome=CallOutcome.SKIPPED_PROVIDER_DOWN.value,
                                started_at=time.time(),
                                detail=f"provider disabled for this run: "
                                       f"{self.breaker.reason(name)}")
            rec.log_call(call)
            return None, call

        # Wait for the provider's published pace before calling. A 429 costs
        # more than the wait does.
        try:
            self.limiters.for_provider(name, prov.cfg.options).acquire()
        except TimeoutError as exc:
            call = ProviderCall(provider=name, stage=stage,
                                outcome=CallOutcome.TRANSIENT_ERROR.value,
                                started_at=time.time(), detail=str(exc))
            rec.log_call(call)
            return None, call

        result, call = prov.execute(rec, ctx)
        self._update_breaker(name, result)
        if call.estimated_credits:
            try:
                self.budget.charge(name, call.estimated_credits)
            except BudgetExceeded as exc:
                call.detail = f"{call.detail} | budget note: {exc}"
        rec.log_call(call)
        return result, call

    # -------------------------------------------------------------- stages
    def stage_identity(self, rec: LeadRecord, ctx: dict[str, Any]) -> None:
        """Resolve who this person is, where they work, and their role."""
        i = rec.inp
        # Client-supplied values are treated as given truth and never overwritten.
        if i.full_name:
            rec.name.set(i.full_name, "client_input",
                         status=FieldStatus.FOUND_VERIFIED.value,
                         confidence="high", evidence="supplied on the input row")
        if i.company:
            rec.clinic.set(i.company, "client_input",
                           status=FieldStatus.FOUND_VERIFIED.value, confidence="high",
                           evidence="supplied on the input row")
        if i.domain:
            rec.domain.set(normalise_domain(i.domain), "client_input",
                           status=FieldStatus.FOUND_VERIFIED.value, confidence="high")

        observed: list[tuple[str, Any]] = []
        for name in self.cfg.enabled_in("identity"):
            rec.name.attempts.append(name)
            result, _call = self._run_provider(name, rec, ctx, "identity")
            if result is None or not result.is_hit or result.identity is None:
                continue

            ident = result.identity
            observed.append((name, ident))

            if ident.full_name and not rec.name.is_present():
                rec.name.set(ident.full_name, name,
                             status=FieldStatus.FOUND_UNVERIFIED.value,
                             source_url=ident.source_url,
                             confidence=ident.confidence)
            if ident.title and not rec.role.is_present():
                rec.role.set(normalise_role(ident.title), name,
                             status=FieldStatus.FOUND_UNVERIFIED.value,
                             source_url=ident.source_url,
                             confidence=ident.confidence,
                             evidence=f"title as reported: {ident.title}")
            if ident.company and not rec.clinic.is_present():
                rec.clinic.set(ident.company, name,
                               status=FieldStatus.FOUND_UNVERIFIED.value,
                               source_url=ident.source_url,
                               confidence=ident.confidence)
            if ident.domain and not rec.domain.is_present():
                rec.domain.set(normalise_domain(ident.domain), name,
                               status=FieldStatus.FOUND_UNVERIFIED.value,
                               source_url=ident.source_url)

            # Emails volunteered by an identity provider still face the gate.
            for addr, kind in ident.emails:
                self._add_email_candidate(rec, addr, name, kind)
            # Phones likewise: a provider's own label never becomes our label.
            for number, kind in ident.phones:
                self._add_provider_phone(rec, number, name, kind)

            # A high-confidence provider that answered everything ends the
            # stage -- unless corroboration is switched on, in which case every
            # provider is asked so their answers can be compared.
            if (not self.cfg.identity_corroboration
                    and rec.name.is_present() and rec.role.is_present()
                    and rec.clinic.is_present() and ident.confidence == "high"):
                break

        ctx.update({
            "full_name": rec.name.value or "",
            "company": rec.clinic.value or "",
            "domain": rec.domain.value or "",
            "location": rec.inp.location or "",
        })
        ctx["_identity_observations"] = observed

        for fv in (rec.name, rec.role, rec.clinic):
            if not fv.is_present() and fv.status == FieldStatus.NOT_ATTEMPTED.value:
                fv.status = FieldStatus.NO_MATCH.value

        if not rec.name.is_present():
            rec.flag_review("identity unresolved: no provider matched this profile URL")
        if not rec.clinic.is_present():
            rec.flag_review("clinic/organisation not resolved")

    def _add_email_candidate(self, rec: LeadRecord, addr: str, provider: str,
                             kind: str = "") -> None:
        from .models import EmailCandidate
        from .normalize import valid_email_syntax
        addr = (addr or "").strip().lower()
        if not valid_email_syntax(addr):
            return
        if any(c.address == addr for c in rec.email_candidates):
            return
        # A "personal" address volunteered by a provider is not a work email and
        # is not what this deliverable promises.
        ownership = (Ownership.PROVIDER_ASSERTED.value
                     if "personal" not in (kind or "").lower()
                     else Ownership.UNCONFIRMED.value)
        rec.email_candidates.append(
            EmailCandidate(address=addr, provider=provider, ownership=ownership,
                           validator_status=kind or "", checked_at=time.time()))

    def _add_provider_phone(self, rec: LeadRecord, number: str, provider: str,
                            kind: str) -> None:
        """Record a provider-supplied number, labelled by what it actually is.

        An organisation-level number is a published business line. Anything the
        provider calls a mobile or direct dial has **no publication evidence**,
        so it is stored as ``provider_supplied_unpublished`` and the export gate
        withholds it unless an operator explicitly opts in.
        """
        from .phone import make_candidate
        k = (kind or "").lower()
        if "organization" in k or "company" in k or "hq" in k or "work_hq" in k:
            ctype = ContactType.CLINIC_MAIN_LINE.value
            source = rec.clinic.provenance.source_url or ""
        else:
            ctype = ContactType.PROVIDER_SUPPLIED_UNPUBLISHED.value
            source = ""
        cand = make_candidate(
            number, provider=provider, source_url=source,
            context=f"provider field labelled '{kind}'",
            person_name=rec.name.value or "",
            region=self.cfg.phone_policy.default_region,
            force_contact_type=ctype)
        if cand and not any(p.number_e164 == cand.number_e164
                            for p in rec.phone_candidates):
            rec.phone_candidates.append(cand)

    def stage_email(self, rec: LeadRecord, ctx: dict[str, Any]) -> None:
        """Walk the email waterfall until a provider returns an address."""
        for name in self.cfg.enabled_in("email"):
            if rec.email_candidates and not self.cfg.raw.get("collect_all_emails"):
                break     # first address wins; the rest of the chain is skipped
            rec.email.attempts.append(name)
            result, _call = self._run_provider(name, rec, ctx, "email")
            if result is None or not result.is_hit:
                continue
            for cand in result.emails:
                if not any(c.address == cand.address for c in rec.email_candidates):
                    rec.email_candidates.append(cand)

        if not rec.email_candidates:
            rec.email.status = FieldStatus.NO_MATCH.value
            rec.flag_review("no email found by any configured provider")

    def stage_validation(self, rec: LeadRecord, ctx: dict[str, Any]) -> None:
        """Ask a validator about deliverability only. Ownership is decided elsewhere."""
        validators = self.cfg.enabled_in("validation")
        for cand in rec.email_candidates:
            if cand.deliverability != Deliverability.NOT_CHECKED.value:
                continue
            sub_ctx = dict(ctx, email=cand.address)
            for vname in validators:
                result, _call = self._run_provider(vname, rec, sub_ctx, "validation")
                if result is None or not result.is_hit or result.validation is None:
                    continue
                v = result.validation
                cand.validator = vname
                cand.validator_status = v.status
                cand.validator_sub_status = v.sub_status
                cand.deliverability = map_status(v.status, v.sub_status)
                if v.score is not None and cand.score is None:
                    cand.score = v.score
                if v.free_email:
                    cand.is_free_webmail = True
                break

        accepted, risky, reasons = select_email(
            rec.email_candidates, self.cfg.email_policy)

        if accepted:
            rec.email.set(
                accepted.address, accepted.provider,
                status=FieldStatus.FOUND_VERIFIED.value,
                source_url=(accepted.source_urls[0] if accepted.source_urls else ""),
                confidence="high",
                raw_status=f"{accepted.validator}:{accepted.validator_status}",
                evidence=(f"deliverability={accepted.deliverability}; "
                          f"ownership={accepted.ownership}"))
        elif risky and self.cfg.email_policy.export_risky:
            r = risky[0]
            rec.email.set(
                r.address, r.provider, status=FieldStatus.FOUND_UNVERIFIED.value,
                source_url=(r.source_urls[0] if r.source_urls else ""),
                confidence="low", raw_status=f"{r.validator}:{r.validator_status}",
                evidence=(f"RISKY -- deliverability={r.deliverability}. Exported "
                          f"under export_risky; not a confirmed mailbox."))
            rec.flag_review(f"risky email exported by policy: {r.address} "
                            f"({r.deliverability})")
        elif rec.email_candidates:
            rec.email.status = FieldStatus.REJECTED.value
            rec.email.attempts.extend(c.provider for c in rec.email_candidates)

        for reason in reasons:
            rec.note(f"email rejected -- {reason}")
        if not accepted and rec.email_candidates:
            rec.flag_review("email found but failed the quality gate: "
                            + "; ".join(reasons[:2]))

    def stage_phone(self, rec: LeadRecord, ctx: dict[str, Any]) -> None:
        """Collect *published* business numbers, each with its evidence URL."""
        for name in self.cfg.enabled_in("phone"):
            rec.phone.attempts.append(name)
            result, _call = self._run_provider(name, rec, ctx, "phone")
            if result is None or not result.is_hit:
                continue
            # A listing that yields a website unlocks the website reader downstream.
            if result.raw.get("website") and not ctx.get("website"):
                ctx["website"] = result.raw["website"]
                if not rec.domain.is_present():
                    d = normalise_domain(result.raw["website"])
                    if d:
                        rec.domain.set(d, name,
                                       status=FieldStatus.FOUND_UNVERIFIED.value,
                                       source_url=result.raw.get("maps_uri", ""))
                        ctx["domain"] = d
            for cand in result.phones:
                if not any(p.number_e164 == cand.number_e164
                           for p in rec.phone_candidates):
                    rec.phone_candidates.append(cand)

        chosen, reasons = select_exportable(
            rec.phone_candidates,
            require_public_evidence=self.cfg.phone_policy.require_public_evidence,
            allow_provider_personal_mobile=(
                self.cfg.phone_policy.allow_provider_personal_mobile))

        for reason in reasons:
            rec.note(f"phone withheld -- {reason}")

        if chosen:
            label = CONTACT_TYPE_LABELS.get(chosen.contact_type, chosen.contact_type)
            rec.phone.set(
                chosen.number_e164, chosen.provider,
                status=FieldStatus.FOUND_VERIFIED.value,
                source_url=chosen.source_url, confidence="high",
                raw_status=chosen.contact_type,
                evidence=f"{label}; evidence: {chosen.evidence[:120]}")
        else:
            rec.phone.status = (FieldStatus.REJECTED.value if rec.phone_candidates
                                else FieldStatus.NO_MATCH.value)
            rec.flag_review("no published business phone with source evidence")

    def stage_identity_check(self, rec: LeadRecord, ctx: dict[str, Any]) -> None:
        """Cross-check what the providers agreed on before shipping the row."""
        observations = ctx.get("_identity_observations") or []
        notes: list[str] = []
        verdict = IdentityCheck.PASS.value

        if not rec.name.is_present():
            rec.identity_check = IdentityCheck.UNRESOLVED.value
            return

        names = [(p, i.full_name) for p, i in observations if i.full_name]
        for prov, other in names:
            sim = name_similarity(rec.name.value or "", other)
            if sim < 0.5:
                verdict = IdentityCheck.CONFLICT.value
                notes.append(f"name disagreement: '{rec.name.value}' vs "
                             f"'{other}' from {prov} (similarity {sim:.2f})")

        companies = [(p, i.company) for p, i in observations if i.company]
        for prov, other in companies:
            sim = company_similarity(rec.clinic.value or "", other)
            if rec.clinic.value and sim < 0.34:
                verdict = (IdentityCheck.CONFLICT.value
                           if verdict != IdentityCheck.CONFLICT.value else verdict)
                notes.append(f"employer disagreement: '{rec.clinic.value}' vs "
                             f"'{other}' from {prov} (similarity {sim:.2f})")

        # An email whose domain is unrelated to the clinic domain is a common
        # sign of a wrong match, so it is surfaced rather than silently shipped.
        if rec.email.is_present() and rec.domain.is_present():
            from .normalize import email_domain
            ed, cd = email_domain(rec.email.value or ""), rec.domain.value or ""
            if ed and cd and ed != cd and not (ed.endswith(cd) or cd.endswith(ed)):
                from .normalize import is_free_webmail
                if not is_free_webmail(rec.email.value or ""):
                    verdict = IdentityCheck.WEAK.value if verdict == IdentityCheck.PASS.value else verdict
                    notes.append(f"email domain '{ed}' differs from clinic domain '{cd}'")

        if rec.clinic.is_present() and not looks_like_clinic(rec.clinic.value or ""):
            notes.append(f"'{rec.clinic.value}' does not read as a clinic/healthcare "
                         f"organisation -- confirm this is in scope")
            verdict = IdentityCheck.WEAK.value if verdict == IdentityCheck.PASS.value else verdict

        if rec.name.provenance.confidence == "low" and len(observations) <= 1:
            verdict = IdentityCheck.WEAK.value if verdict == IdentityCheck.PASS.value else verdict
            notes.append("name derived only from the profile handle -- unconfirmed")

        rec.identity_check = verdict
        for n in notes:
            rec.note(n)
        if verdict == IdentityCheck.CONFLICT.value:
            rec.flag_review("identity conflict between providers -- see notes")
        elif verdict == IdentityCheck.WEAK.value:
            rec.flag_review("weak identity confirmation -- see notes")

    # ----------------------------------------------------------------- run
    def process_row(self, rec: LeadRecord) -> LeadRecord:
        """Run one row through every stage it has not already completed."""
        ctx: dict[str, Any] = {}
        stage_fns = {
            "identity": self.stage_identity,
            "email": self.stage_email,
            "validation": self.stage_validation,
            "phone": self.stage_phone,
        }
        for stage in STAGES:
            if stage in rec.stages_done:
                # Rebuild the context a resumed row needs without re-calling.
                if stage == "identity":
                    ctx.update({"full_name": rec.name.value or "",
                                "company": rec.clinic.value or "",
                                "domain": rec.domain.value or "",
                                "location": rec.inp.location or ""})
                continue
            try:
                stage_fns[stage](rec, ctx)
            except Exception as exc:                      # never lose a row
                rec.flag_review(f"stage '{stage}' failed: {exc}")
                rec.log_call(ProviderCall(
                    provider="pipeline", stage=stage,
                    outcome=CallOutcome.PERMANENT_ERROR.value,
                    started_at=time.time(), detail=str(exc)[:300]))
                self.stats.errors += 1
            rec.stages_done.append(stage)
            self.store.upsert_row(self.run_id, rec, "in_progress",
                                  dedupe_key=self._key(rec))

        if "identity_check" not in rec.stages_done:
            self.stage_identity_check(rec, ctx)
            rec.stages_done.append("identity_check")
        return rec

    def run_summary(self) -> dict[str, Any]:
        """Spend, plus anything that changed how the run behaved."""
        out = dict(self.budget.summary())
        disabled = self.breaker.summary()
        if disabled:
            out["disabled_providers"] = disabled
        waits = self.limiters.summary()
        if waits:
            out["rate_limit_waits"] = waits
        return out

    @staticmethod
    def _key(rec: LeadRecord) -> str:
        return dedupe_key(rec.inp.linkedin_url, rec.name.value or rec.inp.full_name,
                          rec.clinic.value or rec.inp.company,
                          rec.domain.value or rec.inp.domain,
                          rec.email.value or "")

    def run(self, records: Iterable[LeadRecord] | None = None,
            *, limit: int | None = None) -> RunStats:
        """Process pending rows, checkpointing throughout. Safe to re-enter."""
        rows = list(records) if records is not None else self.store.pending_rows(self.run_id)
        if limit:
            rows = rows[:limit]
        self.stats.total = len(rows)

        seen_keys: dict[str, str] = {}
        for existing in self.store.iter_rows(self.run_id, state="done"):
            k = self._key(existing)
            if k:
                seen_keys.setdefault(k, existing.inp.row_id)

        for idx, rec in enumerate(rows, 1):
            key = self._key(rec)
            if key and key in seen_keys and seen_keys[key] != rec.inp.row_id:
                rec.duplicate_of = seen_keys[key]
                rec.flag_review(f"duplicate of row {rec.duplicate_of}")
                self.store.upsert_row(self.run_id, rec, "duplicate", dedupe_key=key)
                self.stats.skipped_duplicates += 1
                self.progress({"event": "row_duplicate", "index": idx,
                               "row_id": rec.inp.row_id, "of": rec.duplicate_of})
                continue

            rec = self.process_row(rec)
            final_key = self._key(rec)
            if final_key:
                seen_keys.setdefault(final_key, rec.inp.row_id)

            self.store.upsert_row(self.run_id, rec, "done", dedupe_key=final_key)
            self.stats.processed += 1
            if rec.email.is_present():
                self.stats.with_email += 1
            if rec.phone.is_present():
                self.stats.with_phone += 1
            if rec.needs_review():
                self.stats.needs_review += 1

            self.store.save_budget(self.run_id, self.run_summary())
            self.progress({
                "event": "row_done", "index": idx, "total": self.stats.total,
                "row_id": rec.inp.row_id, "name": rec.name.value or "",
                "email": rec.email.value or "", "phone": rec.phone.value or "",
                "review": rec.needs_review(),
                "stats": self.stats.as_dict(),
                "budget": self.run_summary(),
            })

        self.store.save_budget(self.run_id, self.run_summary())
        return self.stats


# --------------------------------------------------------------------------
# Run construction
# --------------------------------------------------------------------------

def new_run_id() -> str:
    return time.strftime("run-%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]


def prepare_run(cfg: Config, store: Store, inputs: list[LeadInput],
                *, run_id: str | None = None, input_path: str = "") -> str:
    """Seed a run. Re-seeding an existing run never resets completed rows."""
    rid = run_id or new_run_id()
    store.create_run(rid, json.dumps(cfg.raw, default=str), input_path)
    records = []
    for inp in inputs:
        if inp.linkedin_url:
            inp.linkedin_url = canonical_linkedin_url(inp.linkedin_url)
        if inp.full_name and not (inp.first_name and inp.last_name):
            inp.first_name, inp.last_name = split_name(inp.full_name)
        rec = LeadRecord(inp=inp)
        key = dedupe_key(inp.linkedin_url, inp.full_name, inp.company,
                         inp.domain, "")
        records.append((rec, key))
    store.seed_rows(rid, records)
    return rid
