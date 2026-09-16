export type JobStatus = 'queued' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Job {
  id: string; type: string; status: JobStatus; stage: string; message: string
  concept_id: string | null; version_id: string | null
  progress_index: number; progress_total: number
  created_at: number; started_at: number | null; finished_at: number | null
  error: string; outputs: Record<string, string>; logs?: string[]
  spec?: any
}

export interface ValidationCheck {
  name: string; passed: boolean; detail: string
  value: any; tolerance: number | null; severity: string
}
export interface Validation {
  checks: ValidationCheck[]; passed: number; total: number
  errors: number; warnings: number; ok: boolean; seconds: number
  measurements: Record<string, number>
}

export interface Version {
  id: string; concept_id: string; parent_id: string | null; number: number
  config: DesignConfig; description: string; author: string
  validation: Validation | Record<string, never>
  stats: Record<string, any>; assets: Record<string, string>
  preferred: number; approved: number; hypothesis: string; created_at: number
}

export interface Concept {
  id: string; project_id: string; name: string; description: string
  split_type: string; archived: number; head_version: string | null
  created_at: number; updated_at: number
  head?: Version | null; version_count?: number
}

export interface DesignConfig {
  flower: Record<string, any>
  split: Record<string, any>
  material: Record<string, any>
  render: Record<string, any>
}

export interface SchemaField {
  name: string; kind: 'number' | 'int' | 'enum' | 'bool' | 'color' | 'text' | 'curve_points'
  default: any; choices: string[] | null
  min: number | null; max: number | null; step: number | null
  unit: string; description: string; group: string
}
export interface UiSchema {
  engine_version: string
  sections: Record<'flower' | 'split' | 'material' | 'render', SchemaField[]>
}

export interface SystemInfo {
  app: string; version: string; stage: string; os: string; python: string
  cpu_count: number; machine: string
  ram_total_gb: number | null; ram_available_gb: number | null; disk_free_gb: number
  blender: { available: boolean; path: string | null; version: string | null
             error: string | null; engines: string[]; note: string }
  ai_providers: { name: string; kind: string; available: boolean
                  detail: string; supports_vision: boolean; extra: any }[]
  max_concurrent_jobs: number
  hat_stage_two_started: boolean
}

export interface Milestone { key: string; label: string; done: boolean; detail: string }

export interface AppEvent {
  seq: number; ts: string; type: string; job_id: string | null; payload: any
}

export interface RefineRun {
  id: string; concept_id: string; status: string
  config: { max_iterations: number; max_seconds: number; render_each: boolean }
  iterations: any[]; stop_reason: string; created_at: number; finished_at: number | null
}
