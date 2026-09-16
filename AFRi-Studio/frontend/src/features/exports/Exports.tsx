import React, { useEffect, useState } from 'react'
import { useStore, activeVersion } from '../../state/store'
import { api } from '../../services/api'
import { Icon, Empty, Spinner, Banner } from '../../components/ui'

export function Exports() {
  const version = useStore(activeVersion)
  const versions = useStore((s) => s.versions)
  const concepts = useStore((s) => s.concepts)
  const setError = useStore((s) => s.setError)
  const [exports, setExports] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<string[]>([])

  async function refresh() {
    try { setExports((await api.exports()).exports) } catch { /* transient */ }
  }
  useEffect(() => { refresh() }, [])

  async function buildBundle() {
    const ids = picked.length ? picked
      : concepts.map((c) => c.head?.id).filter(Boolean) as string[]
    if (!ids.length) return
    setBusy(true)
    try {
      await api.buildExport(ids, `afri_marigold_${Date.now()}`)
      await refresh()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  async function exportMeshes() {
    if (!version) return
    setBusy(true)
    try {
      await api.createJob({ type: 'EXPORT', version_id: version.id,
        export_meshes: ['stl', 'obj'], shots: [], save_blend: true })
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const assets = version?.assets ?? {}

  return (
    <div className="h-full overflow-y-auto p-2 space-y-2 text-2xs">
      <Banner kind="warn">
        STL and OBJ exports are geometry only. They are <em>not</em> verified as
        manufacturing-ready — wall thickness, tolerances and process constraints
        have not been assessed.
      </Banner>

      <div className="panel p-2">
        <div className="field-label mb-1.5">Current version assets</div>
        {Object.keys(assets).length ? (
          <div className="space-y-1">
            {Object.entries(assets).map(([k, path]) => (
              <div key={k} className="flex items-center gap-2 px-2 py-1 rounded bg-ink-800">
                <Icon name="doc" className="w-3 h-3 text-mute-500 shrink-0" />
                <span className="text-mute-400 w-36 truncate">{k}</span>
                <span className="text-mute-500 flex-1 truncate font-mono">{path as string}</span>
                <a className="btn-ghost h-5"
                   href={api.assetUrl(version!.id, (path as string).split('/').pop()!)}
                   download>
                  <Icon name="download" className="w-3 h-3" />
                </a>
              </div>
            ))}
          </div>
        ) : <div className="text-mute-500">No assets yet for this version.</div>}
        <button className="btn-sub w-full mt-2" disabled={busy || !version}
                onClick={exportMeshes}>
          <Icon name="cube" /> Export STL + OBJ for both pieces
        </button>
      </div>

      <div className="panel p-2">
        <div className="field-label mb-1.5">Client delivery bundle</div>
        <div className="space-y-1 mb-2 max-h-40 overflow-y-auto">
          {concepts.filter((c) => !c.archived).map((c) => (
            <label key={c.id} className="flex items-center gap-2 px-2 py-1 rounded
                                         hover:bg-ink-800 cursor-pointer">
              <input type="checkbox"
                     checked={picked.includes(c.head?.id ?? '')}
                     onChange={(e) => {
                       const id = c.head?.id
                       if (!id) return
                       setPicked((p) => e.target.checked ? [...p, id] : p.filter((x) => x !== id))
                     }} />
              <span className="text-mute-400 flex-1 truncate">{c.name}</span>
              <span className="text-mute-500">
                {Object.keys(c.head?.assets ?? {}).length} assets
              </span>
            </label>
          ))}
        </div>
        <button className="btn-primary w-full" disabled={busy} onClick={buildBundle}>
          {busy ? <Spinner /> : <Icon name="download" />}
          Build delivery bundle {picked.length ? `(${picked.length})` : '(all concepts)'}
        </button>
      </div>

      <div className="panel p-2">
        <div className="field-label mb-1.5">Built bundles</div>
        {!exports.length ? (
          <div className="text-mute-500">Nothing built yet.</div>
        ) : exports.map((e) => (
          <div key={e.name} className="flex items-center gap-2 px-2 py-1 rounded bg-ink-800 mb-1">
            <Icon name="archive" className="w-3 h-3 text-mute-500" />
            <span className="text-mute-400 flex-1 truncate">{e.name}</span>
            <span className="text-mute-500">{(e.bytes / 1048576).toFixed(1)} MB</span>
            <a className="btn-ghost h-5" download
               href={`/api/exports/download/${encodeURIComponent(e.name)}`}>
              <Icon name="download" className="w-3 h-3" />
            </a>
          </div>
        ))}
      </div>
    </div>
  )
}
