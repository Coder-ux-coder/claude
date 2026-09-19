import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowRight, Check, CheckCircle2, ClipboardPaste, Copy, CornerDownLeft,
  Eraser, ExternalLink, Link2, Loader2, Mail, PauseCircle, Save, Search, Users,
} from "lucide-react";
import { api, ApiError } from "../api";
import { copyText, openTab } from "../lib/format";
import type {
  DuplicateCheck, ExtractResult, Lead, LeadDraft, NextAction, ValidateResult,
} from "../types";
import type { ToastKind } from "./Toast";

interface Props {
  draft: LeadDraft;
  onDraft: (draft: LeadDraft) => void;
  savedLeadId: number | null;
  onSavedLeadId: (id: number | null) => void;
  notify: (kind: ToastKind, message: string, action?: { label: string; onClick: () => void }) => void;
  onChanged: () => void;
  onOpenLead: (id: number) => void;
}

const EMPTY: LeadDraft = { profile_url: "", follower_count: "", email_address: "" };

const GUIDANCE: Record<NextAction["state"], { tone: string; icon: typeof Search }> = {
  need_profile: { tone: "border-ink-700 bg-ink-950 text-mute-300", icon: Search },
  need_followers: { tone: "border-amber-500/30 bg-amber-500/10 text-amber-200", icon: Users },
  need_email: { tone: "border-amber-500/30 bg-amber-500/10 text-amber-200", icon: Mail },
  review: { tone: "border-sky-500/30 bg-sky-500/10 text-sky-200", icon: CheckCircle2 },
  approved: { tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200", icon: CheckCircle2 },
};

export function LeadForm({
  draft, onDraft, savedLeadId, onSavedLeadId, notify, onChanged, onOpenLead,
}: Props) {
  const [checks, setChecks] = useState<ValidateResult>({
    profile_url: null, follower_count: null, email_address: null,
  });
  const [duplicate, setDuplicate] = useState<DuplicateCheck | null>(null);
  const [guidance, setGuidance] = useState<NextAction>({
    state: "need_profile",
    message: "Find a streamer using the search tools, then paste the profile URL here.",
  });
  const [busy, setBusy] = useState<null | "save" | "next" | "incomplete">(null);
  const [emailSearching, setEmailSearching] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [extracted, setExtracted] = useState<ExtractResult | null>(null);
  const [scanning, setScanning] = useState(false);

  const urlRef = useRef<HTMLInputElement>(null);
  const followerRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const set = useCallback(
    (patch: Partial<LeadDraft>) => onDraft({ ...draft, ...patch }),
    [draft, onDraft],
  );

  // ---- live validation + guidance (debounced, backend is the authority) ---
  useEffect(() => {
    const timer = window.setTimeout(async () => {
      try {
        const [validation, action] = await Promise.all([api.validate(draft), api.nextAction(draft)]);
        setChecks(validation);
        setGuidance(action);
      } catch {
        /* transient - the save action reports any real problem */
      }
    }, 280);
    return () => window.clearTimeout(timer);
  }, [draft]);

  // ---- duplicate detection on the profile link ---------------------------
  useEffect(() => {
    if (!draft.profile_url.trim()) {
      setDuplicate(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.checkDuplicate(draft.profile_url, savedLeadId ?? undefined);
        setDuplicate(result);
      } catch {
        setDuplicate(null);
      }
    }, 380);
    return () => window.clearTimeout(timer);
  }, [draft.profile_url, savedLeadId]);

  const urlCheck = checks.profile_url;
  const followerCheck = checks.follower_count;
  const emailCheck = checks.email_address;
  const normalizedUrl = (urlCheck?.ok ? (urlCheck.value as string) : "") || "";
  const canOpenProfile = Boolean(normalizedUrl);
  const isDuplicate = Boolean(duplicate?.duplicate && duplicate.lead);
  const hasContent = Boolean(
    draft.profile_url.trim() || draft.follower_count.trim() || draft.email_address.trim(),
  );
  const complete = guidance.state === "review" || guidance.state === "approved";

  const openProfile = useCallback(() => {
    if (!normalizedUrl) {
      notify("warning", "Paste a valid profile link first.");
      return;
    }
    openTab(normalizedUrl);
  }, [normalizedUrl, notify]);

  // ---- saving -------------------------------------------------------------
  const persist = useCallback(async (): Promise<Lead | null> => {
    if (savedLeadId) {
      const result = await api.updateLead(savedLeadId, draft);
      if (result.demoted && result.message) notify("warning", result.message);
      return result.lead;
    }
    const result = await api.createLead(draft);
    return result.lead;
  }, [draft, savedLeadId, notify]);

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError) {
        if (error.code === "duplicate" && error.lead) {
          const existing = error.lead;
          notify("error", error.message, {
            label: "Open Existing Lead",
            onClick: () => onOpenLead(existing.id),
          });
          return;
        }
        notify("error", error.message);
        if (error.field === "profile_url") urlRef.current?.focus();
        if (error.field === "follower_count") followerRef.current?.focus();
        if (error.field === "email_address") emailRef.current?.focus();
        return;
      }
      notify("error", "The lead could not be saved. Check that the backend is still running.");
    },
    [notify, onOpenLead],
  );

  const reset = useCallback(() => {
    onDraft(EMPTY);
    onSavedLeadId(null);
    setChecks({ profile_url: null, follower_count: null, email_address: null });
    setDuplicate(null);
    setExtracted(null);
    setPasteText("");
    window.setTimeout(() => urlRef.current?.focus(), 0);
  }, [onDraft, onSavedLeadId]);

  const saveLead = useCallback(async () => {
    if (!draft.profile_url.trim()) {
      notify("warning", "Paste the streamer's profile link before saving.");
      urlRef.current?.focus();
      return;
    }
    setBusy("save");
    try {
      const lead = await persist();
      if (!lead) return;
      onSavedLeadId(lead.id);
      onChanged();
      notify(
        lead.status === "incomplete" ? "warning" : "success",
        lead.status === "incomplete"
          ? "Saved as incomplete — you can finish it later from My Leads."
          : "Lead saved and ready for your review.",
      );
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
    }
  }, [draft, persist, onSavedLeadId, onChanged, notify, handleError]);

  const saveIncomplete = useCallback(async () => {
    if (!draft.profile_url.trim()) {
      notify("warning", "A profile link is needed even for an incomplete lead.");
      urlRef.current?.focus();
      return;
    }
    setBusy("incomplete");
    try {
      const lead = await persist();
      if (!lead) return;
      onChanged();
      notify("info", "Parked for later. Find it under My Leads → Incomplete.");
      reset();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
    }
  }, [draft, persist, onChanged, notify, reset, handleError]);

  const saveAndNext = useCallback(async () => {
    if (!draft.profile_url.trim()) {
      notify("warning", "Paste the streamer's profile link first.");
      urlRef.current?.focus();
      return;
    }
    if (!complete) {
      notify("warning", `${guidance.message} Or use "Save Incomplete" to come back to it later.`);
      (guidance.state === "need_followers" ? followerRef : emailRef).current?.focus();
      return;
    }
    setBusy("next");
    try {
      const lead = await persist();
      if (!lead) return;
      onChanged();
      notify("success", "Lead saved. Ready for the next streamer.");
      reset();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
    }
  }, [draft, complete, guidance, persist, onChanged, notify, reset, handleError]);

  const clearForm = useCallback(() => {
    if (hasContent && !window.confirm("Clear the form? Anything not saved will be discarded.")) return;
    reset();
  }, [hasContent, reset]);

  // ---- keyboard shortcuts -------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key === "Enter") {
        event.preventDefault();
        void saveAndNext();
      } else if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveLead();
      } else if (event.altKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        openProfile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveAndNext, saveLead, openProfile]);

  /** Enter moves to the next field rather than submitting a half-filled form. */
  const advance = (event: React.KeyboardEvent, next: React.RefObject<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      next.current?.focus();
    }
  };

  // ---- business-email search ----------------------------------------------
  const searchBusinessEmail = async () => {
    if (!normalizedUrl) {
      notify("warning", "Paste a valid profile link first — the search is built from its username.");
      return;
    }
    setEmailSearching(true);
    try {
      const result = await api.emailSearches(normalizedUrl);
      openTab(result.searches[0].url);
      notify("info", `Google opened for "${result.identifier}". Check the results yourself and paste the correct business email.`);
    } catch (error) {
      handleError(error);
    } finally {
      setEmailSearching(false);
    }
  };

  // ---- paste-text assistant ------------------------------------------------
  const scanText = async () => {
    if (!pasteText.trim()) {
      notify("warning", "Paste some text first.");
      return;
    }
    setScanning(true);
    try {
      setExtracted(await api.extract(pasteText));
    } catch (error) {
      handleError(error);
    } finally {
      setScanning(false);
    }
  };

  const useFollowerCandidate = (raw: string) => {
    if (
      draft.follower_count.trim() &&
      draft.follower_count.trim() !== raw &&
      !window.confirm(`Replace the follower count "${draft.follower_count}" with "${raw}"?`)
    ) return;
    set({ follower_count: raw });
    notify("success", `Follower count set to ${raw}.`);
  };

  const useEmailCandidate = (email: string) => {
    if (
      draft.email_address.trim() &&
      draft.email_address.trim().toLowerCase() !== email.toLowerCase() &&
      !window.confirm(`Replace the email "${draft.email_address}" with "${email}"?`)
    ) return;
    set({ email_address: email });
    notify("success", `Email set to ${email}.`);
  };

  const Guide = GUIDANCE[guidance.state].icon;
  const busyIcon = (kind: typeof busy) =>
    busy === kind ? <Loader2 size={15} className="animate-spin" /> : null;

  const followerPreview = useMemo(() => {
    if (!followerCheck?.ok || followerCheck.value === null) return null;
    const value = Number(followerCheck.value).toLocaleString("en-US");
    return followerCheck.approximate
      ? `Stored as ≈ ${value} — an approximate figure, because you entered "${draft.follower_count.trim()}".`
      : `Stored as ${value}.`;
  }, [followerCheck, draft.follower_count]);

  return (
    <div className="flex flex-col gap-4">
      {/* Guided next step --------------------------------------------- */}
      <div
        className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${GUIDANCE[guidance.state].tone}`}
      >
        <Guide size={17} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">{guidance.message}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {guidance.state !== "need_profile" && (
              <button className="btn-secondary btn-xs" onClick={openProfile} disabled={!canOpenProfile}>
                <ExternalLink size={13} />
                Open Profile
              </button>
            )}
            {guidance.state === "need_email" && (
              <button className="btn-secondary btn-xs" onClick={searchBusinessEmail} disabled={emailSearching}>
                {emailSearching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                Search for Business Email
              </button>
            )}
            {complete && (
              <button className="btn-secondary btn-xs" onClick={saveLead} disabled={busy !== null}>
                <Check size={13} />
                Save, then approve in My Leads
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Entry form ---------------------------------------------------- */}
      <section className="panel p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">
            {savedLeadId ? `Editing saved lead #${savedLeadId}` : "New lead"}
          </h2>
          <span className="hint">Three fields — nothing else is exported.</span>
        </div>

        {/* 1. Profile link */}
        <div className="mb-5">
          <label className="label" htmlFor="profile-url">
            <Link2 size={14} /> 1 &nbsp;Profile Link
          </label>
          <div className="flex gap-2">
            <input
              id="profile-url"
              ref={urlRef}
              type="url"
              autoFocus
              spellCheck={false}
              className={`field ${urlCheck && !urlCheck.ok ? "field-error" : ""} ${
                urlCheck?.ok && !isDuplicate ? "field-ok" : ""
              }`}
              placeholder="https://www.whatnot.com/user/…"
              value={draft.profile_url}
              onChange={(event) => set({ profile_url: event.target.value })}
              onKeyDown={(event) => advance(event, followerRef)}
            />
            <button className="btn-secondary shrink-0" onClick={openProfile} disabled={!canOpenProfile} title="Open profile (Alt+O)">
              <ExternalLink size={15} />
            </button>
            <button
              className="btn-secondary shrink-0"
              disabled={!normalizedUrl}
              title="Copy profile link"
              onClick={async () => {
                const ok = await copyText(normalizedUrl);
                notify(ok ? "success" : "error", ok ? "Profile link copied." : "Could not copy the link.");
              }}
            >
              <Copy size={15} />
            </button>
          </div>

          {urlCheck && !urlCheck.ok && (
            <p className="mt-1.5 text-xs text-rose-300">{urlCheck.message}</p>
          )}
          {urlCheck?.ok && normalizedUrl !== draft.profile_url.trim() && (
            <p className="mt-1.5 text-xs text-mute-400">
              Will be saved as <span className="font-mono text-accent-300">{normalizedUrl}</span>
            </p>
          )}
          {urlCheck?.hints?.map((hint) => (
            <p key={hint} className="mt-1.5 text-xs text-amber-300/90">{hint}</p>
          ))}

          {isDuplicate && duplicate?.lead && (
            <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-300" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-rose-200">This profile is already in your leads.</p>
                <button
                  className="mt-1.5 rounded-md bg-white/10 px-2 py-1 text-[11px] font-semibold text-rose-100 hover:bg-white/20"
                  onClick={() => onOpenLead(duplicate.lead!.id)}
                >
                  Open Existing Lead
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 2. Follower count */}
        <div className="mb-5">
          <label className="label" htmlFor="follower-count">
            <Users size={14} /> 2 &nbsp;Follower Count
          </label>
          <input
            id="follower-count"
            ref={followerRef}
            type="text"
            inputMode="text"
            className={`field ${followerCheck && !followerCheck.ok ? "field-error" : ""} ${
              followerCheck?.ok ? "field-ok" : ""
            }`}
            placeholder="1250   ·   1,250   ·   1.2K"
            value={draft.follower_count}
            onChange={(event) => set({ follower_count: event.target.value })}
            onKeyDown={(event) => advance(event, emailRef)}
          />
          {followerCheck && !followerCheck.ok && (
            <p className="mt-1.5 text-xs text-rose-300">{followerCheck.message}</p>
          )}
          {followerPreview && <p className="mt-1.5 text-xs text-mute-400">{followerPreview}</p>}
          {!draft.follower_count.trim() && (
            <p className="hint mt-1.5">
              Please check the follower count manually — read it from the profile, not the viewer
              count or feedback score.
            </p>
          )}
        </div>

        {/* 3. Email address */}
        <div className="mb-5">
          <label className="label" htmlFor="email-address">
            <Mail size={14} /> 3 &nbsp;Email Address
          </label>
          <div className="flex gap-2">
            <input
              id="email-address"
              ref={emailRef}
              type="email"
              spellCheck={false}
              className={`field ${emailCheck && !emailCheck.ok ? "field-error" : ""} ${
                emailCheck?.ok ? "field-ok" : ""
              }`}
              placeholder="contact@theirbusiness.com"
              value={draft.email_address}
              onChange={(event) => set({ email_address: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
                  event.preventDefault();
                  void saveAndNext();
                }
              }}
            />
            <button
              className="btn-secondary shrink-0 whitespace-nowrap"
              onClick={searchBusinessEmail}
              disabled={emailSearching || !normalizedUrl}
              title="Open a Google search built from this profile's username"
            >
              {emailSearching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
              <span className="hidden lg:inline">Find email</span>
            </button>
          </div>
          {emailCheck && !emailCheck.ok && (
            <p className="mt-1.5 text-xs text-rose-300">{emailCheck.message}</p>
          )}
          {emailCheck?.ok && (
            <p className="mt-1.5 text-xs text-mute-400">
              Format looks valid. That is not a guarantee of delivery or of ownership — confirm it
              belongs to this business.
            </p>
          )}
          {!draft.email_address.trim() && (
            <p className="hint mt-1.5">
              Please find a publicly listed business email, or leave this lead incomplete.
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-4">
          <button className="btn-primary" onClick={saveAndNext} disabled={busy !== null}>
            {busyIcon("next") ?? <ArrowRight size={15} />}
            Save &amp; Next
          </button>
          <button className="btn-secondary" onClick={saveLead} disabled={busy !== null}>
            {busyIcon("save") ?? <Save size={15} />}
            Save Lead
          </button>
          <button className="btn-secondary" onClick={saveIncomplete} disabled={busy !== null}>
            {busyIcon("incomplete") ?? <PauseCircle size={15} />}
            Save Incomplete
          </button>
          <button className="btn-ghost ml-auto" onClick={clearForm} disabled={busy !== null}>
            <Eraser size={15} />
            Clear Form
          </button>
        </div>

        <p className="hint mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <CornerDownLeft size={12} /> Enter moves to the next field
          </span>
          <span><kbd className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px]">Ctrl</kbd>+<kbd className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px]">Enter</kbd> Save &amp; Next</span>
          <span><kbd className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px]">Ctrl</kbd>+<kbd className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px]">S</kbd> Save</span>
          <span><kbd className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px]">Alt</kbd>+<kbd className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px]">O</kbd> Open profile</span>
        </p>
      </section>

      {/* Paste research text ------------------------------------------- */}
      <section className="panel overflow-hidden">
        <button
          className="flex w-full items-center gap-2.5 px-5 py-3.5 text-left hover:bg-ink-850"
          onClick={() => setPasteOpen((open) => !open)}
          aria-expanded={pasteOpen}
        >
          <ClipboardPaste size={15} className="text-accent-400" />
          <span className="text-sm font-semibold text-slate-100">Paste Research Text</span>
          <span className="hint ml-auto hidden sm:inline">optional · finds labelled values only</span>
        </button>

        {pasteOpen && (
          <div className="border-t border-ink-800 p-5 pt-4">
            <textarea
              className="field min-h-28 resize-y font-mono text-[13px]"
              placeholder="Paste a short excerpt you are allowed to use — for example a profile line showing “12.5K followers”, or a contact page showing a business email."
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
            />
            <div className="mt-2.5 flex gap-2">
              <button className="btn-secondary" onClick={scanText} disabled={scanning}>
                {scanning ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
                Scan Text
              </button>
              {(pasteText || extracted) && (
                <button
                  className="btn-ghost"
                  onClick={() => { setPasteText(""); setExtracted(null); }}
                >
                  <Eraser size={15} /> Clear
                </button>
              )}
            </div>

            {extracted && (
              <div className="mt-4 space-y-3">
                {extracted.follower_candidates.map((candidate) => (
                  <div key={candidate.raw} className="rounded-lg border border-ink-700 bg-ink-950 p-3">
                    <p className="text-sm text-slate-200">
                      Possible follower count:{" "}
                      <strong className="text-accent-300">
                        {candidate.value.toLocaleString("en-US")}
                      </strong>
                      {candidate.approximate && (
                        <span className="text-mute-400"> (approximate — written as “{candidate.raw}”)</span>
                      )}
                    </p>
                    <p className="hint mt-1 line-clamp-2 font-mono">…{candidate.context}…</p>
                    <button
                      className="btn-secondary btn-xs mt-2"
                      onClick={() => useFollowerCandidate(candidate.raw)}
                    >
                      <Check size={13} /> Use This Follower Count
                    </button>
                  </div>
                ))}

                {extracted.email_candidates.map((candidate) => (
                  <div key={candidate.email} className="rounded-lg border border-ink-700 bg-ink-950 p-3">
                    <p className="text-sm text-slate-200">
                      Possible email: <strong className="text-accent-300">{candidate.email}</strong>
                    </p>
                    <p className="hint mt-1 line-clamp-2 font-mono">…{candidate.context}…</p>
                    <button
                      className="btn-secondary btn-xs mt-2"
                      onClick={() => useEmailCandidate(candidate.email)}
                    >
                      <Check size={13} /> Use This Email
                    </button>
                  </div>
                ))}

                {extracted.notes.map((note) => (
                  <p key={note} className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    {note}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
