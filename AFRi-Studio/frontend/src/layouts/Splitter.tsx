import React, { useCallback, useEffect, useRef, useState } from 'react'

/** A draggable divider. Sizes persist per id so layout survives a reload. */
export function Splitter({ dir, size, min, max, onResize, invert = false }: {
  dir: 'horizontal' | 'vertical'
  size: number; min: number; max: number
  onResize: (n: number) => void
  /** True when the panel sits after the divider, so dragging toward it shrinks it. */
  invert?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const start = useRef({ pos: 0, size: 0 })

  const onMove = useCallback((e: MouseEvent) => {
    const raw = (dir === 'horizontal' ? e.clientX : e.clientY) - start.current.pos
    const delta = invert ? -raw : raw
    const next = Math.max(min, Math.min(max, start.current.size + delta))
    onResize(next)
  }, [dir, min, max, onResize, invert])

  const onUp = useCallback(() => setDragging(false), [])

  useEffect(() => {
    if (!dragging) return
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = dir === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging, onMove, onUp, dir])

  return (
    <div
      onMouseDown={(e) => {
        start.current = { pos: dir === 'horizontal' ? e.clientX : e.clientY, size }
        setDragging(true)
      }}
      className={`shrink-0 transition-colors ${
        dir === 'horizontal'
          ? 'w-1 cursor-col-resize hover:bg-marigold-400/40'
          : 'h-1 cursor-row-resize hover:bg-marigold-400/40'
      } ${dragging ? 'bg-marigold-400/60' : 'bg-ink-800'}`}
    />
  )
}
