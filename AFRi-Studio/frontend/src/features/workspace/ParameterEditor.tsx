import React, { useMemo, useState } from 'react'
import { useStore, activeVersion } from '../../state/store'
import { api } from '../../services/api'
import type { SchemaField } from '../../types'
import { Icon, Tabs, Empty, Banner } from '../../components/ui'

type Section = 'flower' | 'split' | 'material' | 'render'

function Field({ section, f, value, onChange, disabled }: {
  section: Section; f: SchemaField; value: any
  onChange: (v: any) => void; disabled: boolean
}) {
  const [hover, setHover] = useState(false)
  const changed = value !== f.default

  return (
    <div className="px-2 py-1 rounded hover:bg-ink-800/60 transition-colors group"
         onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="flex items-center gap-2">
        <label className="field-label flex-1 flex items-center gap-1">
          {changed && <span className="w-1 h-1 rounded-full bg-marigold-400 shrink-0" />}
          <span className="truncate">{f.name.replace(/_/g, ' ')}</span>
        </label>

        {f.kind === 'bool' ? (
          <button disabled={disabled} onClick={() => onChange(!value)}
            className={`w-7 h-4 rounded-full transition-colors shrink-0 relative
                        ${value ? 'bg-marigold-400' : 'bg-ink-600'}
                        ${disabled ? 'opacity-40' : ''}`}>
            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-ink-900
                              transition-all ${value ? 'left-3.5' : 'left-0.5'}`} />
          </button>
        ) : f.kind === 'enum' ? (
          <select disabled={disabled} value={value}
                  onChange={(e) => onChange(e.target.value)}
                  className="input w-28 shrink-0">
            {f.choices?.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
          </select>
        ) : f.kind === 'color' ? (
          <div className="flex items-center gap-1 shrink-0">
            <input type="color" disabled={disabled} value={value}
                   onChange={(e) => onChange(e.target.value)}
                   className="w-6 h-6 rounded border border-ink-600 bg-transparent cursor-pointer" />
            <span className="font-mono text-2xs text-mute-500 w-14">{value}</span>
          </div>
        ) : f.kind === 'curve_points' ? (
          <span className="text-2xs text-mute-500 shrink-0">
            {value ? `${value.length} points` : 'auto'}
          </span>
        ) : (
          <input type="number" disabled={disabled} value={value}
                 min={f.min ?? undefined} max={f.max ?? undefined}
                 step={f.step ?? 1}
                 onChange={(e) => {
                   const n = f.kind === 'int'
                     ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
                   if (!Number.isNaN(n)) onChange(n)
                 }}
                 className="input w-16 text-right shrink-0 font-mono" />
        )}
      </div>

      {(f.kind === 'number' || f.kind === 'int') && f.min != null && (
        <input type="range" disabled={disabled} value={value}
               min={f.min} max={f.max ?? 1} step={f.step ?? 0.01}
               onChange={(e) => {
                 const n = f.kind === 'int'
                   ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
                 onChange(n)
               }}
               className="w-full mt-1 cursor-pointer" />
      )}

      {hover && f.description && (
        <div className="text-2xs text-mute-500 mt-0.5 leading-snug animate-fade-in">
          {f.description}
          {f.unit && <span className="opacity-60"> ({f.unit})</span>}
        </div>
      )}
    </div>
  )
}

export function ParameterEditor() {
  const { schema, draft, dirty, setDraft, resetDraft, commitDraft, setError } = useStore()
  const version = useStore(activeVersion)
  const conceptId = useStore((s) => s.activeConceptId)
  const [section, setSection] = useState<Section>('flower')
  const [busy, setBusy] = useState(false)

  const approved = !!version?.approved
  const fields = schema?.sections[section] ?? []

  const groups = useMemo(() => {
    const g: Record<string, SchemaField[]> = {}
    fields.forEach((f) => { (g[f.group] ||= []).push(f) })
    return g
  }, [fields])

  async function applyChanges(quality?: string) {
    if (!conceptId || !draft) return
    setBusy(true)
    try {
      let target = version
      if (dirty) {
        target = await commitDraft('parameter change')
      }
      if (!target) return
      await api.createJob({
        type: quality === 'final' ? 'RENDER_FINAL' : 'GENERATE',
        version_id: target.id,
      })
    } catch (e: any) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  if (!schema || !draft) {
    return <Empty icon="sliders" title="No design loaded"
                  hint="Select or create a concept to edit its parameters." />
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <Tabs active={section} onChange={setSection}
            tabs={[{ id: 'flower' as const, label: 'Flower' },
                   { id: 'split' as const, label: 'Split' },
                   { id: 'material' as const, label: 'Material' },
                   { id: 'render' as const, label: 'Render' }]} />

      <div className="flex-1 overflow-y-auto min-h-0 py-1">
        {approved && (
          <div className="px-2 pb-1">
            <Banner kind="warn">
              Version {version?.number} is approved and write-locked. Editing it
              creates a new version; the approved one is never overwritten.
            </Banner>
          </div>
        )}
        {Object.entries(groups).map(([group, gf]) => (
          <div key={group} className="mb-1">
            <div className="px-2 pt-2 pb-0.5 text-2xs font-semibold uppercase
                            tracking-wider text-ink-400">{group}</div>
            {gf.map((f) => (
              <Field key={f.name} section={section} f={f}
                     value={(draft as any)[section][f.name]}
                     disabled={busy}
                     onChange={(v) => setDraft(section, f.name, v)} />
            ))}
          </div>
        ))}
      </div>

      <div className="border-t border-ink-700 p-2 space-y-1.5 shrink-0">
        {dirty && (
          <div className="text-2xs text-marigold-300 flex items-center gap-1">
            <span className="w-1 h-1 rounded-full bg-marigold-400" />
            unsaved changes
          </div>
        )}
        <div className="flex gap-1.5">
          <button className="btn-primary flex-1" disabled={busy}
                  onClick={() => applyChanges()}>
            <Icon name="play" /> Apply changes
          </button>
          <button className="btn-sub" disabled={busy || !dirty} onClick={resetDraft}
                  title="Discard unsaved edits">
            <Icon name="refresh" />
          </button>
        </div>
        <button className="btn-sub w-full" disabled={busy}
                onClick={() => applyChanges('final')}>
          <Icon name="camera" /> Render full concept set (6 views)
        </button>
        <p className="text-2xs text-mute-500 leading-snug">
          Changes are applied explicitly — moving a slider never starts a Blender
          job on its own.
        </p>
      </div>
    </div>
  )
}
