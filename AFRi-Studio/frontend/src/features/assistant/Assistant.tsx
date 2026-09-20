import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { api } from '../../services/api'
import { Icon, Empty, Spinner, Banner, StatusDot } from '../../components/ui'

const SUGGESTIONS = [
  'Make the flower fuller',
  'Make the petals more realistic',
  'Strengthen the S-curve of the split',
  'Move the dividing line to the right',
  'Make both pieces more balanced',
  'Show the two pieces separately',
  'Create three variations of this concept',
  'Render the current flower from above',
]

export function Assistant() {
  const conceptId = useStore((s) => s.activeConceptId)
  const system = useStore((s) => s.system)
  const refreshConcepts = useStore((s) => s.refreshConcepts)
  const selectConcept = useStore((s) => s.selectConcept)
  const [messages, setMessages] = useState<any[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState<{ prompt: string; reply: string } | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const provider = system?.ai_providers?.find((p) => p.available)
  const isManual = !provider || provider.kind === 'manual'

  useEffect(() => {
    if (!conceptId) return
    api.assistantHistory(conceptId).then((r) => setMessages(r.messages)).catch(() => {})
  }, [conceptId])

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function send(instruction: string) {
    if (!conceptId || !instruction.trim() || busy) return
    setBusy(true)
    setMessages((m) => [...m, { id: `tmp${Date.now()}`, role: 'user', content: instruction }])
    setText('')
    try {
      if (isManual) {
        const p = await api.assistantPrompt(conceptId, instruction)
        setManual({ prompt: p.combined, reply: '' })
      } else {
        const r = await api.assistantMessage(conceptId, instruction)
        setMessages((m) => [...m, {
          id: `r${Date.now()}`, role: 'assistant', content: r.summary,
          commands: r.commands, provider: r.provider,
          status: r.rejected?.length ? 'partial' : 'ok',
        }])
        await refreshConcepts()
        await selectConcept(conceptId)
      }
    } catch (e: any) {
      setMessages((m) => [...m, {
        id: `e${Date.now()}`, role: 'assistant', status: 'error',
        content: `That instruction could not be carried out: ${e.message}`,
      }])
    } finally { setBusy(false) }
  }

  async function submitManual() {
    if (!conceptId || !manual?.reply.trim()) return
    setBusy(true)
    try {
      const r = await api.assistantManual(conceptId, manual.reply)
      setMessages((m) => [...m, {
        id: `r${Date.now()}`, role: 'assistant', content: r.summary,
        commands: r.commands, provider: 'manual_handoff',
      }])
      setManual(null)
      await refreshConcepts(); await selectConcept(conceptId)
    } catch (e: any) {
      setMessages((m) => [...m, { id: `e${Date.now()}`, role: 'assistant',
        status: 'error', content: e.message }])
    } finally { setBusy(false) }
  }

  if (!conceptId) {
    return <Empty icon="chat" title="No concept selected"
                  hint="Select a concept to talk to the design assistant." />
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 h-7 border-b border-ink-700 shrink-0">
        <StatusDot status={provider?.available ? 'ok' : 'error'} />
        <span className="text-2xs text-mute-500 truncate">
          {provider ? provider.detail : 'no AI provider available'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-2">
        {!messages.length && (
          <div className="space-y-2">
            <p className="text-2xs text-mute-500 leading-relaxed px-1">
              Describe a change in plain language. Instructions become validated
              design commands that modify the real configuration and queue real
              Blender jobs — nothing here is a mock-up reply.
            </p>
            <div className="flex flex-wrap gap-1">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}
                        className="px-2 h-6 rounded-md bg-ink-800 border border-ink-700
                                   text-2xs text-mute-400 hover:border-marigold-400/40
                                   hover:text-marigold-300 transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`animate-fade-in ${m.role === 'user' ? 'pl-6' : 'pr-6'}`}>
            <div className={`px-2.5 py-1.5 rounded-lg text-2xs leading-relaxed whitespace-pre-wrap
              ${m.role === 'user'
                ? 'bg-marigold-400/12 border border-marigold-400/25 text-marigold-200'
                : m.status === 'error'
                  ? 'bg-rose-500/10 border border-rose-500/25 text-rose-400'
                  : 'bg-ink-800 border border-ink-700 text-mute-300'}`}>
              {m.content}
            </div>
            {!!m.commands?.length && (
              <div className="flex flex-wrap gap-1 mt-1">
                {m.commands.map((c: any, i: number) => (
                  <span key={i} className="chip font-mono">
                    {c.type}{c.parameter ? `: ${c.parameter}=${c.value}` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 text-2xs text-mute-500 px-2">
            <Spinner className="w-3 h-3" /> interpreting…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {manual && (
        <div className="border-t border-ink-700 p-2 space-y-1.5 shrink-0 max-h-72 overflow-y-auto">
          <Banner kind="info">
            No automatic AI provider is available, so this is the manual handoff.
            Copy the prompt into any assistant you already use, then paste its
            JSON reply below. The reply goes through exactly the same validation.
          </Banner>
          <div className="flex gap-1">
            <button className="btn-sub flex-1"
                    onClick={() => navigator.clipboard?.writeText(manual.prompt)}>
              <Icon name="copy" /> Copy prompt
            </button>
            <button className="btn-ghost" onClick={() => setManual(null)}>
              <Icon name="x" /> Cancel
            </button>
          </div>
          <textarea value={manual.reply} rows={4}
                    onChange={(e) => setManual({ ...manual, reply: e.target.value })}
                    placeholder='Paste the JSON reply here, e.g. {"explanation":"...","commands":[...]}'
                    className="w-full input h-auto py-1.5 font-mono resize-y" />
          <button className="btn-primary w-full" disabled={busy || !manual.reply.trim()}
                  onClick={submitManual}>
            <Icon name="check" /> Apply pasted plan
          </button>
        </div>
      )}

      <div className="border-t border-ink-700 p-2 shrink-0">
        <div className="flex gap-1.5">
          <input value={text} onChange={(e) => setText(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(text) }}
                 disabled={busy}
                 placeholder="Make the flower fuller…"
                 className="input flex-1 h-7" />
          <button className="btn-primary" disabled={busy || !text.trim()}
                  onClick={() => send(text)}>
            <Icon name="chat" /> Send
          </button>
        </div>
      </div>
    </div>
  )
}
