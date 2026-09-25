# 00 · Product Definition and Requirements

Deliverables 1 and 2. Terms are defined in the [README glossary](README.md#glossary).

---

# 1. Product definition

## 1.1 What JARVIS is

JARVIS is your primary digital assistant for work and personal life. It is one assistant with one name, one personality, and one memory. It works like a capable chief of staff who can also operate your computer and write software.

You talk to it normally, by typing, by holding a key and speaking, or by attaching files, screenshots, and photos. You can:

- **Ask** a question or ask for advice. It answers from its own knowledge, from your context, and from research.
- **Give it a goal** ("turn these notes into a project plan", "find me a hotel near the venue"). It interprets the goal, plans, uses tools, and comes back with a verified result or an honest account of what is left.
- **Delegate a project.** It breaks the work down, uses specialist workers where they help, tracks every piece, and remains the single party accountable for the outcome.
- **Correct it mid-course** ("use the other folder", "stop applying and just show me matches"). It updates the task, invalidates stale pending actions, and redirects the workers.
- **Ask it to watch something** ("tell me when a good job match appears"). A durable monitor checks on schedule and interrupts you only when something meaningful changes.
- **Ask it to remember or to follow a rule** ("remember that I prefer aisle seats", "never email clients after 8 pm without asking"). The memory or rule survives restarts, model changes, and new conversations. You can see and edit it.
- **Ask it to build something it cannot yet do.** It hands a concrete engineering work order to Codex or Claude Code in an isolated workshop, tests the result, registers it as a new capability, and returns to your original request.

JARVIS is honest about being software. It says "done" only when the result has been checked against evidence. It shows "I'm not sure whether that went through, I'm checking" when an outcome is uncertain. It distinguishes actual billed cost from estimates and from costs it cannot see.

## 1.2 Experience principles

| # | Principle | What it means in practice |
|---|---|---|
| P1 | **One JARVIS** | You deal with one assistant. Workers are internal. The boss never answers "the other agent says it finished." It checks. |
| P2 | **It knows your context, and you can see what it knows** | Preferences, projects, people, and rules persist and are retrieved by relevance and scope. Every memory can be inspected, corrected, restricted, exported, or deleted. |
| P3 | **Rules are real** | Constraints and permissions are enforced by software at the point of action, with plain reasons when something is refused. |
| P4 | **It takes responsibility** | Every substantial request becomes a tracked task with success criteria, owned until it is verified, handed back with a clear blocker, or cancelled. |
| P5 | **It grows** | Repeated work becomes skills, missing capabilities are built, and improvements are measured and versioned. |
| P6 | **Quiet competence** | It asks only when an ambiguity, a new commitment, missing access, or a genuine expansion of scope requires it. Routine monitoring stays silent. |
| P7 | **Truthful status** | States such as "waiting for your PC," "needs you to sign in to Gmail," "checking the result," and "ready for your decision" replace generic spinners. |

## 1.3 The capability surface

The table shows how broadly JARVIS applies from the first general release. The rows are illustrations of general capability, not a menu. Each row is served by the same task loop, policy, and evidence machinery.

| Domain | Typical requests | Primary routes | Notable limits |
|---|---|---|---|
| Files and documents | Find, organize, summarize, convert, draft, compare, archive | Exec Host file tools, document parsers, generated tools | Protected or admin-owned files need elevation. Some formats need new tooling, which the Workshop can build. |
| Research | Answer questions, compare options, read sources, synthesize | Headless browser, search connectors, reading tools | Paywalls and login walls. Pages are untrusted content. |
| Coding and design | Fix bugs, build tools, scaffold apps, review, prototype UI | Codex and Claude Code workers in the Workshop | Worker quotas. Tests limit how much confidence is possible. |
| Communication | Draft, triage, summarize, send within your authorization | Email and calendar connectors, browser | Sending is `communicate`, which needs explicit or standing authority. |
| Bookings and purchases | Find, prepare, book within bounds | Browser skills in dedicated profiles, APIs where offered | Sites may prohibit automation. 2FA and CAPTCHA need you. Price and terms drift is re-checked. |
| Reminders, alarms, planning | Remind, wake, brief, plan the week | Deterministic Scheduler, notifications, calendar connector | The PC must be on or wake-capable. The phone comes later. |
| Opportunities and monitoring | Job matches, price changes, deadlines, account events | Monitor framework with supported sources | Only permitted sources: Upwork via approved API or your own alert emails. |
| Administration | Install software, change settings, clean up, back up | Exec Host, package managers, UAC batch | Admin changes require your UAC consent or a narrow privileged helper. |
| Unfamiliar work | Anything new | Composition, exploration, then the development path | Budgets. External restrictions. Your decisions. |

## 1.4 General capability, defined

**General capability** means an extensible task-solving system with four properties.

1. **Open interpretation.** Any request can become a task contract. There is no whitelist of supported intents.
2. **Composable breadth.** A large and growing registry of tools, connectors, skills, and workers can be combined per task. Selection happens by search, not by hard-coded dispatch.
3. **Multiple execution routes.** The same intended effect can often be achieved through an API, an application interface, a CLI, structured browser automation, or visual computer use. A router picks the most reliable legitimate route.
4. **A development path.** When no route exists, JARVIS diagnoses the gap and, where software can close it, commissions, tests, and registers new software, then resumes.

It is **not** a promise that every task succeeds. General capability cannot supply account access you do not have, hardware that is absent, a second factor on your phone, a human CAPTCHA response, a service's permission to automate, or a decision only you can make. It also cannot supply unlimited budget. For those, JARVIS names the concrete blocker and the smallest useful next step.

## 1.5 How new categories become possible without rewriting

A new kind of work never requires changing the Boss Runtime, Task Engine, Policy Engine, or memory schema. It lands in one of the extension points below. All of them register through the [Capability Registry](05-capabilities-and-execution.md#112-capability-descriptor) and inherit policy, evidence, and lifecycle handling.

| New need | Extension point | Example | Core contracts reused unchanged |
|---|---|---|---|
| A new service | **Connector** (plugin) | A banking read-only API connector | Capability descriptor, auth via Credential Vault, NEP result envelope, effect classes |
| A new operation | **Tool** | `tool:pdf.extract_tables` | Registry, Broker, evidence |
| A recurring method | **Skill** | "Reconcile monthly invoices" | Skill manifest, lifecycle, version pinning |
| A new execution environment | **Executor / node** | A cloud runner, later the phone | Node Execution Protocol, leases, capability advertisement |
| A new model or provider | **Model adapter** | A better vision model | Model Gateway role routing, budget ledger |
| A new specialist | **Worker type** | A data-analysis agent | Work order and worker result schemas |
| A new interaction surface | **Client** | Phone app, browser extension | UI↔Coordinator contract, conversation and task IDs |

## 1.6 Recursive learning, defined operationally

These are different mechanisms, and the design keeps them separate.

| Mechanism | What changes | Artifact | Evidence required | Changes model weights? |
|---|---|---|---|---|
| **Persistent memory** | Stored facts, preferences, commitments, relationships | Memory records with provenance | Source (your statement, a service record) | No |
| **Retrieval** | What gets pulled into context for a task | Index entries, ranking configuration | Retrieval evaluation set ([03 §9.10](03-memory.md#910-retrieval-quality-evaluation)) | No |
| **Procedural learning** | How a class of goals is achieved | Skill package version | Validated runs and tests | No |
| **Workflow optimization** | Efficiency or reliability of a known skill | New skill version (for example guided → deterministic) | Before/after success rate, time, cost | No |
| **Code improvement** | Tools and connectors that skills use | Tool or package version | Tests, holdouts, production metrics | No |
| **Model selection and routing** | Which model or worker handles which role | Routing configuration revision | Evaluation suite comparison | No |
| **Meta-improvement** | The learning loop itself: test generation, capability matching, failure diagnosis | Workshop template or matcher version | Offline replay benchmark on past cases | No |
| **Model training** | Fine-tuning a model on your data | Fine-tuned model | Separate evaluation and a privacy review | Yes. Optional future work, not needed. |

Writing a memory or changing a prompt does **not** retrain a model. JARVIS gets better by changing versioned artifacts it controls and by measuring whether each change helped.

**Recursion levels.** Each level produces a versioned artifact and needs measurable evidence.

- **L1: Learn a procedure.** A successful novel task yields a draft skill. Evidence: the original run, plus validation runs or tests.
- **L2: Improve the skill.** Observed failures or slowness yield a new skill version. Evidence: before/after metrics on comparable runs.
- **L3: Improve the tools the skill uses.** A brittle scraper-free parser or a missing connector method is fixed in the Workshop. Evidence: tests, holdouts, and production success.
- **L4: Improve the development workflow.** Better test generation, dependency selection, or failure diagnosis for the Workshop. Evidence: replaying historical work orders shows fewer post-promotion failures or less rework.

None of these levels may change owner policy, verification requirements, evaluation holdouts, or failure history. Those limits are enforced in [07 §12.12](07-skills-and-learning.md#1212-meta-improvement-with-guardrails) and [08 §13.11](08-workshop-and-release.md#1311-self-improvement-of-jarvis-itself).

## 1.7 The recovery principle

When progress stops, JARVIS follows the same procedure every time:

1. **Identify the gap.** A structured gap report records the intended step, the observed failure, the environment, the attempted methods, and the evidence.
2. **Investigate practical alternatives.** Use a different tool, repair authentication, retrieve missing data, take another *authorized* route, or wait for availability.
3. **Build missing software when appropriate**, through the Workshop under budget.
4. **Test the result** against the gap's success condition.
5. **Resume the original task** from the failed step, with a fresh observation of the world.

If software cannot supply what is needed, JARVIS explains the concrete blocker and the smallest useful next step:

| Blocker class | Example | Smallest useful next step offered |
|---|---|---|
| Missing account access | No Upwork API approval | "Apply for an API key (form link), or I can use your Upwork alert emails instead." |
| Your participation needed | 2FA code, CAPTCHA, UAC consent | "Approve the sign-in on your phone. I'll continue automatically." |
| Service restriction | Site forbids automated access | "I can prepare everything and you click Submit, or we use their app." |
| Missing hardware or device | PC asleep, no microphone | "I'll run this when your PC wakes. Want a calendar reminder on your phone as backup?" |
| Your decision | Two equally good options, a new cost | Proposal card with the options and what changes |
| Budget | Development budget exhausted | "Partial result attached. Finishing needs about N more [estimated] budget units. Continue?" |

## 1.8 The honesty contract

- "Completed" means **every** success criterion has acceptable evidence. Otherwise the result is "partially completed" and names the unverified parts.
- A worker's report is a claim, not evidence ([02 §7.7](02-boss-and-tasks.md#77-accountability-without-abdication)).
- Uncertain external effects are shown as uncertain and reconciled before any retry ([02 §8.7](02-boss-and-tasks.md#87-external-action-lifecycle)).
- Costs are labeled **actual** (billed by the provider), **estimated** (computed from tokens and a dated price table), or **unknown** (for example, subscription usage the provider does not expose).
- A cancelled task reports the effects that had already happened.
- JARVIS never implies it is a person, never claims to have done something it has not verified, and never presents a visual guess as an exact reading.

---

# 2. Requirements

## 2.1 Fixed requirements

These come from your brief and are treated as settled.

| ID | Requirement | Brief § |
|---|---|---|
| R-01 | One boss assistant with one user-facing identity and authoritative task ownership | 02, 06 |
| R-02 | Windows is the first implementation target | 02, 08 |
| R-03 | Phone access and continuous availability are later targets, and the architecture must accommodate them | 02, 08 |
| R-04 | Open-ended requests with no fixed workflow menu. Examples are demonstrations, not a ceiling. | 01 |
| R-05 | Codex and Claude Code are important workers and development tools | 02, 15, 31 |
| R-06 | Prefer existing subscriptions where supported. Paid APIs where necessary, with visible budgets and explicit fallback policies. | 02, 15, 35 |
| R-07 | Voice, text, images, files, and a usable interface | 02, 09, 10 |
| R-08 | Broad computer access: files, applications, terminal, browser, desktop, admin where needed | 02, 13 |
| R-09 | Personal memory and owner rules that survive restarts, model changes, and conversation boundaries | 02, 16 |
| R-10 | Newly learned methods become reusable skills or improvements to existing skills | 02, 27 |
| R-11 | JARVIS can create software, connectors, scripts, workflows, and tools | 02, 31 |
| R-12 | Controlled improvement of its own implementation | 02, 33 |
| R-13 | Suggests useful next steps and performs recurring work within standing instructions | 02, 34 |
| R-14 | No repeated permission prompts for already authorized work | 02, 22 |
| R-15 | Accuracy about task status, results, costs, and limitations | 02, 36 |
| R-16 | Design first. This brief authorizes no implementation or live actions. | 02, 04 |
| R-17 | Deciding, authorizing, executing, and verifying are separate. A model's statement is never the sole authorization. | 05, 21 |
| R-18 | Mid-task correction changes the active contract and reaches workers | 06, 07 |
| R-19 | A durable task engine, not chat history, holds task state | 24 |
| R-20 | Scheduling is deterministic software | 25, 39 |
| R-21 | Memory can be inspected, edited, exported, and deleted, with honest deletion semantics | 16, 20 |
| R-22 | Enforceable rules are checked at dispatch and immediately before consequential operations | 21 |
| R-23 | Retrieved content and worker output cannot become owner instructions | 14, 23 |
| R-24 | Isolated development and a controlled release path. No in-place edits of active components. | 31, 33 |
| R-25 | Independent evidence prevents false completion | 24, 36 |
| R-26 | Recursion, concurrency, spend, and time are bounded and configurable | 29, 35 |
| R-27 | The first version is usable locally without a cloud service, and later cloud support needs no rewrite of IDs, events, memory ownership, or execution contracts | 08 |
| R-28 | Provider and model changes preserve memory, rules, task identity, and behavior | 06, 16 |
| R-29 | Service restrictions are respected. No browser fallback to bypass denied authorization. | 12, 38 |
| R-30 | Stop, pause, resume, and steering are easy to reach. The interface is accessible. | 09 |

## 2.2 Proposed defaults

These are my recommendations. Each can be changed without redesign.

| ID | Proposed default | Practical effect | Change by |
|---|---|---|---|
| D-01 | TypeScript/Node Coordinator, Electron + React Console, C#/.NET native helpers, one SQLite database | Two core languages. Shared types between the UI and the core. Native Windows APIs where needed. | Stack decision ([12](12-stack-and-contracts.md)) |
| D-02 | Per-user background processes started at sign-in. No Windows service until M6. | Works with your files, browser profiles, and desktop. Nothing runs while you are signed out. | Deployment setting |
| D-03 | Boss model through an Anthropic API key with a monthly cap you set. Candidates: Claude Opus 5.5 (`claude-opus-5-5`) and your requested Claude Opus 5 (`claude-opus-5`, now legacy), compared in M0. | Predictable, visible spend. Model-independent memory. | Owner decision [15 §20.8](15-decisions-and-traceability.md#208-owner-decisions) |
| D-04 | Coding workers on your existing Claude and ChatGPT subscriptions inside the Workshop, after M0 confirms the terms. An API fallback only within a separate development budget. | Uses what you already pay for. No silent paid overflow. | Owner decision |
| D-05 | Push-to-talk voice. Local speech recognition if your hardware allows. Windows voices for speech output. | No always-on microphone. Offline-capable speech. | Settings |
| D-06 | Dedicated JARVIS browser profiles. Your personal browser is untouched. | Reliable automation, no interference with your browsing, contained sessions. | Settings (extension later) |
| D-07 | SQLite + FTS5 text search first. Local embedding model added in M3 for experiences and skills. | Everything works without an embedding provider. | Configuration |
| D-08 | Explicit "remember X" saves immediately and is echoed back. Inferred preferences are labeled and reviewable. | Dependable memory without silent drift | Settings |
| D-09 | No standing permissions at first for `spend`, `commit`, `communicate`, `publish`, or `access_control`. Read effects allowed for connected accounts inside active tasks. Local writes allowed within task scope, protected by the recovery bin. | Safe start. You grant autonomy deliberately. | Rules screen |
| D-10 | Deletes go to the Recycle Bin. Overwrites are snapshotted to a recovery bin for 30 days, size-capped. | Local changes can be undone | Settings |
| D-11 | Quiet hours set at onboarding. Routine monitor results go to a digest. Alarms override quiet hours. | Few interruptions | Settings |
| D-12 | Raw audio is not retained after transcription. Screenshots are ephemeral unless kept as evidence (30 days, then deleted unless pinned). | Low data footprint | Privacy settings |
| D-13 | Nightly encrypted backups under a recovery passphrase, 30-day rolling retention, weekly automatic restore test | Recoverable, portable memory | Settings |
| D-14 | Workshop isolation: a WSL2 distro with interop and automount disabled, plus Windows Sandbox for Windows-native tests where your edition supports it | Real OS boundary for untrusted code | M0 verification |
| D-15 | Skill promotion by risk class. High-risk classes need your approval to promote. | New methods earn trust | Policy |
| D-16 | Learning bounds: development depth 2, one concurrent builder, three attempts per gap signature, per-task development budget | No runaway recursion | Settings, per task |
| D-17 | Admin operations batched behind one UAC consent per task. No privileged service until you enable one (M6+). | Few prompts, no standing admin backdoor | Owner decision |
| D-18 | Timezone comes from your profile. Every schedule shows its exact interpretation. | No silent time errors | Profile |
| D-19 | Missed alarm: sounds if within 10 minutes, otherwise a "missed alarm" notice. Reminders are delivered late with a note. Recurring jobs run once, not a burst. | Honest missed-run behavior | Per schedule |
| D-20 | Emergency stop via global hotkey, tray menu, and Console button | Always reachable | Settings |
| D-21 | Worker choice: your preference first, then observed reliability per task class | Evidence-based routing | Settings |
| D-22 | Daily briefing off until requested | No unsolicited routine | Ask for it |
| D-23 | General task context may go to the configured boss provider. Records marked local-only never leave the device. Sensitive values use placeholders where possible. | Useful and privacy-aware | Privacy settings |
| D-24 | Protected rules can change only from the Console, with explicit confirmation. Windows Hello presence proof is added with the Guard in M6. | Resistant to injected or accidental policy change | Owner decision |
| D-25 | Retention: redacted event metadata 1 year, payloads 30–90 days by category, technical logs 14 days | Debuggable without hoarding | Privacy settings |

## 2.3 Unresolved choices

These need your input or account-level verification. The most consequential appear again as owner decisions in [15 §20.8](15-decisions-and-traceability.md#208-owner-decisions).

| ID | Question | Why it matters | Proposed default | When |
|---|---|---|---|---|
| U-01 | Boss model billing: API key with a cap, or a "subscription-first" mode through Claude Code? | Cost predictability, terms compliance, latency, control | API key with a cap | Before M1 |
| U-02 | Boss model: Claude Opus 5 (legacy), Claude Opus 5.5 (current), or another? | Quality, cost, lifecycle | Evaluate both in M0 and pick on evidence | M0 |
| U-03 | Privacy posture: which memory categories may reach cloud models? Local or cloud speech recognition? | Privacy against quality | Local-only for sensitive and restricted categories. Local speech recognition. | Before M1 |
| U-04 | Initial autonomy: which standing permissions to grant, and which rules to make protected | Prompt frequency against risk | None for consequential effects at start | M1 onboarding |
| U-05 | Windows edition and hardware: Home or Pro, WSL availability, GPU, TPM/Windows Hello | Determines Workshop isolation and local speech options | Discover at onboarding | M0 |
| U-06 | Hardening timing: add the Guard service in M6, or earlier? | Protection of tokens and policy from same-user code | M6, or M2 if you connect financial accounts early | M1 |
| U-07 | Later availability: PC-authoritative with a relay, or cloud-authoritative coordinator? | Privacy against always-on availability | Decide at M7 | M6 |
| U-08 | Google OAuth setup: your own Cloud project in "Testing" (7-day token expiry) or published "In production" | Re-authorization frequency, unverified-app warning | Verify in M0 | M0 |
| U-09 | Upwork route: apply for API access, use your alert emails, or manual sharing | Legitimate source for monitoring | Alert emails now. API if approved. | M4 |
| U-10 | Which accounts and services to connect first | Onboarding order | Email, calendar, Drive | M2 |
