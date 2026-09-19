import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2, ExternalLink, Loader2, Pencil, RotateCcw, Search, Trash2, X,
} from "lucide-react";
import { api, ApiError } from "../api";
import { formatDate, formatFollowers, NOT_ENTERED, openTab, shortUrl, STATUS_META } from "../lib/format";
import type { Lead, LeadDraft, LeadStatus } from "../types";
import type { ToastKind } from "./Toast";

interface Props {
  notify: (kind: ToastKind, message: string) => void;
  onChanged: () => void;
  focusId: number | null;
  onFocusHandled: () => void;
  refreshKey: number;
}

type Filter = "all" | LeadStatus;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "incomplete", label: "Incomplete" },
  { id: "ready", label: "Ready for review" },
  { id: "approved", label: "Approved" },
];

export function LeadsTable({ notify, onChanged, focusId, onFocusHandled, refreshKey }: Props) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<LeadDraft>({
    profile_url: "", follower_count: "", email_address: "",
  });
  const [savingId, setSavingId] = useState<number | null>(null);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLeads(await api.listLeads({ q: query, status: filter }));
    } catch (error) {
      notify("error", error instanceof ApiError ? error.message : "Could not load your leads.");
    } finally {
      setLoading(false);
    }
  }, [query, filter, notify]);

  useEffect(() => {
    const timer = window.setTimeout(load, query ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query, refreshKey]);

  // Arriving from a duplicate alert: reveal that lead and open it for editing.
  useEffect(() => {
    if (focusId === null || loading) return;
    const lead = leads.find((item) => item.id === focusId);
    if (!lead) return;
    startEdit(lead);
    rowRefs.current.get(focusId)?.scrollIntoView({ block: "center", behavior: "smooth" });
    onFocusHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, loading, leads]);

  const startEdit = (lead: Lead) => {
    setEditingId(lead.id);
    setEditDraft({
      profile_url: lead.profile_url,
      follower_count: lead.follower_raw || (lead.follower_count?.toString() ?? ""),
      email_address: lead.email_address ?? "",
    });
  };

  const saveEdit = async (id: number) => {
    setSavingId(id);
    try {
      const result = await api.updateLead(id, editDraft);
      setLeads((current) => current.map((lead) => (lead.id === id ? result.lead : lead)));
      setEditingId(null);
      onChanged();
      notify(result.demoted ? "warning" : "success", result.message ?? "Lead updated.");
      if (filter !== "all") void load();
    } catch (error) {
      notify("error", error instanceof ApiError ? error.message : "The lead could not be updated.");
    } finally {
      setSavingId(null);
    }
  };

  const approve = async (lead: Lead) => {
    try {
      const updated = await api.approve(lead.id);
      setLeads((current) => current.map((item) => (item.id === lead.id ? updated : item)));
      onChanged();
      notify("success", "Approved — it will be included in the export.");
      if (filter !== "all") void load();
    } catch (error) {
      notify("error", error instanceof ApiError ? error.message : "The lead could not be approved.");
    }
  };

  const unapprove = async (lead: Lead) => {
    try {
      const updated = await api.unapprove(lead.id);
      setLeads((current) => current.map((item) => (item.id === lead.id ? updated : item)));
      onChanged();
      notify("info", "Returned to Ready for review — it will not be exported.");
      if (filter !== "all") void load();
    } catch (error) {
      notify("error", error instanceof ApiError ? error.message : "The lead could not be changed.");
    }
  };

  const remove = async (lead: Lead) => {
    if (!window.confirm(`Delete this lead permanently?\n\n${lead.profile_url}`)) return;
    try {
      await api.deleteLead(lead.id);
      setLeads((current) => current.filter((item) => item.id !== lead.id));
      setSelected((current) => {
        const next = new Set(current);
        next.delete(lead.id);
        return next;
      });
      onChanged();
      notify("success", "Lead deleted.");
    } catch (error) {
      notify("error", error instanceof ApiError ? error.message : "The lead could not be deleted.");
    }
  };

  const removeSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} selected lead${ids.length > 1 ? "s" : ""} permanently?`)) return;
    try {
      const result = await api.bulkDelete(ids);
      setSelected(new Set());
      onChanged();
      await load();
      notify("success", `${result.deleted} lead${result.deleted === 1 ? "" : "s"} deleted.`);
    } catch (error) {
      notify("error", error instanceof ApiError ? error.message : "The leads could not be deleted.");
    }
  };

  const toggle = (id: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = leads.length > 0 && selected.size === leads.length;

  return (
    <div className="flex flex-col gap-4">
      {/* Controls ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mute-400" />
          <input
            className="field pl-9"
            placeholder="Search profile links, emails or follower counts…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex gap-1 rounded-lg bg-ink-950 p-1">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              onClick={() => setFilter(item.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                filter === item.id
                  ? "bg-ink-800 text-slate-100"
                  : "text-mute-400 hover:bg-ink-850 hover:text-slate-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {selected.size > 0 && (
          <button className="btn-danger" onClick={removeSelected}>
            <Trash2 size={15} />
            Delete {selected.size} selected
          </button>
        )}
      </div>

      {/* Table --------------------------------------------------------- */}
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] text-sm">
            <thead>
              <tr className="border-b border-ink-800 bg-ink-850/60 text-left text-[11px] uppercase tracking-wide text-mute-400">
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-accent-500"
                    aria-label="Select all leads"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(leads.map((lead) => lead.id)))
                    }
                  />
                </th>
                <th className="px-3 py-2.5 font-semibold">Profile Link</th>
                <th className="w-36 px-3 py-2.5 font-semibold">Follower Count</th>
                <th className="px-3 py-2.5 font-semibold">Email Address</th>
                <th className="w-40 px-3 py-2.5 font-semibold">Status</th>
                <th className="w-60 px-3 py-2.5 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="px-3 py-14 text-center text-mute-400">
                    <Loader2 size={18} className="mx-auto mb-2 animate-spin" />
                    Loading your leads…
                  </td>
                </tr>
              )}

              {!loading && leads.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-14 text-center">
                    <p className="text-slate-300">No leads here yet.</p>
                    <p className="hint mt-1">
                      {query || filter !== "all"
                        ? "Try a different search or filter."
                        : "Head to Research to collect your first streamer."}
                    </p>
                  </td>
                </tr>
              )}

              {!loading &&
                leads.map((lead) => {
                  const editing = editingId === lead.id;
                  const meta = STATUS_META[lead.status];
                  return (
                    <tr
                      key={lead.id}
                      ref={(node) => {
                        if (node) rowRefs.current.set(lead.id, node);
                        else rowRefs.current.delete(lead.id);
                      }}
                      className={`border-b border-ink-800/70 align-top transition last:border-0 ${
                        editing ? "bg-accent-500/5" : "hover:bg-ink-850/50"
                      }`}
                    >
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-accent-500"
                          aria-label={`Select ${lead.profile_url}`}
                          checked={selected.has(lead.id)}
                          onChange={() => toggle(lead.id)}
                        />
                      </td>

                      {/* Profile link */}
                      <td className="max-w-0 px-3 py-3">
                        {editing ? (
                          <input
                            className="field py-1.5 text-[13px]"
                            value={editDraft.profile_url}
                            onChange={(event) =>
                              setEditDraft({ ...editDraft, profile_url: event.target.value })
                            }
                          />
                        ) : (
                          <button
                            className="block max-w-full truncate text-left font-mono text-[13px] text-accent-300 hover:text-accent-200 hover:underline"
                            title={lead.profile_url}
                            onClick={() => openTab(lead.profile_url)}
                          >
                            {shortUrl(lead.profile_url)}
                          </button>
                        )}
                        <p className="hint mt-1 text-[11px]">#{lead.id} · {formatDate(lead.updated_at)}</p>
                      </td>

                      {/* Followers */}
                      <td className="px-3 py-3">
                        {editing ? (
                          <input
                            className="field py-1.5 text-[13px]"
                            placeholder="1250 or 1.2K"
                            value={editDraft.follower_count}
                            onChange={(event) =>
                              setEditDraft({ ...editDraft, follower_count: event.target.value })
                            }
                          />
                        ) : lead.follower_count === null ? (
                          <span className="text-amber-400/80">{NOT_ENTERED}</span>
                        ) : (
                          <span
                            className="tabular-nums text-slate-200"
                            title={
                              lead.follower_approximate
                                ? `Approximate — entered as "${lead.follower_raw}"`
                                : undefined
                            }
                          >
                            {formatFollowers(lead)}
                          </span>
                        )}
                      </td>

                      {/* Email */}
                      <td className="max-w-0 px-3 py-3">
                        {editing ? (
                          <input
                            className="field py-1.5 text-[13px]"
                            placeholder="contact@business.com"
                            value={editDraft.email_address}
                            onChange={(event) =>
                              setEditDraft({ ...editDraft, email_address: event.target.value })
                            }
                          />
                        ) : lead.email_address ? (
                          <span className="block truncate text-slate-200" title={lead.email_address}>
                            {lead.email_address}
                          </span>
                        ) : (
                          <span className="text-amber-400/80">{NOT_ENTERED}</span>
                        )}
                      </td>

                      <td className="px-3 py-3">
                        <span className={`chip ${meta.className}`}>{meta.label}</span>
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-3">
                        <div className="flex flex-nowrap items-center justify-end gap-1">
                          {editing ? (
                            <>
                              <button
                                className="btn-primary btn-xs"
                                onClick={() => saveEdit(lead.id)}
                                disabled={savingId === lead.id}
                              >
                                {savingId === lead.id ? (
                                  <Loader2 size={13} className="animate-spin" />
                                ) : (
                                  <CheckCircle2 size={13} />
                                )}
                                Save
                              </button>
                              <button className="btn-ghost btn-xs" onClick={() => setEditingId(null)}>
                                <X size={13} /> Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="btn-ghost btn-xs"
                                onClick={() => openTab(lead.profile_url)}
                                title="Open profile"
                              >
                                <ExternalLink size={13} />
                              </button>
                              <button
                                className="btn-ghost btn-xs"
                                onClick={() => startEdit(lead)}
                                title="Edit lead"
                              >
                                <Pencil size={13} />
                              </button>
                              {lead.status === "approved" ? (
                                <button
                                  className="btn-ghost btn-xs"
                                  onClick={() => unapprove(lead)}
                                  title="Return to review"
                                >
                                  <RotateCcw size={13} />
                                </button>
                              ) : (
                                <button
                                  className="btn-secondary btn-xs"
                                  onClick={() => approve(lead)}
                                  disabled={lead.status === "incomplete"}
                                  title={
                                    lead.status === "incomplete"
                                      ? "Fill all three fields before approving"
                                      : "Approve this lead"
                                  }
                                >
                                  <CheckCircle2 size={13} /> Approve
                                </button>
                              )}
                              <button
                                className="btn-ghost btn-xs text-rose-300 hover:bg-rose-500/10"
                                onClick={() => remove(lead)}
                                title="Delete lead"
                              >
                                <Trash2 size={13} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="hint">
        Approval is per lead and deliberate — there is no bulk approve, because every record should
        pass your own eyes before it reaches the client.
      </p>
    </div>
  );
}
