import React from 'react'
import { useStore, runningJob, activeVersion } from '../../state/store'
import { api } from '../../services/api'
import { Icon, StatusDot, Bar, Empty, Spinner } from '../../components/ui'

function Stat({ label, value, sub, tone = 'default' }:
  { label: string; value: React.ReactNode; sub?: string; tone?: string }) {
  const tones: Record<string, string> = {
    default: 'text-mute-300', good: 'text-jade-400',
    warn: 'text-marigold-300', bad: 'text-rose-400',
  }
  return (
    <div className="panel p-2.5">
      <div className="field-label">{label}</div>
      <div className={`text-base font-semibold mt-0.5 ${tones[tone]}`}>{value}</div>
      {sub && <div className="text-2xs text-mute-500 mt-0.5 truncate">{sub}</div>}
    </div>
  )
}

function Timeline() {
  const milestones = useStore((s) => s.milestones)
  if (!milestones.length) return null
  return (
    <div className="panel p-3">
      <div className="field-label mb-2">Project timeline</div>
      <div className="flex flex-col gap-0">
        {milestones.map((m, i) => (
          <div key={m.key} className="flex items-start gap-2.5">
            <div className="flex flex-col items-center shrink-0">
              <div className={`w-3.5 h-3.5 rounded-full grid place-items-center border
                ${m.done ? 'bg-jade-500/20 border-jade-500 text-jade-400'
                         : 'bg-ink-800 border-ink-600 text-ink-500'}`}>
                {m.done && <Icon name="check" className="w-2 h-2" />}
              </div>
              {i < milestones.length - 1 && (
                <div className={`w-px h-5 ${m.done ? 'bg-jade-500/40' : 'bg-ink-700'}`} />
              )}
            </div>
            <div className="pb-1 min-w-0">
              <div className={`text-2xs font-medium ${m.done ? 'text-mute-300' : 'text-mute-500'}`}>
                {m.label}
              </div>
              <div className="text-2xs text-ink-400 truncate">{m.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Dashboard() {
  const { system, concepts, jobs, milestones } = useStore()
  const job = useStore(runningJob)
  const version = useStore(activeVersion)
  const conceptId = useStore((s) => s.activeConceptId)
  const concept = concepts.find((c) => c.id === conceptId)

  const queued = jobs.filter((j) => j.status === 'queued').length
  const done = jobs.filter((j) => j.status === 'completed').length
  const failed = jobs.filter((j) => j.status === 'failed').length
  const val = version?.validation as any

  const latestRender = version && Object.keys(version.assets ?? {})
    .find((k) => !['glb', 'blend'].includes(k) && !k.endsWith('_stl') && !k.endsWith('_obj'))

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Stat label="Active concept" value={concept?.name ?? '—'}
              sub={concept ? `${concept.version_count ?? 0} versions · ${concept.split_type}` : ''} />
        <Stat label="Current version" value={version ? `v${version.number}` : '—'}
              sub={version?.description} />
        <Stat label="Validation"
              value={val?.checks ? `${val.passed}/${val.total}` : '—'}
              tone={val?.checks ? (val.ok ? 'good' : 'bad') : 'default'}
              sub={val?.checks ? `${val.errors} errors, ${val.warnings} warnings` : 'not run'} />
        <Stat label="Jobs" value={`${done} done`} 
              sub={`${queued} queued · ${failed} failed`}
              tone={failed ? 'warn' : 'default'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 space-y-3">
          {/* active job */}
          <div className="panel p-3">
            <div className="field-label mb-2">Active job</div>
            {job ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <Spinner className="w-3.5 h-3.5 text-marigold-400" />
                  <span className="font-mono text-mute-500">{job.id.slice(4, 16)}</span>
                  <span className="text-marigold-300 font-medium">{job.stage}</span>
                  <span className="text-mute-500 flex-1 truncate">{job.message}</span>
                  <button className="btn-danger" onClick={() => api.cancelJob(job.id)}>
                    <Icon name="stop" /> Cancel
                  </button>
                </div>
                {job.progress_total > 0 && (
                  <>
                    <Bar value={job.progress_index} total={job.progress_total} />
                    <div className="text-2xs text-mute-500">
                      {job.progress_index} / {job.progress_total} · started{' '}
                      {job.started_at ? `${(Date.now() / 1000 - job.started_at).toFixed(0)}s ago` : ''}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="text-2xs text-mute-500">
                Nothing running. {queued > 0 ? `${queued} job(s) queued.` : 'Queue is empty.'}
              </div>
            )}
          </div>

          {/* latest render */}
          <div className="panel overflow-hidden">
            <div className="panel-head">Latest render</div>
            {version && latestRender ? (
              <div className="p-2">
                <img src={api.assetUrl(version.id, `${latestRender}.png`)}
                     alt="latest render"
                     className="w-full rounded border border-ink-700 animate-fade-in" />
                <div className="text-2xs text-mute-500 mt-1">
                  {latestRender.replace(/_/g, ' ')} · Cycles CPU
                </div>
              </div>
            ) : (
              <div className="h-48">
                <Empty icon="camera" title="No render yet"
                       hint="Apply changes to generate geometry and a preview." />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <Timeline />

          <div className="panel p-3">
            <div className="field-label mb-2">Environment</div>
            <dl className="text-2xs space-y-1">
              {[
                ['OS', system?.os],
                ['CPU', `${system?.cpu_count} cores`],
                ['RAM', system?.ram_total_gb ? `${system.ram_available_gb} / ${system.ram_total_gb} GB free` : '—'],
                ['Disk', `${system?.disk_free_gb} GB free`],
                ['Blender', system?.blender.version ?? 'not found'],
                ['Engine', system?.blender.engines.join(', ') || '—'],
                ['Workers', String(system?.max_concurrent_jobs ?? 1)],
              ].map(([k, v]) => (
                <div key={k as string} className="flex justify-between gap-2">
                  <dt className="text-mute-500">{k}</dt>
                  <dd className="text-mute-400 truncate text-right">{v as string}</dd>
                </div>
              ))}
            </dl>
            {system?.blender.note && (
              <p className="text-2xs text-mute-500 mt-2 leading-snug border-t
                            border-ink-700 pt-2">{system.blender.note}</p>
            )}
          </div>

          <div className="panel p-3">
            <div className="field-label mb-2">Stage</div>
            <div className="text-2xs text-mute-400 leading-relaxed">
              <span className="text-marigold-300 font-medium">Stage One</span> — standalone
              flower concepts.
              <div className="mt-1.5 text-mute-500">
                Hat integration is Stage Two and has not been started. It begins
                only when you explicitly authorise it.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
