import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { Empty } from '../../components/ui'

export function EventLog() {
  const events = useStore((s) => s.events)
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (follow) endRef.current?.scrollIntoView() }, [events, follow])

  const shown = events.filter((e) =>
    !filter || JSON.stringify(e).toLowerCase().includes(filter.toLowerCase()))

  const colour = (t: string) =>
    t.includes('failed') ? 'text-rose-400'
    : t.includes('completed') ? 'text-jade-400'
    : t.includes('stage') ? 'text-mute-400'
    : t.startsWith('refine') ? 'text-sky-400' : 'text-marigold-300'

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-2 h-7 border-b border-ink-700 shrink-0">
        <input value={filter} onChange={(e) => setFilter(e.target.value)}
               placeholder="filter events…" className="input flex-1 h-5" />
        <label className="flex items-center gap-1 text-2xs text-mute-500 shrink-0">
          <input type="checkbox" checked={follow}
                 onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
        <span className="text-2xs text-mute-500 shrink-0">{shown.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 font-mono text-2xs p-1">
        {!shown.length && <Empty icon="doc" title="No events yet"
          hint="Backend events stream here live over SSE as work actually happens." />}
        {shown.map((e) => (
          <div key={e.seq} className="flex gap-2 px-1 py-px hover:bg-ink-800/50">
            <span className="text-ink-400 shrink-0">{e.ts.slice(11, 23)}</span>
            <span className={`${colour(e.type)} w-28 shrink-0 truncate`}>{e.type}</span>
            <span className="text-mute-500 truncate">
              {e.payload?.stage ? `[${e.payload.stage}] ` : ''}
              {e.payload?.message ?? JSON.stringify(e.payload).slice(0, 160)}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}
