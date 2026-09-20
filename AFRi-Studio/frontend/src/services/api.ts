import type {
  Concept, Job, RefineRun, SystemInfo, UiSchema, Version, DesignConfig,
} from '../types'

const BASE = '/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.detail) detail = typeof body.detail === 'string'
        ? body.detail : JSON.stringify(body.detail)
    } catch { /* keep the status line */ }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

export const api = {
  system: () => req<SystemInfo>('/system'),
  schema: () => req<UiSchema>('/schema'),

  projects: () => req<{ projects: any[] }>('/projects'),
  project: (id: string) => req<any>(`/projects/${id}`),

  concepts: (includeArchived = false) =>
    req<{ concepts: Concept[] }>(`/concepts?include_archived=${includeArchived}`),
  concept: (id: string) =>
    req<{ concept: Concept; versions: Version[]; head: Version }>(`/concepts/${id}`),
  createConcept: (name: string, description = '', config?: DesignConfig) =>
    req<Concept>('/concepts', {
      method: 'POST', body: JSON.stringify({ name, description, config }),
    }),
  patchConcept: (id: string, patch: Record<string, any>) =>
    req<Concept>(`/concepts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  duplicateConcept: (id: string, name: string) =>
    req<Concept>(`/concepts/${id}/duplicate`, {
      method: 'POST', body: JSON.stringify({ name }),
    }),

  versions: (cid: string) => req<{ versions: Version[] }>(`/concepts/${cid}/versions`),
  version: (vid: string) => req<Version>(`/versions/${vid}`),
  createVersion: (cid: string, config: DesignConfig, description: string,
                  parentId?: string) =>
    req<Version>(`/concepts/${cid}/versions`, {
      method: 'POST',
      body: JSON.stringify({ config, description, parent_id: parentId }),
    }),
  diff: (a: string, b: string) => req<any>(`/versions/${a}/diff/${b}`),
  restore: (vid: string) => req<Version>(`/versions/${vid}/restore`, { method: 'POST' }),
  approve: (vid: string, approved: boolean) =>
    req<Version>(`/versions/${vid}/approve`, {
      method: 'POST', body: JSON.stringify({ approved }),
    }),
  prefer: (vid: string, preferred: boolean) =>
    req<Version>(`/versions/${vid}/prefer`, {
      method: 'POST', body: JSON.stringify({ preferred }),
    }),

  jobs: (limit = 60) => req<{ jobs: Job[] }>(`/jobs?limit=${limit}`),
  job: (id: string) => req<Job>(`/jobs/${id}`),
  createJob: (body: Record<string, any>) =>
    req<Job>('/jobs', { method: 'POST', body: JSON.stringify(body) }),
  cancelJob: (id: string) => req<Job>(`/jobs/${id}/cancel`, { method: 'POST' }),
  retryJob: (id: string) => req<Job>(`/jobs/${id}/retry`, { method: 'POST' }),

  assistantProviders: () => req<{ providers: any[] }>('/assistant/providers'),
  assistantHistory: (cid: string) =>
    req<{ messages: any[] }>(`/assistant/history?concept_id=${cid}`),
  assistantMessage: (concept_id: string, instruction: string, auto_run = true) =>
    req<any>('/assistant/message', {
      method: 'POST', body: JSON.stringify({ concept_id, instruction, auto_run }),
    }),
  assistantPrompt: (concept_id: string, instruction: string) =>
    req<{ system: string; user: string; combined: string }>('/assistant/prompt', {
      method: 'POST', body: JSON.stringify({ concept_id, instruction }),
    }),
  assistantManual: (concept_id: string, reply: string, instruction = '(manual)') =>
    req<any>('/assistant/manual', {
      method: 'POST', body: JSON.stringify({ concept_id, reply, instruction }),
    }),

  refineStart: (body: Record<string, any>) =>
    req<RefineRun>('/refine/start', { method: 'POST', body: JSON.stringify(body) }),
  refineStop: (id: string) => req<RefineRun>(`/refine/${id}/stop`, { method: 'POST' }),
  refineRuns: (cid?: string) =>
    req<{ runs: RefineRun[] }>(`/refine/runs${cid ? `?concept_id=${cid}` : ''}`),
  measure: (vid: string) =>
    req<{ measurements: Record<string, number> }>(`/refine/measure/${vid}`),

  exports: () => req<{ exports: any[] }>('/exports'),
  buildExport: (version_ids: string[], name: string) =>
    req<any>('/exports', { method: 'POST', body: JSON.stringify({ version_ids, name }) }),

  references: (cid?: string) =>
    req<{ references: any[] }>(`/references${cid ? `?concept_id=${cid}` : ''}`),

  assetUrl: (versionId: string, name: string) =>
    `${BASE}/assets/${versionId}/${name}`,
}
