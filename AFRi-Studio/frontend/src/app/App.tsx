import React, { useEffect, useState } from 'react'
import { useStore, activeConcept, activeVersion, runningJob } from '../state/store'
import { api } from '../services/api'
import { Icon, StatusDot, Spinner, Banner, Tabs, Empty } from '../components/ui'
import { Splitter } from '../layouts/Splitter'
import { Viewport } from '../features/workspace/Viewport'
import { ParameterEditor } from '../features/workspace/ParameterEditor'
import { Dashboard } from '../features/dashboard/Dashboard'
import { ConceptExplorer } from '../features/concepts/ConceptExplorer'
import { Assistant } from '../features/assistant/Assistant'
import { Versions } from '../features/versions/Versions'
import { JobsPanel } from '../features/workflow/JobsPanel'
import { EventLog } from '../features/workflow/EventLog'
import { Refine } from '../features/workflow/Refine'
import { ValidationPanel } from '../features/validation/ValidationPanel'
import { Exports } from '../features/exports/Exports'

type Main = 'workspace' | 'dashboard' | 'concepts' | 'versions' | 'exports'
type Bottom = 'assistant' | 'jobs' | 'events' | 'refine'
type Right = 'parameters' | 'validation' | 'inspector'

function TopBar() {
  const { system, connected, dirty } = useStore()
  const concept = useStore(activeConcept)
  const version = useStore(activeVersion)
  const job = useStore(runningJob)
  const commitDraft = useStore((s) => s.commitDraft)
  const setError = useStore((s) => s.setError)
  const [saving, setSaving] = useState(false)

  return (
    <header className="flex items-center gap-2 px-3 h-11 border-b border-ink-700
                       bg-ink-850 shrink-0">
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-marigold-300
                        to-marigold-600 grid place-items-center text-ink-900
                        font-bold text-xs">A</div>
        <div className="leading-tight">
          <div className="text-xs font-semibold text-mute-300">AFRi Studio</div>
          <div className="text-2xs text-ink-400">{system?.stage ?? 'Stage One'}</div>
        </div>
      </div>

      <div className="w-px h-5 bg-ink-700 mx-1 shrink-0" />

      <div className="min-w-0 flex items-center gap-2">
        <span className="text-xs text-mute-300 font-medium truncate">
          {concept?.name ?? 'No concept'}
        </span>
        {version && (
          <span className="chip shrink-0">
            v{version.number}
            {!!version.approved && <Icon name="lock" className="w-2.5 h-2.5" />}
          </span>
        )}
        {dirty && <span className="chip bg-marigold-400/20 text-marigold-300 shrink-0">
          unsaved</span>}
      </div>

      <div className="flex-1" />

      {job && (
        <div className="flex items-center gap-1.5 px-2 h-6 rounded-md bg-ink-800
                        border border-ink-600 shrink-0 max-w-xs">
          <Spinner className="w-3 h-3 text-marigold-400" />
          <span className="text-2xs text-marigold-300 font-medium">{job.stage}</span>
          <span className="text-2xs text-mute-500 truncate hidden md:inline">
            {job.message}
          </span>
        </div>
      )}

      <button className="btn-sub shrink-0" disabled={!dirty || saving}
              onClick={async () => {
                setSaving(true)
                try { await commitDraft('manual save') }
                catch (e: any) { setError(e.message) }
                finally { setSaving(false) }
              }}>
        <Icon name="check" /> Save version
      </button>

      <div className="flex items-center gap-1.5 px-2 h-6 rounded-md bg-ink-800 shrink-0"
           title={connected ? 'Live event stream connected' : 'Event stream disconnected'}>
        <StatusDot status={connected ? 'ok' : 'error'} />
        <span className="text-2xs text-mute-500 hidden sm:inline">
          {connected ? 'live' : 'offline'}
        </span>
      </div>
      <div className="flex items-center gap-1.5 px-2 h-6 rounded-md bg-ink-800 shrink-0"
           title={system?.blender.note}>
        <StatusDot status={system?.blender.available ? 'ok' : 'error'} />
        <span className="text-2xs text-mute-500 hidden lg:inline">
          {system?.blender.version ?? 'no Blender'}
        </span>
      </div>
    </header>
  )
}

function LeftSidebar({ main, setMain }: { main: Main; setMain: (m: Main) => void }) {
  const { concepts, activeConceptId, selectConcept, milestones } = useStore()
  const nav: { id: Main; label: string; icon: string }[] = [
    { id: 'workspace', label: 'Workspace', icon: 'cube' },
    { id: 'dashboard', label: 'Dashboard', icon: 'gauge' },
    { id: 'concepts', label: 'Concepts', icon: 'grid' },
    { id: 'versions', label: 'History', icon: 'history' },
    { id: 'exports', label: 'Exports', icon: 'download' },
  ]
  const doneCount = milestones.filter((m) => m.done).length

  return (
    <aside className="flex flex-col h-full bg-ink-850 border-r border-ink-700 min-h-0">
      <nav className="p-1.5 space-y-0.5 shrink-0">
        {nav.map((n) => (
          <button key={n.id} onClick={() => setMain(n.id)}
            className={`w-full flex items-center gap-2 px-2 h-7 rounded-md text-xs
                        font-medium transition-colors ${
              main === n.id ? 'bg-marigold-400/15 text-marigold-300'
                            : 'text-mute-500 hover:bg-ink-700 hover:text-mute-300'}`}>
            <Icon name={n.icon} /> {n.label}
          </button>
        ))}
      </nav>

      <div className="px-2 pt-2 pb-1 text-2xs font-semibold uppercase tracking-wider
                      text-ink-400 shrink-0">Concepts</div>
      <div className="flex-1 overflow-y-auto min-h-0 px-1.5 pb-2 space-y-0.5">
        {concepts.filter((c) => !c.archived).map((c) => {
          const val = c.head?.validation as any
          return (
            <button key={c.id} onClick={() => { selectConcept(c.id); setMain('workspace') }}
              className={`w-full flex items-center gap-1.5 px-2 h-7 rounded-md text-2xs
                          text-left transition-colors ${
                c.id === activeConceptId ? 'bg-ink-700 text-mute-300'
                                         : 'text-mute-500 hover:bg-ink-800'}`}>
              <span className="truncate flex-1">{c.name}</span>
              {val?.checks && <StatusDot status={val.ok ? 'completed' : 'failed'} />}
            </button>
          )
        })}
        {!concepts.length && (
          <div className="px-2 py-3 text-2xs text-ink-400">No concepts yet.</div>
        )}
      </div>

      <div className="border-t border-ink-700 p-2 shrink-0">
        <div className="flex items-center justify-between text-2xs mb-1">
          <span className="text-mute-500">Milestones</span>
          <span className="text-mute-400 font-mono">{doneCount}/{milestones.length}</span>
        </div>
        <div className="flex gap-0.5">
          {milestones.map((m) => (
            <div key={m.key} title={`${m.label} — ${m.detail}`}
                 className={`h-1 flex-1 rounded-full ${
                   m.done ? 'bg-jade-500' : 'bg-ink-700'}`} />
          ))}
        </div>
      </div>
    </aside>
  )
}

function Inspector() {
  const version = useStore(activeVersion)
  const stats = version?.stats as any
  if (!stats || !Object.keys(stats).length) {
    return <Empty icon="cube" title="No geometry yet"
                  hint="Generate the design to populate the inspector." />
  }
  const split = stats.split ?? {}
  const rows: [string, any][] = [
    ['petals', stats.petal_count], ['layers', stats.layer_count],
    ['triangles', stats.faces?.toLocaleString?.() ?? stats.faces],
    ['vertices', stats.verts?.toLocaleString?.() ?? stats.verts],
    ['diameter', `${stats.diameter_mm} mm`], ['height', `${stats.height_mm} mm`],
    ['bodies total', split.bodies_total], ['bodies divided', split.bodies_divided],
    ['triangles clipped', split.triangles_clipped],
    ['boundary loops', split.boundary_loops], ['caps built', split.caps_built],
    ['cap failures', split.cap_failures],
    ['open edges A', split.residual_open_edges_a],
    ['open edges B', split.residual_open_edges_b],
    ['split path', split.path_kind],
    ['split time', split.split_seconds ? `${split.split_seconds}s` : undefined],
    ['pipeline time', stats.pipeline_seconds ? `${stats.pipeline_seconds}s` : undefined],
  ]
  return (
    <div className="h-full overflow-y-auto p-2 text-2xs">
      <table className="w-full">
        <tbody>
          {rows.filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => (
            <tr key={k} className="border-b border-ink-800">
              <td className="py-1 text-mute-500">{k}</td>
              <td className="py-1 text-right font-mono text-mute-300">{String(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function App() {
  const { boot, error, setError, prefs, setPref, system } = useStore()
  const [main, setMain] = useState<Main>('workspace')
  const [bottom, setBottom] = useState<Bottom>('assistant')
  const [right, setRight] = useState<Right>('parameters')
  const [leftW, setLeftW] = useState(prefs.leftW ?? 196)
  const [rightW, setRightW] = useState(prefs.rightW ?? 300)
  const [bottomH, setBottomH] = useState(prefs.bottomH ?? 236)
  const [bottomOpen, setBottomOpen] = useState(prefs.bottomOpen ?? true)
  const jobs = useStore((s) => s.jobs)

  useEffect(() => { boot() }, [boot])
  useEffect(() => { setPref('leftW', leftW) }, [leftW])
  useEffect(() => { setPref('rightW', rightW) }, [rightW])
  useEffect(() => { setPref('bottomH', bottomH) }, [bottomH])
  useEffect(() => { setPref('bottomOpen', bottomOpen) }, [bottomOpen])

  const activeJobs = jobs.filter((j) => ['running', 'queued', 'claimed'].includes(j.status)).length

  return (
    <div className="h-screen flex flex-col bg-ink-900 text-mute-300 overflow-hidden">
      <TopBar />

      {error && (
        <div className="px-3 py-1.5 shrink-0">
          <Banner kind="error" onClose={() => setError(null)}>{error}</Banner>
        </div>
      )}
      {system && !system.blender.available && (
        <div className="px-3 py-1.5 shrink-0">
          <Banner kind="error">{system.blender.error}</Banner>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <div style={{ width: leftW }} className="shrink-0 min-w-0">
          <LeftSidebar main={main} setMain={setMain} />
        </div>
        <Splitter dir="horizontal" size={leftW} min={150} max={340} onResize={setLeftW} />

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="flex-1 min-h-0">
            {main === 'workspace' && <Viewport />}
            {main === 'dashboard' && <Dashboard />}
            {main === 'concepts' && <ConceptExplorer />}
            {main === 'versions' && <Versions />}
            {main === 'exports' && <Exports />}
          </div>

          {bottomOpen && (
            <>
              <Splitter dir="vertical" size={bottomH} min={120} max={560}
                        invert onResize={setBottomH} />
              <div style={{ height: bottomH }}
                   className="shrink-0 border-t border-ink-700 bg-ink-850 flex flex-col min-h-0">
                <div className="flex items-center border-b border-ink-700 shrink-0">
                  <Tabs active={bottom} onChange={setBottom}
                        tabs={[{ id: 'assistant' as const, label: 'Claude Designer' },
                               { id: 'jobs' as const, label: 'Jobs', badge: activeJobs },
                               { id: 'refine' as const, label: 'Refinement' },
                               { id: 'events' as const, label: 'Event log' }]} />
                  <div className="flex-1" />
                  <button className="btn-ghost mr-1" onClick={() => setBottomOpen(false)}>
                    <Icon name="x" />
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  {bottom === 'assistant' && <Assistant />}
                  {bottom === 'jobs' && <JobsPanel />}
                  {bottom === 'refine' && <Refine />}
                  {bottom === 'events' && <EventLog />}
                </div>
              </div>
            </>
          )}
          {!bottomOpen && (
            <button onClick={() => setBottomOpen(true)}
                    className="shrink-0 h-6 border-t border-ink-700 bg-ink-850 text-2xs
                               text-mute-500 hover:text-mute-300 transition-colors">
              Show assistant, jobs and logs
            </button>
          )}
        </div>

        <Splitter dir="horizontal" size={rightW} min={240} max={480}
                  invert onResize={setRightW} />
        <div style={{ width: rightW }}
             className="shrink-0 bg-ink-850 border-l border-ink-700 flex flex-col min-h-0">
          <Tabs active={right} onChange={setRight}
                tabs={[{ id: 'parameters' as const, label: 'Parameters' },
                       { id: 'validation' as const, label: 'Validation' },
                       { id: 'inspector' as const, label: 'Inspector' }]} />
          <div className="flex-1 min-h-0">
            {right === 'parameters' && <ParameterEditor />}
            {right === 'validation' && <ValidationPanel />}
            {right === 'inspector' && <Inspector />}
          </div>
        </div>
      </div>
    </div>
  )
}
