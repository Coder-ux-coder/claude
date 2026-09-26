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
  {
    version: 2, name: "memory",
    sql: `
create table owner_profile (owner_id text primary key, revision integer not null, profile text not null, updated_at text not null);

create table memory_records (
  id text primary key,
  type text not null,
  status text not null,
  canonical_key text not null,              -- subjects + predicate/domain + scope (03 §9.11 dedup)
  domain text,                              -- predicate (fact) or domain (preference)
  scope_level text not null,
  project_id text, task_id text,
  sensitivity text not null,
  valid_from text, valid_until text, expires_at text,
  revision integer not null,
  updated_at text not null,
  record text not null                      -- json MemoryRecord; sensitive/restricted text+content sealed (AES-256-GCM); purged when deleted
);
create index memory_key on memory_records(canonical_key, status);
create index memory_domain on memory_records(domain, status);
create table memory_scope_entities (record_id text not null references memory_records(id), entity_id text not null, primary key (record_id, entity_id));
create index memory_scope_entity on memory_scope_entities(entity_id);
create table memory_subjects (record_id text not null references memory_records(id), entity_id text not null, primary key (record_id, entity_id));
create virtual table memory_fts using fts5(text, record_id unindexed, tokenize = 'unicode61 remove_diacritics 2');

create table entities (id text primary key, kind text not null, status text not null, revision integer not null, entity text not null);
create table entity_names (entity_id text not null references entities(id), value text not null, norm text not null, kind text not null);
create index entity_names_norm on entity_names(norm);
create table entity_identifiers (entity_id text not null references entities(id), system text not null, value text not null, norm text not null);
create index entity_identifiers_norm on entity_identifiers(system, norm);
create table relationships (id text primary key, from_entity_id text not null, to_entity_id text not null, type text not null, status text not null, relationship text not null);
create index rel_from on relationships(from_entity_id, type, status);
create index rel_to on relationships(to_entity_id, type, status);

create table projects (id text primary key, status text not null, name text not null, project text not null);
create table commitments (id text primary key, status text not null, project_id text, commitment text not null);
create table commitment_parties (commitment_id text not null, entity_id text not null);

create table conversations (id text primary key, channel text not null, started_at text not null, last_message_at text not null, conversation text not null);
create table messages (id text primary key, conversation_id text not null references conversations(id), author text not null, trust text not null, created_at text not null, message text not null);
create index messages_conv on messages(conversation_id, created_at);

create table experiences (id text primary key, task_id text not null, goal_class text not null, outcome text not null, created_at text not null, experience text not null);
create virtual table experience_fts using fts5(goal_class, summary, experience_id unindexed);

create table memory_corrections (id text primary key, applied_at text not null, correction text not null);
create table derived_summaries (id text primary key, kind text not null, subject_ref text not null, state text not null, summary text not null);
create table summary_inputs (summary_id text not null references derived_summaries(id), record_id text not null, revision integer not null);
create index summary_inputs_record on summary_inputs(record_id);
create table memory_proposals (proposal_id text primary key, status text not null, error text, created_at text not null, proposal text not null);
create table task_working_state (task_id text not null, key text not null, value text not null, expires_at text, primary key (task_id, key));
`,
  },
  {
    version: 3, name: "policy_registry_broker",
    sql: `
create table rules (rule_id text primary key, revision integer not null, status text not null, kind text not null, protection text not null, rule text not null);
create table rule_history (rule_id text not null, revision integer not null, rule text not null, at text not null, primary key (rule_id, revision));
create table policy_revisions (revision integer primary key, at text not null, source text not null, change text not null);
create table rule_usage (rule_id text not null, action_id text not null, amount real, currency text, at text not null);
create index rule_usage_rule on rule_usage(rule_id, at);

create table decision_requests (id text primary key, task_id text not null, status text not null, option_id text, responded_at text, request text not null);
create index decision_requests_task on decision_requests(task_id, status);
create table grants (decision_id text primary key, action_id text not null, task_id text not null, used integer not null default 0, decision text not null);
create index grants_action on grants(action_id);

create table capabilities (id text not null, version text not null, lifecycle text not null, admin_state text not null, descriptor text not null, registered_at text not null, primary key (id, version));
create virtual table capability_fts using fts5(title, purpose, goals, cap_key unindexed);
create table capability_health (capability_id text not null, node_id text not null, account_id text not null default '', state text not null, health text not null, primary key (capability_id, node_id, account_id));
create table capability_outcomes (capability_id text not null, account_id text not null default '', ok integer not null, error_code text, goal_class text, at text not null);
create index capability_outcomes_cap on capability_outcomes(capability_id, at);
create table service_policies (service text primary key, policy text not null);

create table invocations (invocation_id text primary key, capability text not null, status text not null, task_id text, action_id text, record text not null);
create table accounts (account_id text primary key, connector text not null, status text not null, record text not null);
create table reconciliation_queue (action_id text primary key, next_at text not null, attempt integer not null, window_ends_at text not null, state text not null);
create table broker_pending (action_id text primary key, request_ref text not null, created_at text not null);
`,
  },
  {
    version: 4, name: "models_budgets",
    sql: `
create table budgets (budget_id text primary key, level text not null, ref text, budget text not null);
create table usage_ledger (use_id text primary key, provider text not null, adapter text not null, role text not null, task_id text, work_order_id text,
  amount real, currency text, kind text not null, at text not null, entry text not null);
create index usage_ledger_at on usage_ledger(at);
create index usage_ledger_task on usage_ledger(task_id);
create table budget_alerts (budget_id text not null, period_key text not null, threshold real not null, at text not null, primary key (budget_id, period_key, threshold));
`,
  },
  {
    version: 5, name: "scheduler_notifications",
    sql: `
create table schedules (schedule_id text primary key, kind text not null, status text not null, next_fire_utc text, search_from_utc integer not null default 0, job text not null);
create index schedules_next on schedules(status, next_fire_utc);
create table schedule_fires (fire_id text primary key, schedule_id text not null, scheduled_local text not null, scheduled_utc text not null,
  fired_at text not null, outcome text not null, missed integer not null default 0);
create index schedule_fires_sched on schedule_fires(schedule_id, scheduled_utc);
create table notifications (id text primary key, kind text not null, status text not null, dedupe_key text, created_at text not null, delivered_at text, record text not null);
create index notifications_status on notifications(status, created_at);
`,
  },
];
