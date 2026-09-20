import React, { useState } from 'react'
import { useStore } from '../../state/store'
import { api } from '../../services/api'
import { Icon, StatusDot, Bar, Empty, Spinner } from '../../components/ui'

function ago(ts: number | null) {
  if (!ts) return '—'
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function JobsPanel() {
  const jobs = useStore((s) => s.jobs)
  const refreshJobs = useStore((s) => s.refreshJobs)
  const setError = useStore((s) => s.setError)
  const [open, setOpen] = useState<string | null>(null)

  if (!jobs.length) {
    return <Empty icon="layers" title="No jobs yet"
                  hint="Applying changes queues a job. Blender always runs in a separate process, never inside a web request." />
  }

  return (
    <div className="h-full overflow-y-auto text-2xs">
      {jobs.map((j) => {
        const active = j.status === 'running' || j.status === 'claimed'
        const dur = j.finished_at && j.started_at
          ? `${(j.finished_at - j.started_at).toFixed(1)}s`
          : active && j.started_at
            ? `${(Date.now() / 1000 - j.started_at).toFixed(0)}s` : ''
        return (
          <div key={j.id} className="border-b border-ink-800">
            <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-ink-800/50
                            cursor-pointer transition-colors"
                 onClick={() => setOpen(open === j.id ? null : j.id)}>
              <StatusDot status={j.status} />
              <span className="font-mono text-mute-500 w-32 truncate">{j.id.slice(4, 16)}</span>
              <span className="text-mute-400 w-24 truncate">{j.type}</span>
              <span className={`w-28 truncate font-medium ${
                j.status === 'failed' ? 'text-rose-400'
                : j.status === 'completed' ? 'text-jade-400'
                : active ? 'text-marigold-300' : 'text-mute-500'}`}>{j.stage}</span>
              <span className="flex-1 truncate text-mute-500">{j.message}</span>
              <span className="text-mute-500 w-16 text-right">{dur}</span>
              <span className="text-mute-500 w-16 text-right">{ago(j.created_at)}</span>
              {active && (
                <button className="btn-danger px-1.5 h-5"
                        onClick={(e) => { e.stopPropagation()
                          api.cancelJob(j.id).then(refreshJobs).catch((x) => setError(x.message)) }}>
                  <Icon name="stop" className="w-3 h-3" />
                </button>
              )}
              {(j.status === 'failed' || j.status === 'cancelled') && (
                <button className="btn-sub px-1.5 h-5"
                        onClick={(e) => { e.stopPropagation()
                          api.retryJob(j.id).then(refreshJobs).catch((x) => setError(x.message)) }}>
                  <Icon name="refresh" className="w-3 h-3" />
                </button>
              )}
            </div>

            {active && j.progress_total > 0 && (
              <div className="px-3 pb-1.5">
                <Bar value={j.progress_index} total={j.progress_total} />
                <div className="text-mute-500 mt-0.5">
                  {j.progress_index} / {j.progress_total}
                </div>
              </div>
            )}

            {open === j.id && (
              <div className="px-3 pb-2 space-y-1.5 animate-fade-in">
                {j.error && (
                  <pre className="p-2 rounded bg-rose-500/10 border border-rose-500/25
                                  text-rose-400 whitespace-pre-wrap font-mono
                                  max-h-40 overflow-y-auto">{j.error}</pre>
                )}
                {!!Object.keys(j.outputs || {}).length && (
                  <div className="flex flex-wrap gap-1">
                    {Object.keys(j.outputs).map((k) => (
                      <span key={k} className="chip">{k}</span>
                    ))}
                  </div>
                )}
                <JobLogs id={j.id} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function JobLogs({ id }: { id: string }) {
  const [logs, setLogs] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  React.useEffect(() => {
    setLoading(true)
    api.job(id).then((j) => setLogs(j.logs ?? [])).catch(() => setLogs([]))
      .finally(() => setLoading(false))
  }, [id])
  if (loading) return <div className="flex items-center gap-1 text-mute-500"><Spinner className="w-3 h-3" /> loading log…</div>
  if (!logs?.length) return <div className="text-mute-500">no log lines</div>
  return (
    <pre className="p-2 rounded bg-ink-900 border border-ink-700 font-mono
                    text-mute-500 max-h-48 overflow-y-auto whitespace-pre-wrap">
      {logs.join('\n')}
    </pre>
  )
}
