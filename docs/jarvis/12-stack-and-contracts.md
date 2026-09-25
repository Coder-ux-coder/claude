# 12 · Technical Stack, Repository Design, and Integration Contracts

Deliverable 17. It also covers brief §42 and §43. The repository tree below is a **design artifact only**: nothing has been scaffolded.

---

# 17. Stack, repository, and contracts

## 17.1 Primary stack

**Two core languages: TypeScript and C#.** Python appears only inside sandboxed, generated tools.

| Layer | Choice | Job | Why it fits the first release | Deployment complexity | Licensing or access to verify | Replacement boundary |
|---|---|---|---|---|---|---|
| Orchestration | **TypeScript on Node.js** (current LTS at M0) | Coordinator, Browser Runtime, MCP Gateway | First-class SDKs: Codex SDK (TypeScript) [V], Claude Agent SDK (TypeScript) [V], Anthropic SDK, Playwright (native), MCP TypeScript SDK. Shared types with the UI. Async I/O suits event-driven orchestration. | Node runtime bundled with the app. Native-module ABI for the SQLite binding. | Node LTS schedule | Module interfaces and JSON-RPC contracts are language-neutral |
| Desktop shell | **Electron + React** | Console: UI, tray, microphone, speech playback | TypeScript end to end. Tray, shortcuts, notifications. The web UI is reusable for a later phone PWA or web client. | Roughly 150–300 MB footprint [I]. Hardening required: `contextIsolation`, sandboxed renderer, no Node integration in the renderer. | Electron support window, code signing | Only the UI↔Coordinator contract, so it could be replaced by a Tauri or .NET WebView2 host |
| Native Windows | **C# on .NET** (LTS) | Session Agent, Exec Host, Launcher and Update Supervisor. Later the Guard and Elevated Helper. | UI Automation (for example through the FlaUI library [I]), Windows.Graphics.Capture, Windows.Media.Ocr, `SendInput`, session and power notifications, Job Objects, DPAPI, Task Scheduler COM, and Windows services are all first-class in .NET | Self-contained publish per helper | FlaUI license (MIT [I]), .NET LTS dates | NEP over named pipes |
| Database | **SQLite** in WAL mode, through a maintained Node binding (for example better-sqlite3 [I], or Node's built-in `node:sqlite` if stable at M0 [U]) with FTS5 | All durable state | Embedded, transactional, zero operations, single-file backups | None beyond the binding | FTS5 compiled in. SQLCipher if full-database encryption is wanted. | A repository layer per module, SQL migrations, portable export |
| Semantic retrieval (M3, optional) | **sqlite-vec** [V-S] plus a local embedding model through ONNX Runtime [I] | Paraphrase recall for experiences, skills, conversations | Stays in the same database file and transaction | Native extension load | MIT/Apache-2.0 [V-S]. Embedding model license [U]. | Embedding adapter. Degrades to FTS. |
| Browser automation | **Playwright** (Node) with installed Chrome or Edge, persistent contexts per JARVIS profile | Browser Runtime | The most capable structured automation, with accessibility snapshots and auto-waiting | Browser version compatibility | Apache-2.0 [I]. Version-support policy. | Browser Runtime NEP commands |
| Contracts | **JSON Schema 2020-12** as canonical. Generated TypeScript types plus runtime validators, and generated C# types. | Every interface in §17.6 | Language-neutral. Doubles as model structured-output schemas and MCP tool schemas. | Codegen step in the build | — | The `schemas/` directory |
| IPC | JSON-RPC 2.0 over named pipes, stdio for child processes, MCP for workers, WSS in M7 | All process boundaries | One protocol family | Minimal | MCP spec revision supported by Codex and Claude Code [U] | Transport adapters |
| Scheduling | In-house on SQLite, an RFC 5545 RRULE library, the IANA timezone database through ICU/`Intl` or a timezone library [I]. Wake timers through Task Scheduler COM (Exec Host). | Alarms, reminders, schedules, monitors | Deterministic, auditable, testable with a simulated clock | None | Library licenses | Scheduler module API |
| Model and worker adapters | Anthropic TypeScript SDK. Codex app-server client (types generated from its schema) or `@openai/codex-sdk`. Claude Code CLI or Agent SDK. | [06](06-connectors-providers-budgets.md) | Official surfaces only | CLI installs inside the Workshop | Terms per [06 §11.16](06-connectors-providers-budgets.md#1116-subscriptions-versus-api-billing) | Adapter contract ([06 §11.15](06-connectors-providers-budgets.md#1115-the-common-adapter-contract)) |
| Speech | Local whisper.cpp-family speech-to-text [I]. Windows voices for speech output. Optional cloud adapters. | Voice | Offline, private, no per-use cost | Model download (hash-pinned) | Model and runtime licenses [U] | STT and TTS adapters |
| Workshop | WSL2 distro (a Linux LTS base image [I]), git worktrees, `uv` for Python, `pnpm` or `npm` for Node, Windows Sandbox (`wsb`) where available | Isolated development | Real OS boundary. Matches both coding CLIs' sandboxes. | WSL enablement, base image build | Edition limits ([08 §13.3](08-workshop-and-release.md#133-isolation-options)) | Workshop Manager API |
| Packaging and updates | v1: a per-user installer with side-by-side versions managed by the Launcher. M6: a machine-wide installer with services. | Install and update | Keeps the Update Supervisor outside the core, rather than inside a framework auto-updater | Code-signing certificate | Signing certificate provider and cost [U]. Installer tooling [U]. | Launcher update protocol |
| Observability | Redacted JSON-lines logs, the Event Store, optional local OpenTelemetry export [I] | Traces, metrics, troubleshooting | Local-first | None | — | Event schema |

## 17.2 A limited alternative

**Python orchestration** (asyncio), with the same .NET helpers and a web UI in a .NET WebView2 or Tauri host.

- **Choose it if** heavy local ML or document processing becomes central, or the implementing engineer is strongly Python-first.
- **Costs.** Three languages (Python, C#, TypeScript for the UI). Harder Windows packaging. The Codex SDK is TypeScript-first (Python availability [U]). Shared UI types are lost.
- **What is preserved.** Every contract in §17.6. The migration cost is per module, not a redesign.

## 17.3 Deliberately not used

| Not used | Why not now | Revisit when |
|---|---|---|
| Vector database | `sqlite-vec` covers personal scale inside the same transaction | Tens of millions of vectors, or multi-user use |
| Message broker | In-process events plus a SQLite outbox are enough on one machine | A multi-node cloud coordinator (M7+) |
| Kubernetes or containers for the core | A single-user desktop app | Cloud coordinator hosting |
| Graph database | Relational tables with recursive CTEs answer the real queries ([03 §9.8](03-memory.md#98-entities-and-relationships-the-queries-they-enable)) | Never, probably |
| A durable-workflow platform | A custom state machine fits and keeps policy hooks exact | A cloud coordinator with many nodes |
| Agent frameworks | Thin adapters keep policy and evidence boundaries under JARVIS's control | — |

## 17.4 Repository tree (design artifact; not created)

```text
jarvis/
├─ README.md
├─ docs/                              # this specification, ADRs, runbooks, threat model
├─ schemas/                           # canonical JSON Schemas (contracts) + codegen config + CHANGELOG
│  └─ task/ memory/ policy/ capability/ skill/ schedule/ event/ device/ worker/ nep/ ui/
├─ packages/                          # TypeScript workspace
│  ├─ core/                           # jarvis-core (Coordinator)
│  │  └─ src/
│  │     ├─ boss/                     # conversation, interpreter, contract builder, planner, delegation, reporter, persona
│  │     ├─ tasks/                    # task engine, state machines, actions, leases, checkpoints, recovery
│  │     ├─ scheduler/                # schedules, recurrence, missed runs, monitors, wake requests
│  │     ├─ memory/                   # memory service, write pipeline, corrections, deletion, export/import
│  │     ├─ context/                  # context builder, egress filter, placeholders, caches
│  │     ├─ policy/                   # rule compiler, decision point, grants, grounding        [protected]
│  │     ├─ broker/                   # enforcement point, router, NEP client, evidence          [protected]
│  │     ├─ verifier/                 # criteria checks, evidence grading                       [protected]
│  │     ├─ registry/                 # capabilities, health, search, service policies
│  │     ├─ skills/                   # skill runtime, workflow engine, release manager
│  │     ├─ learning/                 # experiences, lessons, gap resolver, proposals
│  │     ├─ workshop/                 # workshop manager, validation orchestration
│  │     ├─ models/                   # model gateway, adapters, budgets, dated price tables
│  │     ├─ connectors/               # connector hub + first-party connectors
│  │     ├─ workers/                  # worker supervisor; codex, claude-code, agent adapters
│  │     ├─ notify/                   # notification router, attention model, digests
│  │     ├─ events/                   # event store, payloads, artifacts, audit chain           [protected]
│  │     ├─ vault/                    # credential vault (behind the Guard from M6)             [protected]
│  │     ├─ ipc/                      # JSON-RPC server, named pipes, handshake
│  │     └─ devicelink/               # M7 outbound link
│  ├─ browser-runtime/                # jarvis-browser (Playwright host)
│  ├─ mcp-gateway/                    # per-work-order MCP server exposing brokered tools
│  ├─ console/                        # Electron: main/, preload/, renderer/ (React)
│  ├─ sdk/                            # authoring SDK for tools, connectors, skills (used by the Workshop)
│  └─ shared/                         # generated types, error vocabulary, utilities
├─ native/                            # .NET solution
│  ├─ Jarvis.Launcher/                # supervisor + Update Supervisor                          [protected]
│  ├─ Jarvis.SessionAgent/            # UIA, capture, OCR, input, hooks, notifications
│  ├─ Jarvis.ExecHost/                # Job Objects, files + recovery bin, DPAPI, Task Scheduler, sandbox launch
│  ├─ Jarvis.Guard/                   # M6: policy store, vault, grant signing, audit            [protected]
│  ├─ Jarvis.ElevatedHelper/          # optional: typed admin catalog                           [protected]
│  └─ Jarvis.Contracts/               # generated C# contract types
├─ skills-builtin/                    # first-party skill packages (source form)
├─ workshop/                          # WSL base-image recipe, .wsb templates, validation tool configs
├─ tests/
│  ├─ unit/  integration/  e2e/
│  ├─ sim/                            # simulators: booking site, mail and calendar, desktop test app, clock
│  ├─ fixtures/                       # synthetic data only
│  └─ evals/                          # boss, retrieval, routing, skill, and workshop suites (holdouts are NOT here)
├─ tools/                             # codegen, build, signing, release scripts
└─ installer/                         # per-user (v1) and machine-wide (M6) packaging
```

`[protected]` marks paths behind the self-improvement gate ([08 §13.11](08-workshop-and-release.md#1311-self-improvement-of-jarvis-itself)).

## 17.5 Runtime data layout (outside the repository)

```text
%LOCALAPPDATA%\Jarvis\
  app\versions\<version>\            # installed code (v1 per-user); app\current.json points to one
  data\jarvis.db  (+ -wal, -shm)     # the single database: tasks, memory, policy (v1), events, registry
  data\payloads\                     # encrypted payload blobs: transcripts, raw outputs
  artifacts\sha256\ab\cdef…          # content-addressed artifacts, encrypted when sensitive
  skills\<id>\<version>\             # installed skill packages (read-only)
  plugins\<id>\<version>\            # installed plugins (read-only)
  holdouts\                          # evaluation holdouts (Release Manager only)
  browser-profiles\<profile>\        # dedicated JARVIS browser profiles
  recovery-bin\                      # pre-modification snapshots (size-capped)
  workspaces\                        # Windows-side staging for sandbox I/O
  logs\                              # redacted technical logs (rotated, 14 days)
  vault\vault.bin                    # credential vault (DPAPI-wrapped key)
  backups\                           # or your chosen destination
  exports\
WSL distro "jarvis-workshop":        /home/worker/ws/<wo_id>/…
```

| Kind | Where |
|---|---|
| Application source | The repository |
| Installed code | `app\versions\` |
| Runtime state | `data\jarvis.db`, `data\payloads\` |
| Personal memory | Memory tables in `jarvis.db`, plus payloads |
| Credentials | `vault\vault.bin` only |
| Skill packages | `skills\` (installed), `skills-builtin\` (source) |
| Development workspaces | The WSL distro, and `workspaces\` for staging |
| Test fixtures | `tests/fixtures/` (synthetic), never personal data |
| Artifacts | `artifacts\` |

## 17.6 Interface contracts

### Conventions shared by every contract

- **Metadata on every request.** `correlation` (task, step, action, work order, conversation, causation event), `idempotency_key` for anything that mutates, an absolute `deadline`, `caller` (component and version), and `protocol_version`.
- **Three call classes.**
  1. **Synchronous query.** Read-only and bounded: `memory.search`, `task.get`, `registry.search`.
  2. **Durable command.** Returns an ID at once, and the outcome arrives as events: `task.create`, `task.revise`, `schedule.create`, long `exec.invoke` calls.
  3. **Stream subscription.** Server-to-client events with a cursor: `events.subscribe(from_seq)`, `exec.events(invocation_id)`.
- **Errors.** A JSON-RPC error whose `data` is a `StructuredError` ([05 §11.6](05-capabilities-and-execution.md#116-shared-error-vocabulary)).
- **Cancellation.** `*.cancel(id)` for durable commands, and deadlines for synchronous calls. Cooperative cancellation propagates through cancel tokens. Killing a process is the last resort.
- **Reconnection.**
  - Clients re-subscribe with their last `seq`, and the server replays from the Event Store.
  - Idempotency keys make retried commands safe.
  - Executors keep an in-flight table so `nep.status` can answer after a reconnect.
- **Versioning.** A `hello` handshake exchanges supported protocol versions. Minor versions are additive, and unknown fields are ignored. A major version gets an adapter layer and a deprecation window.

### UI ↔ Coordinator

| Method | Class | Notes |
|---|---|---|
| `conversation.send({conversation_id, content, attachments[], modality, transcript_confidence?})` | Durable | Returns `message_id`. Output arrives as `conversation.delta` and `conversation.message` events. |
| `task.list(filter)`, `task.get(id)` | Sync | — |
| `task.control({task_id, op: pause \| resume \| cancel})`, `task.steer({task_id, text})` | Durable | — |
| `decision.respond({decision_request_id, option_id, proposal_fingerprint})` | Durable | The Policy Engine checks the fingerprint and that the response came from an owner channel |
| `memory.search/get/list` · `memory.edit/correct/delete/export/import` | Sync · Durable | — |
| `rules.list/get` · `rules.propose/confirm/revoke` | Sync · Durable | Protected rules follow the protected process |
| `accounts.list/connect/revoke` · `skills.list/get/disable/rollback` · `skills.proposal.respond` | Mixed | — |
| `schedules.list` · `monitors.list/control` · `settings.get/set` | Mixed | — |
| `events.subscribe({from_seq, filters})` | Stream | — |
| `emergency.stop()` | Durable | Also handled locally by the Session Agent's hotkey |

Messages from the Console are `owner_verified`: they come from the local interactive session over an ACL'd pipe. Speech playback is handled inside the Console, so "stop speaking" never waits on the Coordinator.

### Coordinator ↔ workers

- `worker.start(WorkOrder)` returns a session reference. Events: `progress`, `question`, `artifact`, `usage`, `heartbeat`, `result` (a `WorkerResult`), `error`. Tool calls do **not** come through this channel. They go through the MCP Gateway to the Broker.
- `worker.revise(work_order_id, revision)`, `worker.interrupt`, `worker.cancel`, `worker.resume(session_ref)`.
- Missing heartbeats cause an interrupt, then a kill, then a retry or escalation according to the work order.

### Workers ↔ Broker, through the MCP Gateway

- Each work order gets its own MCP endpoint: a stdio shim inside the worker environment, or streamable HTTP. It is protected by a **capability token** scoped to the allowed capabilities and effects, the task and work order IDs, an expiry, and the policy revision.
- The MCP tools offered are the allowed capabilities (schemas taken from their descriptors) plus `ask_boss`, `report_progress`, `propose_memory`, and `propose_skill_update`.
- Every call becomes a Broker action: policy check, then NEP, then a `ToolResult` returned as the MCP tool result, including `effect_state` and evidence references. A denial comes back as a tool error **with its reason**, so the worker adapts instead of retrying blindly.

### Broker ↔ executors: the Node Execution Protocol (NEP)

```ts
interface NepInvoke {
  invocation_id: string; action_id?: string;
  capability: string;                  // "tool:browser.click@2.1.0"
  params: unknown;                     // placeholders are resolved inside the executor boundary
  grant?: { decision_id: string; signature: string; fingerprint: string; expires_at: string };
  lease?: { lease_id: string; fencing_token: number };
  task_revision: number; policy_revision: number;
  idempotency_key: string; deadline: string;
  observation_ref?: { id: string; max_age_ms: number };   // desktop and visual actions
}
// executor → broker   nep.event  { invocation_id, seq, kind: "progress" | "observation" | "log", data }
// executor → broker   nep.result ToolResult                       (05 §11.14)
// broker   → executor nep.cancel { invocation_id, mode: "cooperative" | "kill" }
// broker   → executor nep.status { invocation_id } → { state, last_seq, result? }   (after reconnect)
```

For effectful actions, executors verify the grant's signature, expiry, and fingerprint. They also check lease fencing, revision freshness against the Broker's current revision, and observation staleness. The same contract runs over named pipes locally and over the Device Link later.

### Coordinator ↔ Memory (in-process)

- Sync: `search(descriptor, budget)`, `resolveEntities(text)`, `getApplicable(scope)`.
- Mutations: `propose(MemoryProposal[])`, `writeExplicit(…)`, `correct(…)`, `delete(scope)`. These run inside the Task Engine's `UnitOfWork`, so they commit atomically with task settlement ([03 §9.11](03-memory.md#911-memory-write-pipeline)).
- Events: `memory.changed {ids, revisions}` drives cache invalidation.

### Scheduler ↔ Task Engine

- The Scheduler emits `schedule.fired {fire_id, schedule_id, scheduled_for, fired_at, missed, policy_applied}`. The Task Engine creates the task, run, or notification **in the same transaction**, idempotent on `fire_id`.
- The Task Engine calls `schedule.create/revise/cancel`. Wake-timer requests go through the Scheduler to the Exec Host.

### Workshop ↔ Skill Registry (Release Manager)

- `candidate.submit({package_path, dev_work_order_id})` returns a `candidate_id`.
- `candidate.validate(candidate_id)` produces a `ValidationReport` (durable).
- `candidate.promote(candidate_id, decision)` produces a `ReleaseRecord`, with your approval where policy requires it.
- `release.activate/rollback(capability_id, version)`.
- Events: `release.activated`, `release.rolled_back`, `capability.disabled`.

### Device Link (M7)

NEP over WSS, with authority-signed command envelopes, node advertisements, sequence-based event replay, expiry, and idempotency ([01 §5.4](01-architecture.md#54-device-registration-availability-and-commands)).

## 17.7 Central schemas and schema index

| Schema | Canonical location |
|---|---|
| `TaskContract`, `SuccessCriterion`, `Constraint`, `TaskOverride`, `BudgetEnvelope` | [02 §8.2](02-boss-and-tasks.md#82-task-contract-schema) |
| `PlanStep` | [02 §8.6](02-boss-and-tasks.md#86-plan-steps-checkpoints-and-restart-recovery) |
| `WorkOrder`, `WorkerResult` | [02 §7.5](02-boss-and-tasks.md#75-work-orders-and-worker-results) |
| `ReasoningAdapter`, `ReasoningRequest`, `ReasoningEvent` | [02 §7.2](02-boss-and-tasks.md#72-a-replaceable-reasoning-model-inside-a-stable-identity) |
| `MemoryRecord` and content types, `OwnerProfile`, `Project`, `Commitment`, `Entity`, `Relationship`, `Conversation`, `Message`, `ExperienceRecord`, `LessonContent`, `MemoryCorrection`, `DerivedSummary`, `MemoryProposal` | [03 §9.5–9.6](03-memory.md#95-the-common-record-envelope) |
| `OwnerRule`, `PolicyCondition`, `AuthorizationEnvelope`, `AuthorizationDecision`, `DecisionRequest` | [04 §10.3–10.7](04-policy-and-trust.md#103-rule-schema) |
| `CapabilityDescriptor`, `CapabilityHealth`, `StructuredError`, `ProcessRequest`, `ServicePolicy`, `ToolResult` | [05](05-capabilities-and-execution.md) |
| `Adapter`, `AdapterEvent`, `Budget`, `UsageLedgerEntry` | [06](06-connectors-providers-budgets.md) |
| Skill manifest, `SkillExecutionRecord`, `GapReport`, `ResolverOption`, `LearningBounds` | [07](07-skills-and-learning.md) |
| `DevWorkOrder`, `DevResult`, `PromotionEvidence` | [08](08-workshop-and-release.md) |
| `ScheduledJob`, `Monitor`, `MonitorCursor`, `Suggestion` | [10](10-time-and-attention.md) |
| `NepInvoke` | §17.6 |
| `Correlation`, `Event`, `EvidenceRecord`, `ArtifactRef`, `ToolInvocation`, `ResourceLease`, `DeviceRegistration`, `CapabilityAdvertisement`, `ImprovementProposal`, `ReleaseRecord`, `UsageReport` | **Below** |
| Shared primitive types: `EffectClass`, `TaskMode`, `TaskStatus`, `WaitReason`, `ErrorCode`, `Money`, `Retention`, `Sensitivity`, `EgressPolicy`, `Channel`, `SourceRef`, `Provenance`, and others | **Below** |

**Shared primitive types** (used across all documents):

```ts
type EffectClass = "read.local" | "read.account" | "write.local" | "delete.local" | "write.account"
  | "delete.account" | "communicate" | "publish" | "spend" | "commit" | "access_control"
  | "execute_code" | "install" | "admin" | "notify_owner";
type TaskMode = "advise" | "plan" | "research" | "draft" | "prepare" | "execute" | "monitor" | "build";
type TaskStatus = "accepted" | "needs_clarification" | "planned" | "running" | "waiting" | "paused"
  | "verifying" | "completed" | "partially_completed" | "failed" | "blocked" | "cancelled";
type WaitReason = "owner" | "auth" | "device" | "quota" | "subtask" | "resource" | "until";
                                       // rendered as waiting_for_<reason>, and waiting_until (02 §8.5)
type ErrorCode = "invalid_input" | "missing_permission" | "missing_credential" | "auth_required"
  | "unavailable_device" | "unsupported_operation" | "transient_service_error" | "rate_limited"
  | "uncertain_external_effect" | "verification_failed" | "precondition_changed" | "conflict"
  | "timeout" | "budget_exhausted" | "policy_unavailable" | "expired" | "external_refusal"
  | "cancelled" | "internal_error";   // meanings: 05 §11.6
type EvidenceType = EvidenceRecord["type"];
type Sensitivity = "normal" | "personal" | "sensitive" | "restricted";
type SourceTrust = "owner_verified" | "owner_unverified" | "trusted_service" | "external_content"
  | "worker_claim" | "system";
type Channel = "console" | "toast" | "sound" | "speech" | "calendar_mirror" | "phone_push" | "email_self";
interface Money { amount: number; currency: string }                 // ISO 4217
interface Retention { policy: "keep" | "until" | "task_end" | "days"; value?: string | number; review_at?: string }
interface EgressPolicy { policy: "any_approved_provider" | "listed_providers" | "local_only"; providers?: string[] }
interface WeeklyHours { tz: string; windows: { days: ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[];
                                               from: string; to: string }[] }
interface TimeWindow { tz?: string; from: string; to: string }       // local times, e.g. "20:00" to "07:00"
type ResourceSelector = { path_prefix: string } | { account: string } | { site: string }
  | { entity: string } | { app: string } | { recipient_set: string };
interface SourceRef { kind: "message" | "evidence" | "artifact" | "event" | "owner_edit"; ref: string; locator?: string }
interface Provenance { origin: "stated" | "observed" | "derived" | "inferred" | "imported";
                       source_refs: SourceRef[]; source_trust: SourceTrust; recorded_by: string }
interface Confidence { level: "confirmed" | "high" | "medium" | "low"; basis: string }
interface RecordTimes { created_at: string; observed_at?: string; last_verified_at?: string;
                        valid_from?: string; valid_until?: string; expires_at?: string }
interface InputRef { kind: "artifact" | "path" | "record" | "url"; ref: string }
interface SessionRef { adapter: string; session_id: string }
type ScopeCondition = PolicyCondition;                                // 04 §10.3
type RetryPolicyOverride = Partial<Record<ErrorCode, { max_attempts: number; backoff: string }>>;
type JSONSchema = object;                                             // JSON Schema 2020-12 document
```

**Cross-cutting schemas:**

```ts
interface Correlation {
  task_id?: string; step_id?: string; action_id?: string;
  work_order_id?: string; conversation_id?: string; causation_event_id?: string;
}

interface Event {
  event_id: string;                    // ev_…
  schema: "jarvis.event/1";
  type: string;                        // "task.state_changed", "action.dispatched", "memory.changed", …
  occurred_at: string; recorded_at: string;
  node_id: string; seq: number;        // per-node monotonic sequence
  source: { component: string; version: string; process_instance: string };
  correlation: Correlation;
  sensitivity: "normal" | "personal" | "sensitive" | "restricted";
  summary: string;                     // redacted, human-readable; replaceable by a redaction marker
  data: object;                        // redacted structured metadata
  data_hash: string;                   // hash of the original data, kept after redaction
  payload_ref?: string;                // encrypted, deletable payload
  payload_hash?: string;               // kept after payload deletion
  chain: { prev_hash: string; hash: string };   // over ids, type, times, correlation, data_hash, payload_hash
  redaction: "none" | "data_redacted" | "payload_deleted";
}

interface EvidenceRecord {
  evidence_id: string;                 // evd_…
  type: "service_readback" | "service_confirmation" | "postcondition_observation" | "file_check"
      | "test_result" | "process_exit" | "screenshot" | "model_judgement" | "owner_confirmation";
  strength: "strong" | "moderate" | "weak";   // default by type (14 §19.4); may be downgraded by context
  claim: string;                       // what it supports
  criterion_id?: string; action_id?: string; task_id: string;
  observed_at: string;
  source: { capability_id: string; executor: string; account_id?: string; url?: string };
  data: object;                        // extracted fields that were compared (redacted)
  artifact_refs: string[];             // screenshots or files, retention-bound
  limitations?: string;                // e.g. "screenshot only; small text"
  retention: Retention;
}

interface ArtifactRef {
  artifact_id: string;                 // art_…
  content_hash: string; media_type: string; size_bytes: number;
  name: string; kind: "document" | "image" | "audio" | "dataset" | "package" | "report" | "evidence";
  location: { store: "artifacts" | "user_path"; path?: string };
  produced_by: Correlation & { capability_id?: string };
  sensitivity: Sensitivity; encrypted: boolean; retention: Retention; created_at: string;
}

interface ToolInvocation {
  invocation_id: string;               // inv_…
  capability: string;                  // pinned id@version
  params_ref: string;                  // payload // SENSITIVE
  requested_by: { kind: "boss" | "skill" | "worker"; ref: string };
  action_id?: string; decision_id?: string; lease_id?: string;
  correlation: Correlation;
  status: "requested" | "denied" | "dispatched" | "completed" | "failed" | "cancelled";
  result_ref?: string; started_at?: string; ended_at?: string;
}

interface ResourceLease {
  lease_id: string;                    // lse_…
  resource: string;                    // "desktop:input", "browser_profile:jarvis-personal", "fs:D:\\Knowledge\\…"
  mode: "exclusive" | "shared_read";
  holder: { task_id: string; work_order_id?: string; process_instance: string; node_id: string };
  fencing_token: number;               // monotonic per resource
  acquired_at: string; expires_at: string; heartbeat_at: string;
  state: "active" | "released" | "expired" | "revoked";
  revoked_reason?: "owner_takeover" | "emergency_stop" | "expired" | "task_cancelled" | "lock";
}

interface DeviceRegistration {
  device_id: string;                   // dev_…
  kind: "windows_pc" | "phone" | "cloud_runner";
  roles: ("client" | "node")[];
  public_key: string; key_protection: "tpm" | "secure_enclave" | "software";
  scopes: string[];                    // e.g. "approve_decisions", "change_protected_rules:presence_required"
  registered_at: string; registered_via: string;
  status: "active" | "revoked"; revoked_at?: string;
}

interface CapabilityAdvertisement {
  node_id: string; device_id: string; seq: number; at: string;
  availability: "unlocked" | "locked" | "asleep_expected" | "offline" | "safe_mode";
  capabilities: { id: string; health: CapabilityHealth["state"] }[];
  policy_revision_known: number;
  active_leases: string[];
  software: { jarvis_version: string; executors: Record<string, string> };
}

interface ImprovementProposal {
  proposal_id: string;                 // imp_…
  kind: "skill" | "tool" | "connector" | "routing" | "learning_config" | "ui" | "core" | "memory_generalization";
  title: string; rationale: string; evidence_refs: string[];
  target: { capability_id?: string; current_version?: string };
  expected_effect: { metric: string; baseline: string; target: string }[];
  risk: { class: "R0" | "R1" | "R2" | "R3";
          permission_delta: { added: string[]; removed: string[] };
          protected_paths_touched: string[] };
  budget_estimate?: Money;
  status: "proposed" | "approved" | "in_development" | "validated" | "rejected" | "released" | "abandoned";
  decided_by?: "policy" | "owner"; created_at: string;
}

interface ReleaseRecord {
  release_id: string;                  // rls_…
  capability_id: string; from_version?: string; to_version: string; package_hash: string;
  class: "configuration" | "skill" | "connector" | "routing" | "ui" | "learning_config" | "core";
  validation_report_ref: string; promotion_evidence: PromotionEvidence;
  approvals: { by: "policy" | "owner"; at: string; signature?: string }[];
  migrations?: { id: string; reversible: boolean; backup_ref: string }[];
  activated_at?: string;
  canary: { runs: number; failures: number; state: "running" | "passed" | "failed" };
  rolled_back_at?: string; rollback_reason?: string;
}

interface UsageReport {
  tokens?: { input: number; output: number; cache_read?: number; cache_write?: number };
  cost?: { amount: Money; kind: "actual" | "estimated" | "unknown"; basis: string };
  subscription?: { provider: string; plan_usage: "unknown" | string };
  duration_ms: number;
}
```

**Ownership, sensitivity, and references.** Every schema has a stable prefixed ID and a `schema` version string. Large or sensitive content is **referenced** through `*_ref` payload or artifact IDs, never duplicated into events, logs, or other records. Fields marked `SENSITIVE` are encrypted at rest and excluded from logs and exports unless you choose otherwise.

## 17.8 An illustrative policy check and action result

These values are hypothetical, from scenario S1 ([11](11-scenarios.md#s1-booking-a-hotel-from-intent-to-verified-outcome)).

**Broker → Policy Engine: action request**

```json
{
  "action_id": "act_01JC8Z4Q…",
  "task_id": "tsk_01JC7A2M…", "task_revision": 3, "policy_revision": 57,
  "capability": "skill:travel.book_accommodation@0.4.0#9f2c…",
  "step": "submit",
  "effects": ["commit", "spend"],
  "params": {
    "site": "site:examplestays", "property": "Hotel Aurora", "room": "Deluxe double",
    "check_in": "2026-10-14", "check_out": "2026-10-17", "guests": 1,
    "price_per_night": { "amount": 176, "currency": "EUR" },
    "cancellation": { "type": "free", "until": "2026-10-11T23:59:00+01:00" },
    "guest_name": "{{mem:mem_owner_legal_name#value}}",
    "payment": "site_card_on_file"
  },
  "account": "acc_examplestays_personal",
  "authorization_basis": { "kind": "explicit_instruction", "envelope_ref": "tsk_01JC7A2M…#rev3.envelope" }
}
```

**Policy Engine → Broker: decision (a grant)**

```json
{
  "decision_id": "grt_01JC8Z5B…",
  "decision": "allow",
  "basis": { "kind": "explicit_instruction",
             "refs": ["msg_01JC79…C", "msg_01JC6F…A", "art_01JC6G…#option2"] },
  "matched_rules": [ { "rule_id": "rul_nonrefundable", "revision": 2, "effect": "bounded" } ],
  "bounds": [
    { "field": "price_per_night.amount", "op": "<=", "value": 180, "source": { "kind": "owner_message", "ref": "msg_01JC79…C" } },
    { "field": "cancellation.type", "op": "==", "value": "free", "source": { "kind": "owner_message", "ref": "msg_01JC79…C" } },
    { "field": "property", "op": "==", "value": "Hotel Aurora", "source": { "kind": "owner_message", "ref": "msg_01JC79…C" } },
    { "field": "check_in", "op": "==", "value": "2026-10-14", "source": { "kind": "owner_message", "ref": "msg_01JC6F…A" } }
  ],
  "action_fingerprint": "sha256:4be1…",
  "expires_at": "2026-10-02T10:44:00Z", "single_use": true,
  "reason_for_owner": "Covered by your instruction to book option 2 under €180/night with free cancellation.",
  "signature": "hmac-sha256:…"
}
```

**Executor → Broker: the submit timed out** (the uncertainty is explicit, not a boolean)

```json
{
  "invocation_id": "inv_01JC905R…", "action_id": "act_01JC8Z4Q…",
  "status": "error",
  "effect_state": "unknown",
  "error": { "code": "uncertain_external_effect", "retryable": false, "effect_state": "unknown",
             "message": "Confirmation page did not load within 45 s after submit." },
  "evidence": [ { "evidence_id": "evd_01JC905T…", "type": "postcondition_observation", "strength": "weak",
                  "claim": "Submit clicked; progress indicator shown; no confirmation rendered" } ],
  "timing": { "started_at": "2026-10-02T10:15:02Z", "ended_at": "2026-10-02T10:15:47Z" }
}
```

**Reconciliation result**

```json
{
  "action_id": "act_01JC8Z4Q…",
  "state": "verified",
  "effect_state": "complete",
  "evidence": [
    { "type": "service_readback", "strength": "strong",
      "claim": "My trips lists Hotel Aurora 14–17 Oct, EX-48213, €176/night, free cancellation until 11 Oct" },
    { "type": "service_confirmation", "strength": "strong",
      "claim": "Confirmation email EX-48213 received 10:17" }
  ],
  "comparisons": [
    { "field": "price_per_night.amount", "authorized_max": 180, "observed": 176, "ok": true },
    { "field": "cancellation.type", "expected": "free", "observed": "free", "ok": true },
    { "field": "account", "expected": "acc_examplestays_personal", "observed": "acc_examplestays_personal", "ok": true }
  ],
  "remaining_uncertainty": "none"
}
```

## 17.9 Compatibility and migration

- **Contracts.** Every schema has a versioned `$id`. Additive changes are minor. Consumers ignore unknown fields. A breaking change is a new major version, with an adapter for one deprecation window.
- **Events are immutable.** Upcasters convert older event versions when read.
- **Database migrations** are versioned SQL using expand/contract, tested before release ([08 §13.11](08-workshop-and-release.md#1311-self-improvement-of-jarvis-itself)).
- **Skill manifests** carry `schema: jarvis.skill/1`. A migration tool upgrades them to `/2`. Pinned executions keep their version.
- **NEP** negotiates versions at `hello`. Nodes below the minimum version are marked `outdated` and receive no dispatches.
- **Model output is never the machine interface by itself.** Every model decision that drives an action passes JSON Schema validation (structured outputs) and deterministic checks. Free-form prose is for people.
