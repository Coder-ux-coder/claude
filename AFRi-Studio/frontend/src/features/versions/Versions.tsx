import React, { useState } from 'react'
import { useStore, activeVersion } from '../../state/store'
import { api } from '../../services/api'
import { Icon, Empty, StatusDot } from '../../components/ui'

export function Versions() {
  const versions = useStore((s) => s.versions)
  const activeId = useStore((s) => s.activeVersionId)
  const conceptId = useStore((s) => s.activeConceptId)
  const selectVersion = useStore((s) => s.selectVersion)
  const setError = useStore((s) => s.setError)
  const [compare, setCompare] = useState<string | null>(null)
  const [diff, setDiff] = useState<any>(null)

  async function refresh() {
    if (!conceptId) return
    const { versions } = await api.versions(conceptId)
    useStore.setState({ versions })
  }

  async function doCompare(id: string) {
    if (!activeId) return
    setCompare(id)
    try { setDiff(await api.diff(activeId, id)) }
    catch (e: any) { setError(e.message) }
  }

  if (!versions.length) {
    return <Empty icon="history" title="No versions" hint="Every change creates a version." />
  }

  return (
    <div className="h-full flex min-h-0">
      <div className="flex-1 overflow-y-auto text-2xs min-w-0">
        {versions.slice().reverse().map((v) => {
          const ok = (v.validation as any)?.ok
          const has = Object.keys(v.assets ?? {}).length
          return (
            <div key={v.id}
                 className={`px-3 py-1.5 border-b border-ink-800 cursor-pointer
                             transition-colors ${v.id === activeId
                               ? 'bg-marigold-400/10 border-l-2 border-l-marigold-400'
                               : 'hover:bg-ink-800/50 border-l-2 border-l-transparent'}`}
                 onClick={() => selectVersion(v.id)}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-mute-400 w-8">v{v.number}</span>
                <span className={`px-1 rounded text-2xs ${
                  v.author === 'refiner' ? 'bg-sky-500/20 text-sky-400'
                  : v.author === 'assistant' ? 'bg-marigold-400/20 text-marigold-300'
                  : 'bg-ink-700 text-mute-500'}`}>{v.author}</span>
                <span className="flex-1 truncate text-mute-400">{v.description}</span>
                {!!v.preferred && <Icon name="star" className="w-3 h-3 text-marigold-300" />}
                {!!v.approved && <Icon name="lock" className="w-3 h-3 text-jade-400" />}
                {(v.validation as any)?.checks && (
                  <StatusDot status={ok ? 'completed' : 'failed'} />
                )}
                <span className="text-mute-500 w-12 text-right">{has} assets</span>
              </div>
              {v.hypothesis && (
                <div className="text-mute-500 mt-0.5 pl-10 italic">{v.hypothesis}</div>
              )}
              {v.id === activeId && (
                <div className="flex gap-1 mt-1.5 pl-10" onClick={(e) => e.stopPropagation()}>
                  <button className="btn-sub h-5"
                          onClick={() => api.restore(v.id).then(refresh).catch((e) => setError(e.message))}>
                    <Icon name="history" className="w-3 h-3" /> Restore
                  </button>
                  <button className="btn-sub h-5"
                          onClick={() => api.prefer(v.id, !v.preferred).then(refresh)}>
                    <Icon name="star" className="w-3 h-3" /> {v.preferred ? 'Unprefer' : 'Prefer'}
                  </button>
                  <button className="btn-sub h-5"
                          onClick={() => api.approve(v.id, !v.approved).then(refresh)}>
                    <Icon name="lock" className="w-3 h-3" /> {v.approved ? 'Unapprove' : 'Approve'}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="w-72 border-l border-ink-700 flex flex-col min-h-0 shrink-0">
        <div className="panel-head">Compare with</div>
        <div className="p-2 shrink-0">
          <select className="input w-full" value={compare ?? ''}
                  onChange={(e) => doCompare(e.target.value)}>
            <option value="">select a version…</option>
            {versions.filter((v) => v.id !== activeId).slice().reverse().map((v) => (
              <option key={v.id} value={v.id}>v{v.number} — {v.description.slice(0, 40)}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2 text-2xs min-h-0">
          {diff ? (
            Object.keys(diff.changes).length ? (
              <table className="w-full">
                <tbody>
                  {Object.entries<any>(diff.changes).map(([k, v]) => (
                    <tr key={k} className="border-b border-ink-800">
                      <td className="py-1 text-mute-500 truncate">{k}</td>
                      <td className="py-1 font-mono text-rose-400 text-right pr-1">
                        {String(v.from)}
                      </td>
                      <td className="py-1 font-mono text-jade-400 text-right">
                        {String(v.to)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="text-mute-500 p-2">Configurations are identical.</div>
          ) : (
            <div className="text-mute-500 p-2">
              Pick a version to see a parameter-level diff.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
