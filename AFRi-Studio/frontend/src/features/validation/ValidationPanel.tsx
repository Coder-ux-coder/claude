import React from 'react'
import { useStore, activeVersion } from '../../state/store'
import { Icon, Empty } from '../../components/ui'

export function ValidationPanel() {
  const version = useStore(activeVersion)
  const v = version?.validation as any

  if (!v || !v.checks) {
    return <Empty icon="flask" title="Not validated yet"
                  hint="Validation runs automatically as part of every generation job." />
  }

  const m = v.measurements ?? {}
  return (
    <div className="h-full overflow-y-auto text-2xs">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-700 sticky top-0 bg-ink-850">
        <span className={`px-1.5 h-5 inline-flex items-center rounded font-semibold
          ${v.ok ? 'bg-jade-500/20 text-jade-400' : 'bg-rose-500/20 text-rose-400'}`}>
          {v.passed}/{v.total} passed
        </span>
        {v.errors > 0 && <span className="text-rose-400">{v.errors} errors</span>}
        {v.warnings > 0 && <span className="text-marigold-300">{v.warnings} warnings</span>}
        <span className="ml-auto text-mute-500">{v.seconds}s</span>
      </div>

      <div className="p-2 grid grid-cols-2 gap-1">
        {Object.entries(m).map(([k, val]) => (
          <div key={k} className="px-2 py-1 rounded bg-ink-800">
            <div className="text-mute-500 truncate">{k.replace(/_/g, ' ')}</div>
            <div className="font-mono text-mute-300">
              {typeof val === 'number' ? (val as number).toLocaleString() : String(val)}
            </div>
          </div>
        ))}
      </div>

      <div className="px-1 pb-2">
        {v.checks.map((c: any) => (
          <div key={c.name} className="flex items-start gap-2 px-2 py-1.5 rounded
                                       hover:bg-ink-800/60 transition-colors">
            <span className={`mt-0.5 shrink-0 ${c.passed ? 'text-jade-500'
              : c.severity === 'warning' ? 'text-marigold-300' : 'text-rose-500'}`}>
              <Icon name={c.passed ? 'check' : 'alert'} className="w-3 h-3" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-mute-400 font-medium">{c.name.replace(/_/g, ' ')}</div>
              <div className="text-mute-500 leading-snug">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
