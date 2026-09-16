import React, { useState } from 'react'
import { useStore } from '../../state/store'
import { api } from '../../services/api'
import { Icon, Empty, Spinner, Banner } from '../../components/ui'

export function Refine() {
  const conceptId = useStore((s) => s.activeConceptId)
  const versionId = useStore((s) => s.activeVersionId)
  const runs = useStore((s) => s.refineRuns)
  const refreshRefine = useStore((s) => s.refreshRefine)
  const setError = useStore((s) => s.setError)
  const [iters, setIters] = useState(5)
  const [budget, setBudget] = useState(900)
  const [renderEach, setRenderEach] = useState(false)
  const [busy, setBusy] = useState(false)
  const [measure, setMeasure] = useState<any>(null)

  const active = runs.find((r) => r.status === 'running')

  async function start() {
    if (!conceptId) return
    setBusy(true)
    try {
      await api.refineStart({ concept_id: conceptId, max_iterations: iters,
                              max_seconds: budget, render_each: renderEach })
      await refreshRefine()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  async function doMeasure() {
    if (!versionId) return
    try { setMeasure((await api.measure(versionId)).measurements) }
    catch (e: any) { setError(e.message) }
  }

  if (!conceptId) return <Empty icon="gauge" title="No concept selected" />

  return (
    <div className="h-full overflow-y-auto p-2 space-y-2 text-2xs">
      <Banner kind="info">
        Refinement is bounded and hypothesis-driven. Each iteration targets one
        measured weakness, states what it expects to change, and is kept only if
        that measurement actually improved without regressing the others.
      </Banner>

      <div className="panel p-2 space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <label className="space-y-0.5">
            <div className="field-label">max iterations</div>
            <input type="number" min={1} max={20} value={iters}
                   onChange={(e) => setIters(+e.target.value)} className="input w-full" />
          </label>
          <label className="space-y-0.5">
            <div className="field-label">time budget (s)</div>
            <input type="number" min={30} max={7200} step={30} value={budget}
                   onChange={(e) => setBudget(+e.target.value)} className="input w-full" />
          </label>
          <label className="flex items-end gap-1 pb-1">
            <input type="checkbox" checked={renderEach}
                   onChange={(e) => setRenderEach(e.target.checked)} />
            <span className="text-mute-500">render each</span>
          </label>
        </div>
        <div className="flex gap-1.5">
          {active ? (
            <button className="btn-danger flex-1"
                    onClick={() => api.refineStop(active.id).then(refreshRefine)}>
              <Icon name="stop" /> Stop run
            </button>
          ) : (
            <button className="btn-primary flex-1" disabled={busy} onClick={start}>
              {busy ? <Spinner /> : <Icon name="play" />} Start refinement
            </button>
          )}
          <button className="btn-sub" onClick={doMeasure}>
            <Icon name="gauge" /> Measure now
          </button>
        </div>
      </div>

      {measure && (
        <div className="panel p-2">
          <div className="field-label mb-1">Measurements</div>
          <div className="grid grid-cols-3 gap-1">
            {Object.entries(measure).map(([k, v]) => (
              <div key={k} className="px-1.5 py-1 rounded bg-ink-800">
                <div className="text-mute-500 truncate">{k.replace(/_/g, ' ')}</div>
                <div className="font-mono text-mute-300">{String(v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!runs.length && <Empty icon="gauge" title="No refinement runs yet"
        hint="Start a bounded run to iterate on measured weaknesses." />}

      {runs.map((r) => (
        <div key={r.id} className="panel p-2">
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`px-1.5 h-5 inline-flex items-center rounded font-medium ${
              r.status === 'running' ? 'bg-marigold-400/20 text-marigold-300'
              : r.status === 'failed' ? 'bg-rose-500/20 text-rose-400'
              : 'bg-jade-500/20 text-jade-400'}`}>{r.status}</span>
            <span className="text-mute-500">
              {r.iterations.length} / {r.config.max_iterations} iterations
            </span>
            <span className="flex-1" />
            {r.stop_reason && <span className="text-mute-500 truncate">{r.stop_reason}</span>}
          </div>
          {r.iterations.map((it: any) => (
            <div key={it.index} className="flex items-start gap-2 py-1 border-t border-ink-800">
              <span className={`px-1 rounded shrink-0 ${
                it.outcome === 'kept' ? 'bg-jade-500/20 text-jade-400'
                : 'bg-ink-700 text-mute-500'}`}>{it.outcome}</span>
              <div className="min-w-0">
                <div className="text-mute-400">{it.weakness}</div>
                <div className="text-mute-500">{it.note}</div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
