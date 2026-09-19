import { Download, FileSpreadsheet, Radio, Search, Table2 } from "lucide-react";
import type { Stats } from "../types";

export type View = "research" | "leads" | "export";

const TABS: { id: View; label: string; icon: typeof Search }[] = [
  { id: "research", label: "Research", icon: Search },
  { id: "leads", label: "My Leads", icon: Table2 },
  { id: "export", label: "Export", icon: FileSpreadsheet },
];

interface Props {
  view: View;
  onView: (view: View) => void;
  stats: Stats | null;
  onExport: () => void;
}

function Counter({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-base font-semibold tabular-nums ${tone}`}>{value}</span>
      <span className="text-xs text-mute-400">{label}</span>
    </div>
  );
}

export function TopBar({ view, onView, stats, onExport }: Props) {
  return (
    <header className="sticky top-0 z-30 border-b border-ink-800 bg-ink-900/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent-500/15 text-accent-400 ring-1 ring-accent-500/25">
            <Radio size={17} />
          </div>
          <div className="leading-tight">
            <h1 className="text-[15px] font-semibold text-slate-100">Streamer Lead Workspace</h1>
            <p className="hidden text-[11px] text-mute-400 sm:block">
              Whatnot &amp; eBay Live &middot; local research tool
            </p>
          </div>
        </div>

        <nav className="ml-2 flex items-center gap-1 rounded-lg bg-ink-950/70 p-1">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = view === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => onView(tab.id)}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  active
                    ? "bg-ink-800 text-slate-100 shadow-sm"
                    : "text-mute-400 hover:text-slate-200 hover:bg-ink-850"
                }`}
              >
                <Icon size={15} />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-5">
          <div className="hidden items-center gap-5 md:flex">
            <Counter value={stats?.total ?? 0} label="saved" tone="text-slate-100" />
            <Counter value={stats?.complete ?? 0} label="complete" tone="text-sky-300" />
            <Counter value={stats?.approved ?? 0} label="approved" tone="text-emerald-300" />
          </div>
          <button className="btn-primary" onClick={onExport}>
            <Download size={15} />
            Export
          </button>
        </div>
      </div>
    </header>
  );
}
