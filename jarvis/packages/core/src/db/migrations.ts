export interface Migration { version: number; name: string; sql: string }

// Migration 1: event store, payloads, tasks, plan steps, checkpoints, actions,
// attempts, leases, evidence, artifacts, settings. Later modules add their own.
export const MIGRATIONS: Migration[] = [
  {
    version: 1, name: "core_tasks_events",
    sql: `
create table settings (key text primary key, value text not null, updated_at text not null);

create table events (
  seq integer primary key,                  -- per-node monotonic sequence (single node in v1)
  event_id text not null unique,
  type text not null,
  occurred_at text not null, recorded_at text not null,
  node_id text not null,
  source text not null,                     -- json
  correlation text not null,                -- json
  task_id text, action_id text,
  sensitivity text not null,
  summary text not null,
  data text not null,                       -- json (redacted)
  data_hash text not null,
  payload_ref text, payload_hash text,
  prev_hash text not null, hash text not null,
  redaction text not null default 'none'
);
create index events_task on events(task_id, seq);
create index events_type on events(type, seq);

create table payloads (
  payload_id text primary key,
  content_hash text not null,
  size_bytes integer not null,
  sensitivity text not null,
  encrypted integer not null,
  created_at text not null,
  deleted_at text
);

create table tasks (
  task_id text primary key,
  root_task_id text not null,
  parent_task_id text references tasks(task_id),
  revision integer not null,
  status text not null,
  wait_reason text,
  mode text not null,
  conversation_id text,
  contract text not null,                   -- json TaskContract (latest revision)
  created_at text not null, updated_at text not null,
  closed_at text
);
create index tasks_status on tasks(status);
create index tasks_parent on tasks(parent_task_id);

create table task_revisions (
  task_id text not null references tasks(task_id),
  revision integer not null,
  reason text not null,
  source_message_id text,
  patch text not null,                      -- json list of changes
  at text not null,
  primary key (task_id, revision)
);

create table plan_steps (
  step_id text primary key,
  task_id text not null references tasks(task_id),
  ordinal integer not null,
  status text not null,
  step text not null                        -- json PlanStep
);
create index plan_steps_task on plan_steps(task_id, ordinal);

create table checkpoints (
  checkpoint_id text primary key,
  task_id text not null references tasks(task_id),
  at text not null,
  data text not null                        -- json
);
create index checkpoints_task on checkpoints(task_id, at);

create table actions (
  action_id text primary key,
  task_id text not null references tasks(task_id),
  step_id text,
  capability text not null,
  state text not null,
  effects text not null,                    -- json EffectClass[]
  params_ref text,                          -- payload (raw params)
  resolved_params text,                     -- payload ref: resolved params, encrypted (SENSITIVE)
  fingerprint text,
  idempotency_key text not null unique,
  reconciliation_key text,
  preview text,
  decision_request_id text,
  grant_id text,
  task_revision integer not null,
  policy_revision integer,
  reason text,
  compensates_action_id text references actions(action_id),
  created_at text not null, updated_at text not null
);
create index actions_task on actions(task_id);
create index actions_state on actions(state);

create table action_attempts (
  attempt_id text primary key,
  action_id text not null references actions(action_id),
  n integer not null,
  idempotency_key text not null,
  state text not null,                      -- dispatched | acknowledged | uncertain | failed_no_effect | effect_observed
  sent_at text not null,
  response text,                            -- json summary
  unique (action_id, n)
);

create table leases (
  lease_id text primary key,
  resource text not null,
  mode text not null,
  holder text not null,                     -- json
  task_id text not null,
  process_instance text not null,
  fencing_token integer not null,
  acquired_at text not null, expires_at text not null, heartbeat_at text not null,
  state text not null,
  revoked_reason text
);
create index leases_resource on leases(resource, state);
create table lease_tokens (resource text primary key, last_token integer not null);
create table lease_queue (
  queue_id integer primary key autoincrement,
  resource text not null, mode text not null, task_id text not null,
  requested_at text not null, state text not null   -- waiting | granted | cancelled
);

create table evidence (
  evidence_id text primary key,
  task_id text not null,
  action_id text, criterion_id text,
  type text not null, strength text not null,
  record text not null                      -- json EvidenceRecord
);
create index evidence_task on evidence(task_id);

create table artifacts (
  artifact_id text primary key,
  content_hash text not null,
  record text not null                      -- json ArtifactRef
);
`,
  },
];
