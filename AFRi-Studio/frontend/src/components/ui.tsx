import React from 'react'

export function Icon({ name, className = 'w-3.5 h-3.5' }:
  { name: string; className?: string }) {
  const paths: Record<string, React.ReactNode> = {
    play: <path d="M5 3l14 9-14 9V3z" />,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
    refresh: <><path d="M21 12a9 9 0 11-3-6.7" /><path d="M21 3v6h-6" /></>,
    check: <path d="M20 6L9 17l-5-5" />,
    x: <><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>,
    alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></>,
    layers: <><path d="M12 2l9 5-9 5-9-5 9-5z" /><path d="M3 12l9 5 9-5" /><path d="M3 17l9 5 9-5" /></>,
    cube: <><path d="M12 2l9 5v10l-9 5-9-5V7l9-5z" /><path d="M12 12l9-5M12 12v10M12 12L3 7" /></>,
    sliders: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="7" cy="18" r="2" /></>,
    chat: <path d="M21 11.5a8.4 8.4 0 01-9 8.4 8.4 8.4 0 01-3.8-.9L3 21l2-4.9A8.4 8.4 0 0112 3a8.4 8.4 0 019 8.5z" />,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    history: <><path d="M3 12a9 9 0 103-6.7" /><path d="M3 3v6h6" /><path d="M12 7v5l3 2" /></>,
    download: <><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 21h16" /></>,
    gauge: <><path d="M12 14l4-4" /><circle cx="12" cy="14" r="9" /><path d="M5 14a7 7 0 0114 0" /></>,
    copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" /></>,
    star: <path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.8l6.5-.9L12 3z" />,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 118 0v3" /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>,
    camera: <><path d="M3 8h3l2-3h8l2 3h3v12H3V8z" /><circle cx="12" cy="13" r="4" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v11h14V9" /><path d="M10 13h4" /></>,
    doc: <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" /><path d="M14 3v5h5" /></>,
    split: <><path d="M6 3v6a3 3 0 003 3h6a3 3 0 013 3v6" /><path d="M18 3v6" /></>,
    flask: <><path d="M9 3v6l-5 9a2 2 0 002 3h12a2 2 0 002-3l-5-9V3" /><path d="M8 3h8" /></>,
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" className={className}>
      {paths[name] ?? null}
    </svg>
  )
}

export function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: 'bg-marigold-400 animate-pulse-soft', claimed: 'bg-marigold-400 animate-pulse-soft',
    queued: 'bg-sky-500', completed: 'bg-jade-500', failed: 'bg-rose-500',
    cancelled: 'bg-mute-500', ok: 'bg-jade-500', error: 'bg-rose-500',
  }
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${map[status] ?? 'bg-ink-500'}`} />
}

export function Empty({ icon = 'cube', title, hint, action }:
  { icon?: string; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 p-6 text-center animate-fade-in">
      <div className="w-10 h-10 rounded-lg bg-ink-800 border border-ink-700 grid place-items-center text-ink-500">
        <Icon name={icon} className="w-5 h-5" />
      </div>
      <div className="text-xs font-medium text-mute-400">{title}</div>
      {hint && <div className="text-2xs text-mute-500 max-w-xs leading-relaxed">{hint}</div>}
      {action}
    </div>
  )
}

export function Spinner({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3"
            strokeLinecap="round" />
    </svg>
  )
}

export function Bar({ value, total, className = '' }:
  { value: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className={`h-1 rounded-full bg-ink-700 overflow-hidden ${className}`}>
      <div className="h-full bg-marigold-400 transition-all duration-300"
           style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Tabs<T extends string>({ tabs, active, onChange }:
  { tabs: { id: T; label: string; badge?: number }[]; active: T; onChange: (t: T) => void }) {
  return (
    <div className="flex items-center border-b border-ink-700 shrink-0 overflow-x-auto">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)}
                className={`tab whitespace-nowrap ${active === t.id ? 'tab-active' : ''}`}>
          {t.label}
          {t.badge != null && t.badge > 0 && (
            <span className="ml-1.5 px-1 rounded bg-ink-700 text-2xs">{t.badge}</span>
          )}
        </button>
      ))}
    </div>
  )
}

export function Banner({ kind, children, onClose }:
  { kind: 'info' | 'warn' | 'error'; children: React.ReactNode; onClose?: () => void }) {
  const styles = {
    info: 'bg-sky-500/10 border-sky-500/30 text-sky-400',
    warn: 'bg-marigold-400/10 border-marigold-400/30 text-marigold-300',
    error: 'bg-rose-500/10 border-rose-500/30 text-rose-400',
  }[kind]
  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-md border text-2xs leading-relaxed ${styles}`}>
      <Icon name={kind === 'error' ? 'alert' : kind === 'warn' ? 'alert' : 'doc'}
            className="w-3.5 h-3.5 mt-px shrink-0" />
      <div className="flex-1">{children}</div>
      {onClose && (
        <button onClick={onClose} className="opacity-60 hover:opacity-100 shrink-0">
          <Icon name="x" className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}
