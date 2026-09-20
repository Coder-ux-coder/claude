import React, { useState } from 'react'
import { useStore } from '../../state/store'
import { api } from '../../services/api'
import { Icon, Empty, StatusDot } from '../../components/ui'
import type { Concept } from '../../types'

function Thumb({ c }: { c: Concept }) {
  const v = c.head
  const key = v && Object.keys(v.assets ?? {})
    .find((k) => !['glb', 'blend'].includes(k) && !k.endsWith('_stl') && !k.endsWith('_obj'))
  if (!v || !key) {
    return (
      <div className="aspect-square rounded-md bg-ink-800 border border-ink-700
                      grid place-items-center text-ink-500">
        <Icon name="cube" className="w-6 h-6" />
      </div>
    )
  }
  return (
    <img src={api.assetUrl(v.id, `${key}.png`)} alt={c.name} loading="lazy"
         className="aspect-square object-cover rounded-md border border-ink-700 bg-ink-800" />
  )
}

export function ConceptExplorer() {
  const { concepts, activeConceptId, selectConcept, refreshConcepts, setError } = useStore()
  const [showArchived, setShowArchived] = useState(false)
  const [compare, setCompare] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const shown = concepts.filter((c) => showArchived || !c.archived)

  async function create() {
    if (!name.trim()) return
    try {
      const c = await api.createConcept(name, 'New concept')
      setName(''); setCreating(false)
      await refreshConcepts(); await selectConcept(c.id)
    } catch (e: any) { setError(e.message) }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-ink-700 shrink-0">
        <span className="text-2xs text-mute-500">{shown.length} concepts</span>
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-2xs text-mute-500">
          <input type="checkbox" checked={showArchived}
                 onChange={(e) => setShowArchived(e.target.checked)} /> archived
        </label>
        <button className="btn-sub" onClick={() => setCreating(!creating)}>
          <Icon name="plus" /> New
        </button>
      </div>

      {creating && (
        <div className="flex gap-1.5 p-2 border-b border-ink-700 shrink-0">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && create()}
                 placeholder="Concept name" className="input flex-1 h-7" />
          <button className="btn-primary" onClick={create}>Create</button>
        </div>
      )}

      {compare.length >= 2 && (
        <div className="p-2 border-b border-ink-700 shrink-0">
          <div className="text-2xs text-mute-500 mb-1.5">
            Comparing {compare.length} concepts at matched framing
          </div>
          <div className="grid grid-cols-3 gap-2">
            {compare.map((id) => {
              const c = concepts.find((x) => x.id === id)
              return c ? (
                <div key={id}>
                  <Thumb c={c} />
                  <div className="text-2xs text-mute-400 mt-1 truncate">{c.name}</div>
                </div>
              ) : null
            })}
          </div>
          <button className="btn-ghost mt-1.5" onClick={() => setCompare([])}>
            <Icon name="x" /> Clear comparison
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 p-2">
        {!shown.length ? (
          <Empty icon="grid" title="No concepts yet"
                 hint="Create a concept to start designing. Each concept holds its own version history." />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
            {shown.map((c) => {
              const v = c.head
              const val = v?.validation as any
              const nAssets = Object.keys(v?.assets ?? {}).length
              return (
                <div key={c.id}
                     className={`panel p-2 cursor-pointer transition-all hover:border-ink-500
                                 ${c.id === activeConceptId ? 'border-marigold-400/50' : ''}
                                 ${c.archived ? 'opacity-50' : ''}`}
                     onClick={() => selectConcept(c.id)}>
                  <Thumb c={c} />
                  <div className="mt-1.5 flex items-start gap-1">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-mute-300 truncate">{c.name}</div>
                      <div className="text-2xs text-mute-500 truncate">{c.description}</div>
                    </div>
                    {val?.checks && <StatusDot status={val.ok ? 'completed' : 'failed'} />}
                  </div>
                  <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                    <span className="chip">{c.split_type.replace('_', ' ')}</span>
                    <span className="chip">v{v?.number ?? 0}</span>
                    <span className="chip">{nAssets} assets</span>
                  </div>
                  <div className="flex gap-1 mt-1.5" onClick={(e) => e.stopPropagation()}>
                    <button className="btn-ghost h-5 px-1"
                            onClick={() => api.duplicateConcept(c.id, `${c.name} copy`)
                              .then(refreshConcepts).catch((e) => setError(e.message))}>
                      <Icon name="copy" className="w-3 h-3" />
                    </button>
                    <button className="btn-ghost h-5 px-1"
                            onClick={() => setCompare((p) => p.includes(c.id)
                              ? p.filter((x) => x !== c.id) : [...p, c.id])}>
                      <Icon name="layers" className="w-3 h-3" />
                    </button>
                    <button className="btn-ghost h-5 px-1"
                            onClick={() => api.patchConcept(c.id, { archived: c.archived ? 0 : 1 })
                              .then(refreshConcepts)}>
                      <Icon name="archive" className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
