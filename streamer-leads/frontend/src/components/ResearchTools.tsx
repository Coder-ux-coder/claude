import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft, ChevronRight, Copy, ExternalLink, Info, ListChecks, RefreshCw, Sparkles,
} from "lucide-react";
import { api, ApiError } from "../api";
import { copyText, openTab } from "../lib/format";
import type { PlatformId, SearchItem, SearchPayload, Topic } from "../types";
import type { ToastKind } from "./Toast";

interface Props {
  platform: PlatformId;
  topic: string;
  onPlatform: (platform: PlatformId) => void;
  onTopic: (topic: string) => void;
  notify: (kind: ToastKind, message: string) => void;
}

const PLATFORM_TABS: { id: PlatformId; label: string }[] = [
  { id: "whatnot", label: "Whatnot" },
  { id: "ebay_live", label: "eBay Live" },
];

const CHECKLIST = [
  "Confirm the profile actually belongs to a livestream seller.",
  "Read the follower count from the profile itself — not viewers or feedback.",
  "Use only a publicly listed business email.",
  "A search result is not proof that someone streams. Open the profile.",
];

export function ResearchTools({ platform, topic, onPlatform, onTopic, notify }: Props) {
  const [payload, setPayload] = useState<SearchPayload | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [searches, setSearches] = useState<SearchItem[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);

  // Topic list is fetched once; search variations are generated on demand.
  useEffect(() => {
    api
      .searches(platform, topic)
      .then((data) => {
        setPayload(data);
        setTopics(data.topics);
      })
      .catch((error: ApiError) => notify("error", error.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.searches(platform, topic);
      setPayload(data);
      setTopics(data.topics);
      setSearches(data.searches);
      setIndex(0);
      notify("success", `${data.searches.length} search variations ready.`);
    } catch (error) {
      notify("error", error instanceof ApiError ? error.message : "Could not build the searches.");
    } finally {
      setLoading(false);
    }
  }, [platform, topic, notify]);

  // Clear stale results when the operator changes platform or category.
  useEffect(() => {
    setSearches([]);
    setIndex(0);
  }, [platform, topic]);

  const current = searches[index];

  const openCurrent = () => {
    if (!current) return;
    openTab(current.url);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Platform ------------------------------------------------------ */}
      <section className="panel p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Sparkles size={15} className="text-accent-400" />
          Research tools
        </h2>

        <div className="mb-3 flex gap-1 rounded-lg bg-ink-950 p-1">
          {PLATFORM_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onPlatform(tab.id)}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${
                platform === tab.id
                  ? "bg-accent-500 text-white shadow-sm shadow-accent-500/25"
                  : "text-mute-400 hover:bg-ink-850 hover:text-slate-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <button
          className="btn-secondary w-full"
          onClick={() => payload && openTab(payload.platform.home_url)}
          disabled={!payload}
        >
          <ExternalLink size={15} />
          {payload?.platform.home_label ?? "Open platform"}
        </button>
        <p className="hint mt-2">
          Opens {payload?.platform.home_url ?? "the platform"} in a new tab. Browsing and judging the
          streams stays with you — nothing is read automatically.
        </p>
      </section>

      {/* Search generator ---------------------------------------------- */}
      <section className="panel p-4">
        <label className="label" htmlFor="topic-select">
          Search category
        </label>
        <select
          id="topic-select"
          className="field mb-3"
          value={topic}
          onChange={(event) => onTopic(event.target.value)}
        >
          {(topics.length ? topics : [{ id: "all", label: "All categories", term: "" }]).map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>

        <button className="btn-primary w-full" onClick={generate} disabled={loading}>
          {loading ? <RefreshCw size={15} className="animate-spin" /> : <Sparkles size={15} />}
          Generate Searches
        </button>

        {searches.length > 0 && current && (
          <div className="mt-4 rounded-lg border border-ink-700 bg-ink-950 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-mute-400">
                Search {index + 1} of {searches.length}
              </span>
              <div className="flex gap-1">
                <button
                  className="btn-ghost btn-xs"
                  onClick={() => setIndex((i) => Math.max(0, i - 1))}
                  disabled={index === 0}
                  title="Previous search"
                >
                  <ChevronLeft size={14} />
                  Prev
                </button>
                <button
                  className="btn-ghost btn-xs"
                  onClick={() => setIndex((i) => Math.min(searches.length - 1, i + 1))}
                  disabled={index >= searches.length - 1}
                  title="Next search"
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>

            <p className="break-words rounded-md bg-ink-900 p-2.5 font-mono text-[12.5px] leading-relaxed text-accent-200">
              {current.query}
            </p>
            <p className="hint mt-2">{current.note}</p>

            <div className="mt-3 flex gap-2">
              <button className="btn-primary flex-1" onClick={openCurrent}>
                <ExternalLink size={15} />
                Open Search
              </button>
              <button
                className="btn-secondary"
                onClick={async () => {
                  const ok = await copyText(current.query);
                  notify(ok ? "success" : "error", ok ? "Search query copied." : "Could not copy the query.");
                }}
                title="Copy search query"
              >
                <Copy size={15} />
              </button>
            </div>
          </div>
        )}

        {searches.length === 0 && (
          <p className="hint mt-3 flex gap-2 rounded-lg bg-ink-950 p-3">
            <Info size={14} className="mt-0.5 shrink-0 text-mute-400" />
            <span>
              Pick a category and select <strong className="text-slate-300">Generate Searches</strong>.
              Each result opens an ordinary Google search in your browser; results are never fetched or
              read by this application.
            </span>
          </p>
        )}
      </section>

      {/* Reminders ------------------------------------------------------ */}
      <section className="panel p-4">
        <h3 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-slate-100">
          <ListChecks size={15} className="text-accent-400" />
          What only you can judge
        </h3>
        <ul className="space-y-2">
          {CHECKLIST.map((item) => (
            <li key={item} className="hint flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-mute-400" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
