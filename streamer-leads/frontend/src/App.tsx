import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { LeadForm } from "./components/LeadForm";
import { LeadsTable } from "./components/LeadsTable";
import { ExportPanel } from "./components/ExportPanel";
import { ResearchTools } from "./components/ResearchTools";
import { Toaster, useToasts } from "./components/Toast";
import { TopBar, type View } from "./components/TopBar";
import type { LeadDraft, PlatformId, Stats } from "./types";

const STORAGE = {
  draft: "slw.draft",
  savedLeadId: "slw.savedLeadId",
  platform: "slw.platform",
  topic: "slw.topic",
  view: "slw.view",
} as const;

const EMPTY_DRAFT: LeadDraft = { profile_url: "", follower_count: "", email_address: "" };

/** Small localStorage-backed state so a browser refresh never loses the session. */
function usePersisted<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? fallback : (JSON.parse(stored) as T);
    } catch {
      return fallback;
    }
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* private browsing or a full quota - the app still works in memory */
      }
    },
    [key],
  );

  return [value, update];
}

export default function App() {
  const { toasts, push, dismiss } = useToasts();
  const [view, setView] = usePersisted<View>(STORAGE.view, "research");
  const [draft, setDraft] = usePersisted<LeadDraft>(STORAGE.draft, EMPTY_DRAFT);
  const [savedLeadId, setSavedLeadId] = usePersisted<number | null>(STORAGE.savedLeadId, null);
  const [platform, setPlatform] = usePersisted<PlatformId>(STORAGE.platform, "whatnot");
  const [topic, setTopic] = usePersisted<string>(STORAGE.topic, "all");
  const [stats, setStats] = useState<Stats | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await api.stats());
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats, refreshKey]);

  const changed = useCallback(() => setRefreshKey((key) => key + 1), []);

  const openLead = useCallback(
    (id: number) => {
      setFocusId(id);
      setView("leads");
    },
    [setView],
  );

  return (
    <div className="min-h-screen bg-ink-950">
      <TopBar view={view} onView={setView} stats={stats} onExport={() => setView("export")} />

      {offline && (
        <div className="border-b border-rose-500/25 bg-rose-500/10 px-4 py-2.5 text-center text-sm text-rose-200">
          The backend is not responding. Check that the API window is still running on
          <span className="font-mono"> http://127.0.0.1:8000</span>.
        </div>
      )}

      <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
        {view === "research" && (
          <div className="grid gap-5 lg:grid-cols-[minmax(20rem,26rem)_1fr]">
            <ResearchTools
              platform={platform}
              topic={topic}
              onPlatform={setPlatform}
              onTopic={setTopic}
              notify={push}
            />
            <LeadForm
              draft={draft}
              onDraft={setDraft}
              savedLeadId={savedLeadId}
              onSavedLeadId={setSavedLeadId}
              notify={push}
              onChanged={changed}
              onOpenLead={openLead}
            />
          </div>
        )}

        {view === "leads" && (
          <LeadsTable
            notify={push}
            onChanged={changed}
            focusId={focusId}
            onFocusHandled={() => setFocusId(null)}
            refreshKey={refreshKey}
          />
        )}

        {view === "export" && <ExportPanel notify={push} refreshKey={refreshKey} />}
      </main>

      <Toaster toasts={toasts} dismiss={dismiss} />
    </div>
  );
}
