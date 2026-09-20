import { create } from 'zustand'
import { api } from '../services/api'
import type {
  AppEvent, Concept, Job, RefineRun, SystemInfo, UiSchema, Version, DesignConfig,
} from '../types'

const PREFS_KEY = 'afri.prefs.v1'

function loadPrefs(): Record<string, any> {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } catch { return {} }
}
function savePrefs(p: Record<string, any>) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* private mode */ }
}

interface State {
  system: SystemInfo | null
  schema: UiSchema | null
  concepts: Concept[]
  activeConceptId: string | null
  versions: Version[]
  activeVersionId: string | null
  draft: DesignConfig | null
  dirty: boolean
  jobs: Job[]
  events: AppEvent[]
  milestones: any[]
  refineRuns: RefineRun[]
  connected: boolean
  error: string | null
  prefs: Record<string, any>

  boot: () => Promise<void>
  refreshConcepts: () => Promise<void>
  selectConcept: (id: string) => Promise<void>
  selectVersion: (id: string) => Promise<void>
  setDraft: (section: string, key: string, value: any) => void
  resetDraft: () => void
  commitDraft: (description: string) => Promise<Version | null>
  refreshJobs: () => Promise<void>
  refreshMilestones: () => Promise<void>
  refreshRefine: () => Promise<void>
  connect: () => void
  setPref: (k: string, v: any) => void
  setError: (e: string | null) => void
}

export const useStore = create<State>((set, get) => ({
  system: null, schema: null, concepts: [], activeConceptId: null,
  versions: [], activeVersionId: null, draft: null, dirty: false,
  jobs: [], events: [], milestones: [], refineRuns: [],
  connected: false, error: null, prefs: loadPrefs(),

  setError: (e) => set({ error: e }),
  setPref: (k, v) => {
    const prefs = { ...get().prefs, [k]: v }
    savePrefs(prefs)
    set({ prefs })
  },

  boot: async () => {
    try {
      const [system, schema] = await Promise.all([api.system(), api.schema()])
      set({ system, schema })
      await get().refreshConcepts()
      await get().refreshJobs()
      await get().refreshMilestones()
      const { concepts, prefs } = get()
      const want = prefs.activeConceptId &&
        concepts.find((c) => c.id === prefs.activeConceptId)
      const first = want ? prefs.activeConceptId : concepts[0]?.id
      if (first) await get().selectConcept(first)
      get().connect()
    } catch (e: any) {
      set({ error: `Could not reach the backend: ${e.message}` })
    }
  },

  refreshConcepts: async () => {
    const { concepts } = await api.concepts(true)
    set({ concepts })
  },

  selectConcept: async (id) => {
    set({ activeConceptId: id })
    get().setPref('activeConceptId', id)
    try {
      const { versions, head } = await api.concept(id)
      set({ versions, activeVersionId: head?.id ?? null,
            draft: head ? JSON.parse(JSON.stringify(head.config)) : null,
            dirty: false })
      get().refreshRefine()
    } catch (e: any) { set({ error: e.message }) }
  },

  selectVersion: async (id) => {
    const v = get().versions.find((x) => x.id === id) || await api.version(id)
    set({ activeVersionId: id, draft: JSON.parse(JSON.stringify(v.config)),
          dirty: false })
  },

  setDraft: (section, key, value) => {
    const draft = get().draft
    if (!draft) return
    const next = { ...draft, [section]: { ...(draft as any)[section], [key]: value } }
    set({ draft: next as DesignConfig, dirty: true })
  },

  resetDraft: () => {
    const v = get().versions.find((x) => x.id === get().activeVersionId)
    if (v) set({ draft: JSON.parse(JSON.stringify(v.config)), dirty: false })
  },

  commitDraft: async (description) => {
    const { activeConceptId, draft, activeVersionId } = get()
    if (!activeConceptId || !draft) return null
    try {
      const v = await api.createVersion(activeConceptId, draft, description,
                                        activeVersionId || undefined)
      const { versions } = await api.versions(activeConceptId)
      set({ versions, activeVersionId: v.id, dirty: false })
      await get().refreshConcepts()
      return v
    } catch (e: any) { set({ error: e.message }); return null }
  },

  refreshJobs: async () => {
    try { set({ jobs: (await api.jobs()).jobs }) } catch { /* transient */ }
  },
  refreshMilestones: async () => {
    try {
      const { projects } = await api.projects()
      if (!projects[0]) return
      const p = await api.project(projects[0].id)
      set({ milestones: p.milestones })
    } catch { /* transient */ }
  },
  refreshRefine: async () => {
    const cid = get().activeConceptId
    if (!cid) return
    try { set({ refineRuns: (await api.refineRuns(cid)).runs }) } catch { /* transient */ }
  },

  connect: () => {
    const src = new EventSource('/api/events')
    src.onopen = () => set({ connected: true })
    src.onerror = () => set({ connected: false })
    src.onmessage = (m) => {
      let ev: AppEvent
      try { ev = JSON.parse(m.data) } catch { return }
      set((s) => ({ events: [...s.events.slice(-299), ev] }))
      if (ev.type.startsWith('job.')) {
        get().refreshJobs()
        if (['job.completed', 'job.failed', 'job.cancelled'].includes(ev.type)) {
          const cid = get().activeConceptId
          if (cid) {
            api.versions(cid).then(({ versions }) => set({ versions })).catch(() => {})
            get().refreshConcepts()
            get().refreshMilestones()
          }
        }
      }
      if (ev.type.startsWith('refine.')) get().refreshRefine()
    }
  },
}))

export const activeVersion = (s: State) =>
  s.versions.find((v) => v.id === s.activeVersionId) || null
export const activeConcept = (s: State) =>
  s.concepts.find((c) => c.id === s.activeConceptId) || null
export const runningJob = (s: State) =>
  s.jobs.find((j) => j.status === 'running' || j.status === 'claimed') || null
