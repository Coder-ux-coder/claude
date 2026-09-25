# JARVIS: Architecture and Implementation Plan

**Status:** Draft 1, design only, dated 2026-09-25.
This is the specification you asked for. Nothing here has been implemented, installed, deployed, connected, or scheduled. None of your real files or accounts were inspected. All personal details in examples are **HYPOTHETICAL**. Monetary amounts are illustrative configuration, not real authorization.

---

## The short version

JARVIS is one assistant with one identity. It owns your tasks from request to verified outcome. It remembers what you tell it, obeys the rules you set, and works across your Windows PC, your browser, and your connected accounts. When it lacks a capability, it can have Codex or Claude Code build one. It gets better at recurring work by turning verified procedures into versioned, tested skills. Models are replaceable components inside it. Its memory, rules, task history, and identity belong to your installation.

The recommended architecture in ten points:

1. **One local Coordinator process owns everything durable**: tasks, memory, rules, skills, events, and evidence. It keeps them in one SQLite database plus content-addressed file stores. Language models are advisors plugged in through adapters and hold no authoritative state. Switching models or providers loses nothing that matters.
2. **Four concerns are separated in code, not in prompts.** The boss model decides what to do. A deterministic **Policy Engine** decides whether it is authorized. An **Execution Broker** and its executors do it. A **Verifier** checks the effect against evidence. A model saying "this is allowed" or "this is done" never counts as authorization or completion.
3. **Broad capability comes from executors with a common contract.** Files and processes go through the Exec Host. The desktop goes through the Session Agent, UI Automation first and pixels as a fallback. The browser goes through Playwright in dedicated JARVIS profiles. Services go through connector APIs. Development goes through Codex and Claude Code in an isolated Workshop. Every route returns comparable evidence.
4. **Memory is a structured, inspectable, correctable system.** It is not a growing prompt file. Records carry scope, time, provenance, trust, sensitivity, and supersession. A Context Builder assembles a compact, sourced context for each task. Mandatory rules are attached by applicability, never by relevance ranking.
5. **Rules are real.** Owner rules compile into structured policy that the Broker checks before dispatch and again just before any consequential operation. An authorization **grant** is bound to the exact action, its parameters, the policy revision, and an expiry. Standing permissions let clearly authorized work proceed without repeated prompts.
6. **Learning is procedural and evidence-gated.** New methods become draft skills, which are versioned packages with manifests and tests. Evidence promotes them. When a task hits a missing capability, the **Gap Resolver** decides between repair, alternative route, question, build, wait, or honest blocker. If it builds, it resumes the original task afterwards.
7. **Enforcement claims are honest.** Code that runs with your full user rights can bypass anything that also runs with your user rights. So untrusted and generated code runs in an OS-isolated Workshop, and admin operations need UAC consent or a narrow privileged helper. A protected Guard service arrives in the hardening milestone to shield policy, credentials, and audit from same-user tampering.
8. **Windows-first, and truthful about it.** JARVIS runs as per-user background processes while you are signed in. Desktop control needs an unlocked session. Alarms depend on the PC being on, or asleep with wake timers that have been tested on your machine. Nothing runs while you are signed out until the later cloud stage.
9. **Phone and cloud later, without a rewrite.** Executors already speak a Node Execution Protocol. A future outbound, authenticated Device Link carries the same protocol to a cloud coordinator. IDs, events, and memory ownership do not change.
10. **Build order.** M0 verifies integration assumptions. M1 is the general foundation, and it already includes the development path. M2 adds broad execution, M3 skills and learning, M4 time and attention, M5 modality refinement, M6 hardening and self-update, and M7 phone and cloud.

The main limits. Models make mistakes. Some sites and services forbid automation, and JARVIS will not work around that. Two-factor prompts and CAPTCHAs need you. A sleeping or powered-off PC cannot sound an alarm. Subscriptions are not API credit balances. Irreversible external effects cannot be undone by cancelling a task. The design turns each limit into a visible state with a next step, not a silent failure. The full list is in [15 §20.3](15-decisions-and-traceability.md#203-engineering-limits-and-mitigations).

---

## Documents and deliverables

| # | Deliverable (brief §47) | Where | Status |
|---|---|---|---|
| 1 | Plain-language product definition | [00 §1](00-product.md#1-product-definition) | Complete (draft) |
| 2 | Requirements: fixed, defaults, unresolved | [00 §2](00-product.md#2-requirements) | Complete (draft) |
| 3 | Logical architecture diagram | [01 §3](01-architecture.md#3-logical-architecture) | Complete (draft) |
| 4 | Windows process and deployment diagram | [01 §4](01-architecture.md#4-windows-deployment) | Complete (draft) |
| 5 | Phone/cloud extension diagram | [01 §5](01-architecture.md#5-phone-and-cloud-extension) | Complete (draft) |
| 6 | Component responsibility table | [01 §6](01-architecture.md#6-component-responsibility-table) | Complete (draft) |
| 7 | Boss and worker coordination | [02 §7](02-boss-and-tasks.md#7-boss-and-worker-coordination) | Complete (draft) |
| 8 | Task and external-action state machines | [02 §8](02-boss-and-tasks.md#8-task-contract-and-state-machines) | Complete (draft) |
| 9 | Memory architecture, schemas, flows, deletion | [03](03-memory.md) | Complete (draft) |
| 10 | Rules, permissions, policy, credentials | [04](04-policy-and-trust.md) | Complete (draft) |
| 11 | Capability registry, routing, connectors | [05](05-capabilities-and-execution.md), [06](06-connectors-providers-budgets.md) | Complete (draft) |
| 12 | Skills, lifecycle, learning loop, gap resolver | [07](07-skills-and-learning.md) | Complete (draft) |
| 13 | Development workshop and self-improvement | [08](08-workshop-and-release.md) | Complete (draft) |
| 14 | Interface, voice, image, screen context | [09](09-interface-and-modalities.md) | Complete (draft) |
| 15 | Scheduling, alarms, monitoring, proactive help | [10](10-time-and-attention.md) | Complete (draft) |
| 16 | End-to-end worked scenarios | [11](11-scenarios.md) | Complete (draft) |
| 17 | Stack, repository, integration contracts | [12](12-stack-and-contracts.md) | Complete (draft) |
| 18 | Dependency-aware build plan | [13](13-build-plan.md) | Complete (draft) |
| 19 | Failure matrix, evaluation, observability | [14](14-verification-and-observability.md) | Complete (draft) |
| 20 | Decision log, sources, owner decisions, traceability | [15](15-decisions-and-traceability.md) | Complete (draft) |

"Complete (draft)" means every deliverable has a substantive design. It does not mean the design is final. Items marked **[U]** must still be verified against your accounts and hardware in M0. The decisions in [15 §20.8](15-decisions-and-traceability.md#208-owner-decisions) are yours to make.

**Suggested reading paths**

- **Owner:** this page, then [00](00-product.md), [11 Scenarios](11-scenarios.md), [13 Build plan](13-build-plan.md), and [15 Decisions](15-decisions-and-traceability.md).
- **Engineer:** [01](01-architecture.md), [02](02-boss-and-tasks.md), [12](12-stack-and-contracts.md), then [03](03-memory.md)–[10](10-time-and-attention.md), then [14](14-verification-and-observability.md).

---

## Conventions

### Verification tags

| Tag | Meaning |
|---|---|
| **[V]** | Verified on 2026-09-25 by reading the official documentation page directly. The source is cited near the claim and in [15 §20.5](15-decisions-and-traceability.md#205-source-verification-notes). |
| **[V-S]** | Confirmed on 2026-09-25 only through search-result excerpts of the official page. This environment's network policy blocked direct fetching of learn.microsoft.com, developers.openai.com, learn.chatgpt.com, developers.google.com, support.upwork.com, developer.chrome.com, and playwright.dev. Re-read the page in M0. |
| **[I]** | Inferred from established platform behavior or general engineering knowledge. It is not checked against a current page. |
| **[U]** | Unverified or account-dependent. It must be tested or confirmed before implementation depends on it. |

### Notation

- Schemas use TypeScript-style interfaces. `?` marks optional fields. `// SENSITIVE` marks fields that are encrypted at rest and excluded from logs. Examples use JSON or YAML.
- Every schema has one canonical location. The index is in [12 §17.7](12-stack-and-contracts.md#177-central-schemas-and-schema-index).
- Times are stored as RFC 3339 UTC instants. Owner-facing schedules also store local wall time plus an IANA timezone name, which comes from the owner profile and is never guessed.
- **HYPOTHETICAL** marks invented personal data. No example reflects your real history, accounts, or limits.

### Identifier prefixes

Stable IDs are `prefix_` plus a ULID. ULIDs sort by time and need no coordination, so they survive a later move to multi-device sync.

| Prefix | Entity | Prefix | Entity |
|---|---|---|---|
| `tsk_` | Task | `mem_` | Memory record (fact, preference, lesson) |
| `stp_` | Plan step | `ent_` | Entity (person, org, place, resource) |
| `wo_` | Work order | `rel_` | Relationship |
| `act_` | External action | `prj_` | Project |
| `att_` | Action attempt | `cmt_` | Commitment |
| `inv_` | Tool invocation | `exp_` | Experience record |
| `ev_` | Event | `cor_` | Memory correction |
| `evd_` | Evidence record | `sum_` | Derived summary |
| `art_` | Artifact | `cnv_` / `msg_` | Conversation / message |
| `rul_` | Owner rule | `grt_` | Authorization decision (grant) |
| `dec_` | Owner decision request | `sch_` / `fire_` | Schedule / schedule firing |
| `mon_` | Monitor | `run_` | Scheduled or monitor run |
| `ntf_` | Notification | `sug_` | Suggestion |
| `lse_` | Resource lease | `dev_` / `node_` | Device / execution node |
| `acc_` | Connected account | `gap_` | Capability gap report |
| `imp_` | Improvement proposal | `rls_` | Release record |
| `bud_` | Budget | `use_` | Usage ledger entry |
| `skr_` | Skill execution record | | |

Capability identifiers are readable and versioned, for example `tool:fs.write_file@1.2.0`, `skill:travel.book_accommodation@0.3.1`, `worker:codex`, and `model:vision.interpret`. The policy revision is a monotonically increasing integer.

---

## Glossary

These terms are used consistently across all documents. [05 §11.1](05-capabilities-and-execution.md#111-terms) gives them in comparison-table form.

| Term | Meaning in this design |
|---|---|
| **Owner** | You. The only human principal, and the only source of owner instructions. |
| **Boss / Boss Runtime** | JARVIS's single user-facing identity and the orchestration logic that owns intent, task contracts, delegation, verification, and reporting. It is application code with a replaceable reasoning model inside it. |
| **Coordinator** (`jarvis-core`) | The local core process. It hosts the Boss Runtime, Task Engine, Scheduler, Memory Service, Context Builder, Policy Engine, Execution Broker, Capability Registry, Skill Runtime, Learning Service, Workshop Manager, Model Gateway, Connector Hub, Notification Router, Event Store, and (until the Guard exists) the Credential Vault. |
| **Console** (`jarvis-console`) | The desktop app: conversation, tasks, memory, rules, skills, accounts, and activity. Closing it does not stop JARVIS. |
| **Session Agent** (`jarvis-session`) | A helper in your interactive Windows session. It handles UI Automation, screen capture, OCR, input injection, owner-takeover detection, hotkeys, notifications, and lock/power events. |
| **Exec Host** (`jarvis-exec`) | A helper that runs processes in Job Objects, performs file operations with a recovery bin, handles DPAPI and Task Scheduler wake timers, and launches sandboxed and elevated work. |
| **Browser Runtime** (`jarvis-browser`) | The Playwright host that controls dedicated JARVIS browser profiles and ephemeral contexts. |
| **Launcher** (`jarvis-launcher`) | A small supervisor that starts, watches, restarts, and updates the other processes. It also acts as the Update Supervisor. |
| **Guard** (`jarvis-guard`, M6) | A Windows service under its own service account. It holds the authoritative policy store, credential vault, grant-signing key, and audit chain, and requires owner presence for protected changes. |
| **Elevated Helper** (`jarvis-elevate`, optional, M6+) | A privileged service that performs only a catalog of typed administrative operations, each bound to a signed grant. |
| **Workshop** | An isolated development environment for coding workers and untrusted code: a WSL2 distro, Windows Sandbox, or a restricted local account. |
| **Worker** | A bounded executor with its own reasoning loop that takes a **work order** and returns structured results. Types are Agent Worker, Codex Worker, and Claude Code Worker. Workers propose and produce. They never own tasks. |
| **Model adapter** | A replaceable interface to a provider for one role: boss reasoning, fast reasoning, vision, computer use, embeddings, speech-to-text, text-to-speech, or image generation. |
| **Tool** | One typed, callable operation with a capability descriptor, such as `tool:fs.move` or `tool:gmail.messages.search`. It executes only through the Broker. |
| **Connector** | A package that integrates one external service or account: authentication, a set of tools, health checks, and the service's automation policy. |
| **Skill** | A versioned, reusable, tested procedure for a class of goals. It is procedural memory. |
| **Workflow** | A deterministic step graph. It is one way to implement a skill, and it also drives scheduled routines. |
| **Plugin** | An installable, signed or provenance-tracked bundle of connectors, tools, skills, UI panels, or adapters. It is the unit of installation. It is never a grant of authority. |
| **Capability** | Any registry entry that can be invoked: a tool, skill, worker type, or model function. |
| **Executor** | A deterministic component that performs brokered operations in one environment: Exec Host, Session Agent, Browser Runtime, a connector executor, or the Elevated Helper. |
| **Action** | One externally meaningful or state-changing tool invocation, tracked by the external-action state machine. |
| **Task / Task contract** | A durable unit of owner-intended work, and its structured specification. |
| **Grant** | A Policy Engine decision authorizing a specific action within bounds. It is bound to the task, a parameter fingerprint, the policy revision, and an expiry. |
| **Standing permission** | An owner rule that authorizes a bounded class of actions without asking each time. |
| **Lease** | Time-bounded ownership of a shared resource such as the desktop, a browser profile, or a folder. It carries a fencing token that rejects stale holders. |
| **Evidence** | A typed, graded record that supports a claim about an effect. A worker's claim is not evidence. |
| **Artifact** | A produced file or output, stored content-addressed and referenced by ID. |
| **Node** | A machine that runs executors. In v1 that is your PC. Later it could also be a cloud runner or a phone. |
| **Effect class** | The kind of consequence an action has (canonical list below). Authority is granted per effect class. |
| **Enforcement level** | Where a rule is actually enforced: E0 advisory, E1 broker, E2 OS isolation, E3 protected service, EP provider-side. See [04 §10.9](04-policy-and-trust.md#109-enforcement-levels-and-privilege-tiers). |
| **Privilege tier** | Under what identity code runs: T0 core, T1 owner-authorized operation, T2 sandbox, T3 elevated. See [04 §10.9](04-policy-and-trust.md#109-enforcement-levels-and-privilege-tiers). |

### Canonical effect classes

Authority to do one of these never implies authority to do another, even when one website button does both.

| Effect class | Examples |
|---|---|
| `read.local` | Read files, screen contents, application state |
| `read.account` | Read email, calendar, Drive files, account pages |
| `write.local` | Create or modify local files and application data (recovery bin where possible) |
| `delete.local` | Delete local data (Recycle Bin by default) |
| `write.account` | Create or modify private account data: drafts, documents, calendar entries |
| `delete.account` | Delete account data |
| `communicate` | Send a message, email, comment, or invitation to another person or organization |
| `publish` | Make content publicly visible |
| `spend` | Pay money or consume paid credits |
| `commit` | Make a commitment to a third party: booking, application, order, RSVP, agreement |
| `access_control` | Change sharing, permissions, security settings, or credentials |
| `execute_code` | Run programs or scripts as the owner, beyond cataloged read-only commands |
| `install` | Install, update, or remove software or dependencies |
| `admin` | Elevated operating-system changes |
| `notify_owner` | Notify or alert the owner: reminders, alarms, digests |

`read.*` is shorthand for both `read.local` and `read.account`.

---

## What this draft deliberately did not do

- It wrote no application code, created no project scaffolding, installed nothing, connected no accounts, and scheduled nothing.
- It did not inspect your files, accounts, or installed software. The onboarding and discovery process is designed in [09 §14.2](09-interface-and-modalities.md#142-screens-and-information-hierarchy) and [13 §18.3](13-build-plan.md#183-milestones).
- It did not claim unverified provider entitlements. The subscription and API questions are laid out in [06 §11.16](06-connectors-providers-budgets.md#1116-subscriptions-versus-api-billing).
