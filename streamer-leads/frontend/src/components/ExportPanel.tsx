import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, CheckCircle2, Download, Eye, FileSpreadsheet, Loader2, PauseCircle,
} from "lucide-react";
import { api, ApiError } from "../api";
import type { ExportPreview } from "../types";
import type { ToastKind } from "./Toast";

interface Props {
  notify: (kind: ToastKind, message: string) => void;
  refreshKey: number;
}

const STEPS = [
  "Select Download CSV — the file is saved to your Downloads folder.",
  "Open Google Sheets and create a blank spreadsheet.",
  "Choose File → Import → Upload, and select the downloaded file.",
  'Under "Import location" pick Replace spreadsheet, then Import data.',
];

function Tile({
  value, label, icon: Icon, tone,
}: { value: number; label: string; icon: typeof Eye; tone: string }) {
  return (
    <div className="panel flex items-center gap-3.5 p-4">
      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${tone}`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-semibold tabular-nums leading-none text-slate-100">{value}</p>
        <p className="hint mt-1">{label}</p>
      </div>
    </div>
  );
}

export function ExportPanel({ notify, refreshKey }: Props) {
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRows, setShowRows] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPreview(await api.exportPreview());
    } catch (error) {
      notify("error", error instanceof ApiError ? error.message : "Could not read the export.");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const download = () => {
    if (!preview || preview.counts.approved === 0) {
      notify("warning", "There are no approved leads to export yet. Approve leads under My Leads first.");
      return;
    }
    // A plain browser download of the file the backend generates.
    const anchor = document.createElement("a");
    anchor.href = "/api/export/csv";
    anchor.download = preview.filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    notify("success", `${preview.counts.approved} approved lead${preview.counts.approved === 1 ? "" : "s"} exported as ${preview.filename}.`);
  };

  const counts = preview?.counts;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile
          value={counts?.approved ?? 0}
          label="Approved — these are exported"
          icon={CheckCircle2}
          tone="bg-emerald-500/15 text-emerald-300"
        />
        <Tile
          value={counts?.ready ?? 0}
          label="Awaiting your review"
          icon={Eye}
          tone="bg-sky-500/15 text-sky-300"
        />
        <Tile
          value={counts?.incomplete ?? 0}
          label="Incomplete — excluded"
          icon={PauseCircle}
          tone="bg-amber-500/15 text-amber-300"
        />
      </div>

      <section className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <FileSpreadsheet size={16} className="text-accent-400" />
              Client spreadsheet
            </h2>
            <p className="hint mt-1.5 max-w-xl">
              Exactly three columns — <strong className="text-slate-300">Profile Link</strong>,{" "}
              <strong className="text-slate-300">Follower Count</strong>,{" "}
              <strong className="text-slate-300">Email Address</strong>. Approved leads only; no
              statuses, dates or internal identifiers are included.
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => setShowRows((open) => !open)} disabled={loading}>
              <Eye size={15} />
              {showRows ? "Hide Preview" : "Preview Export"}
            </button>
            <button className="btn-primary" onClick={download} disabled={loading || !counts?.approved}>
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
              Download CSV
            </button>
          </div>
        </div>

        {preview && preview.approximate_follower_rows > 0 && (
          <p className="mt-4 flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {preview.approximate_follower_rows} of these rows hold an approximate follower count,
              because the profile displayed a rounded figure such as “1.2K”. The exported number is
              that rounded figure converted to digits, not an exact count.
            </span>
          </p>
        )}

        {showRows && preview && (
          <div className="mt-4 overflow-hidden rounded-lg border border-ink-700">
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-ink-850">
                  {/* Shown exactly as written to the file - no case transform. */}
                  <tr className="text-left font-mono text-[12px] text-mute-300">
                    {preview.headers.map((header) => (
                      <th key={header} className="border-b border-ink-700 px-3 py-2 font-semibold">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {preview.rows.map((row, index) => (
                    <tr key={`${row[0]}-${index}`} className="border-b border-ink-800/70 last:border-0">
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="px-3 py-2 text-slate-300">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {preview.rows.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-3 py-10 text-center font-sans text-mute-400">
                        Nothing approved yet, so the file would contain only the header row.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="hint border-t border-ink-700 bg-ink-950 px-3 py-2">
              These are the exact rows that will be written to{" "}
              <span className="font-mono text-slate-300">{preview.filename}</span>.
            </p>
          </div>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-slate-100">Importing into Google Sheets</h2>
        <ol className="mt-3 space-y-2">
          {STEPS.map((step, index) => (
            <li key={step} className="flex gap-3 text-sm text-slate-300">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink-800 text-[11px] font-semibold text-mute-300">
                {index + 1}
              </span>
              <span className="leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>
        <p className="hint mt-3.5">
          The file is written on your machine and nothing is uploaded anywhere. This application has
          no access to your Google account.
        </p>
      </section>
    </div>
  );
}
