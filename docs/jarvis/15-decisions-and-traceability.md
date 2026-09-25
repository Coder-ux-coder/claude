# 15 · Decisions, Sources, Limits, Traceability, and Next Steps

Deliverable 20. It also covers brief §46, §48, §49, and §50.

---

# 20. Decisions and review

## 20.1 Decision log

| ID | Decision | Recommended choice | Alternatives considered | Rationale | Consequences | Evidence still needed |
|---|---|---|---|---|---|---|
| DL-01 | Local versus cloud ownership | **Local-first.** One authoritative Coordinator on the PC. Cloud later as topology A or B. | Cloud-first coordinator. Multi-master sync. | Privacy. No hosting. The simplest consistency. R-27. | Nothing runs while you are signed out, until M7 | Topology choice at M6–M7 |
| DL-02 | Desktop versus web interface | **Electron desktop app with a React UI** | Native WinUI or WPF. Tauri. A localhost web app. | TypeScript end to end. Tray, hotkeys, microphone. The UI is reusable for phone or web. | Footprint. Security hardening of the renderer. | M0 hotkey and microphone behavior |
| DL-03 | Model provider strategy | **Provider-neutral Model Gateway with role routing.** Anthropic API as the first boss provider. Switching by evaluation. | Single-vendor lock-in. The boss inside a coding agent. | R-28. Full tool and policy control. Verified APIs. | Adapter work per provider | M0 boss evaluation |
| DL-04 | Subscription versus API | **Boss on an API key with a hard cap.** Coding workers on your subscriptions *if M0 confirms the terms*. Explicit fallback chains. Never a silent paid overflow. | Everything through subscription CLIs. Everything on API. | R-06. Entitlements for embedding a subscription in a custom always-on app are uncertain ([06 §11.16](06-connectors-providers-budgets.md#1116-subscriptions-versus-api-billing)). | Some metered spend, visible and capped | M0 terms review |
| DL-05 | Memory representation | **One SQLite database of typed records** with provenance, scope, and time. FTS5 first. Local embeddings later. Markdown as a projection. | Markdown files as the source of truth. A vector database. A graph database. Provider-side memory. | Atomicity, inspectability, portability | Custom schemas to maintain | Retrieval evaluation results |
| DL-06 | Skill execution style | **Least flexible strategy that works**: workflow, guided, or hybrid. Agent Skills-compatible `SKILL.md` plus a JARVIS manifest. | All agentic. All deterministic. | Balances reliability and adaptability. Interoperates with coding workers. | Two execution engines | M3 metrics |
| DL-07 | Permission enforcement | **E1 Broker** enforcement from M1. **E2** OS isolation for untrusted code from M1. **E3** Guard in M6. Minimal provider scopes (**EP**) throughout. | Prompt-based rules. Running as administrator. A full VM for everything. | Honest boundaries with usable breadth ([04 §10.9](04-policy-and-trust.md#109-enforcement-levels-and-privilege-tiers)) | Same-user code can bypass E1 until M6 | M0 and M3 red-team |
| DL-08 | Browser profile strategy | **Dedicated JARVIS profiles plus ephemeral contexts.** Optional extension later. | Driving your main browser through CDP (blocked for the default profile since Chrome 136 [V-S]). Extension-first. | Reliability, isolation, less exposure | You sign in to sites once more, inside the JARVIS profile | M0 browser spike |
| DL-09 | Self-update mechanism | **The Launcher as Update Supervisor**: side-by-side versions, a journal, core releases signed with your approval. Self-improvement never modifies it. | A framework auto-updater inside the app. No self-update. | A broken update cannot disable its own rollback | Supervisor updates come only through the installer channel | M6 drills |
| DL-10 | When the phone arrives | **M7, after hardening.** The phone is a client of the authoritative coordinator. | An early PWA over a relay | Device keys and the Guard first. Avoid remote control before hardening. | No phone for many months | Your priority |
| DL-11 | Orchestration language | **TypeScript plus C# helpers** | Python ([12 §17.2](12-stack-and-contracts.md#172-a-limited-alternative)) | SDK support, shared types | Two languages | — |
| DL-12 | Coordinator process type (v1) | **Per-user background process** | A Windows service | Session 0 isolation. Direct access to your resources. | Signed-out gap | — |
| DL-13 | Workshop isolation baseline | **WSL2 distro** (interop and automount off, no sudo), plus the tools' own sandboxes. **Windows Sandbox** for Windows-native tests. A restricted account as fallback. | Workers running as you with only the tools' sandboxes. Docker or Hyper-V VMs. | A real OS boundary, compatible with both coding CLIs' Linux sandboxes | WSL required | M0 red-team |
| DL-14 | Administrative operations | **One UAC batch per task.** Elevated Helper optional later. | An elevated core (rejected). A privileged service from day one. | No standing privileged backdoor. Few prompts. | You must be present for admin steps | — |
| DL-15 | Codex integration surface | **app-server first** (steer, interrupt, approvals, account state). SDK and `exec` secondary. | SDK only | Richest control. Approvals routed to policy. | Protocol pinned per CLI version | M0 schema and approval-name confirmation |
| DL-16 | Claude Code integration surface | **`claude -p` with `stream-json` inside WSL**, with configuration hygiene. The Agent SDK when billed by API key. | Agent SDK with a subscription login | The SDK note restricts claude.ai login for third-party products [V]. The sandbox needs WSL2 on Windows [V]. | Hygiene flags must be maintained | M0 behavior and terms |
| DL-17 | Upwork monitoring route | **Your alert emails through Gmail now.** The API if approved. **Never UI automation.** | Scraping (prohibited [V-S]) | Legitimate and available today | Depends on Upwork's alert content | API approval and job-search capability |
| DL-18 | Scheduler design | **In-house deterministic scheduler**, OS wake timers with a reliability test, and an optional calendar mirror | Task Scheduler as the primary scheduler. A cloud scheduler (not available in v1). | Control, evidence, testability | The PC must be on or wake-capable | M0 and M4 wake tests |
| DL-19 | Completion semantics | **Only the Verifier's evidence verdicts complete a task** | Trusting worker or model completion | R-25 | Some tasks end "partially completed" honestly | — |
| DL-20 | Boss model target | **Evaluate your requested Claude Opus 5 (`claude-opus-5`, now legacy) against Claude Opus 5.5 (`claude-opus-5-5`, current) in M0.** Recommend the current model unless evaluation favors the other. You decide. | Hard-coding either | No silent substitution. Evidence-based choice. | Evaluation cost in M0 | M0 boss evaluation |

## 20.2 Where I recommend differently from what the brief implies

1. **"The boss" is not one long model conversation.** It is application code that calls a model at decision points. This keeps identity, accountability, and state in software you own, which is what R-01 and R-28 actually require.
2. **Not one service per box in the system map.** A modular monolith, with process boundaries only where the OS, safety, or failure containment demand them. The brief permits this.
3. **Subscriptions are not the default for the boss.** The goal "prefer subscriptions where supported" is kept. But driving a consumer subscription from a custom, always-on assistant is exactly where support is uncertain: Anthropic's Agent SDK documentation restricts claude.ai login for third-party products [V], and OpenAI recommends API keys for programmatic workflows [V-S]. So the boss uses a capped API key, and subscriptions power the coding workers once M0 confirms that use.
4. **Not your existing browser session.** Chrome 136+ and Playwright deliberately prevent automating the default profile [V-S], and doing so would expose every session you have. Dedicated profiles instead, with a browser extension as a later, opt-in convenience.
5. **Broad access without broad standing privilege.** Brokered operations run as you (T1). Untrusted code runs sandboxed (T2). Administration runs behind consent (T3). This meets "work across my computer" without running the interface or plugins as administrator.
6. **Upwork monitoring uses only permitted routes.** This matches your brief.

## 20.3 Engineering limits and mitigations

| Limit | Why it exists | Mitigation or fallback | What you see |
|---|---|---|---|
| Models misinterpret and hallucinate | Inherent | Deterministic validation, grounding, effect ceilings, Verifier, evaluations | "Checking the result". Decision cards when it matters. |
| Prompt injection | Models follow text they read | Enforcement at E1 is independent of the model | "The document contained instructions, which I ignored" |
| Devices unavailable (locked, asleep, off) | Windows session and power model | Queueing, tested wake timers, calendar mirror, M7 | "Waiting for your PC to be unlocked" |
| Desktop work needs an unlocked session | Windows interactive desktop | Headless and API routes preferred | Same |
| Services deny API access or forbid automation | Provider policy | Permitted alternatives, owner-attended mode | "Blocked: this service doesn't allow automated use" |
| Steps only you can do (2FA, CAPTCHA, UAC, legal consent) | By design | Clear waits that resume automatically | "Needs you to approve the sign-in on your phone" |
| Ambiguous authorization | Language | Materiality test, grounding check, decision cards | "Ready for your decision" |
| Irreversible external effects | The real world | Pre-commit checks, write-ahead, reconciliation, compensation proposals | "Booked. Free cancellation until 11 Oct." |
| Finite budgets | Cost | Budgets, fallback chains, estimates labeled as such | "Budget reached: continue with up to X?" |
| Subscription usage not observable | Provider opacity | Usage labeled `unknown`. Rate-limit handling. | "Waiting for Codex quota (reset time not reported)" |
| Same-user code can bypass E1 (before M6) | OS security model | T2 isolation, minimal scopes, the Guard in M6 | A security level shown in Settings |
| Wake timers are unreliable on some PCs | Firmware, power settings | Test, show status, backup channels | "Wake tested ✓" or "Not tested" |
| UI automation is brittle | Apps and sites change | Structured routes first, fingerprints, the repair loop | "Adapting my procedure" |
| Local compute is slow | Hardware | Overnight runs. Cloud processing only if you allow it. | Honest time estimates |
| Models retire and APIs change | Vendor lifecycle | Lifecycle metadata, adapters, evaluations | Advance notice |
| Redaction is imperfect | Pattern limits | Capture and keep less | — |
| Backups hold deleted data until they expire | Backup semantics | Purge option, stated window | "Removed now. Backups clear by <date>." |

## 20.4 A capability limit versus work remaining

| Item | Kind | Notes |
|---|---|---|
| No connector for a service that has a public API | **Buildable** | The Workshop builds it |
| A service denies API access or prohibits automation | **External constraint** | Not buildable. Use permitted alternatives. |
| An app with a poor accessibility tree | Partly buildable | The visual route works, with lower reliability |
| Controlling other apps on the phone | **Platform constraint** | Limited by Android and iOS policy [U] |
| Alarms while the PC is off | **Hardware constraint** | Mitigated by the phone and cloud (buildable, M7) |
| CAPTCHA | **Deliberate constraint** | Never bypassed |
| Speech quality on weak hardware | Hardware constraint | A cloud option is work plus your privacy decision |
| Google restricted-scope verification | Provider process | Often avoidable with `drive.file` |
| Codex approval request names | **Verification work** | M0 |

## 20.5 Source verification notes

Every item was checked on **2026-09-25**. [V] means the official page was read directly. [V-S] means only search-result excerpts of the official page were available, because this environment's network policy blocked direct access to learn.microsoft.com, developers.openai.com and learn.chatgpt.com, developers.google.com, support.upwork.com, developer.chrome.com, and playwright.dev. The Codex URLs in your brief (learn.chatgpt.com, "ChatGPT Learn") correspond to the developers.openai.com Codex pages. Where possible, GitHub-hosted official sources were used instead.

| # | Claim | Status | Source | Used in |
|---|---|---|---|---|
| 1 | Claude Code `-p`: output formats, `--json-schema` → `structured_output`, `--resume`, permission modes, `--permission-prompts none` (v2.1.259+), `--bare` ignores subscription login, SIGTERM exit 143 and process-tree termination, `total_cost_usd` as a client-side estimate, `api_retry` categories | V | [code.claude.com/docs/en/headless](https://code.claude.com/docs/en/headless) | 06, 08 |
| 2 | The Agent SDK note restricting third-party claude.ai login and rate limits. Commercial Terms. Capabilities. | V | [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | 06 |
| 3 | Claude Code authentication: account types, precedence, Windows credential path, `claude setup-token` (one-year, scripts and CI, model requests only), `CLAUDE_CODE_OAUTH_TOKEN` | V | [Authentication](https://code.claude.com/docs/en/authentication) | 04, 06 |
| 4 | Claude Code sandbox: macOS, Linux, WSL2, **not native Windows**. Strict mode. Allowlist. Credential masking. WSL Windows-binary launch blocked by the seccomp filter. | V | [Sandboxing](https://code.claude.com/docs/en/sandboxing) | 06, 08 |
| 5 | Repository hooks, `env`, and `.mcp.json` run under `-p` or the SDK without a trust dialog. Mitigations: `--setting-sources user`, `--bare`, `disableAllHooks`. | V | [Permissions](https://code.claude.com/docs/en/permissions) | 06 |
| 6 | `SKILL.md` format and Agent Skills standard fields | V | [Skills](https://code.claude.com/docs/en/skills) | 07 |
| 7 | Current Claude models, IDs, prices, retirement dates. Claude Opus 5 listed as legacy. | V (the `claude-opus-5` ID: V-S) | [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) | 02, 06 |
| 8 | `computer_toolset_20260801`: the client executes actions, coordinate scaling, security precautions | V | [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | 05 |
| 9 | Tool search with `defer_loading` and custom client-side search | V | [Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) | 05 |
| 10 | API data retention: 30 days by default, ZDR by arrangement, flagged content up to 2 years | V-S | [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) | 03 |
| 11 | Codex SDK (`@openai/codex-sdk`): methods and options, wraps the CLI | V | [SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) | 06 |
| 12 | Codex app-server methods (`thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, `turn/steer`, `account/read`, `account/login`, `model/list`). Experimental flags. | V | [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) | 02, 06 |
| 13 | app-server transports, schema generation | V-S | developers.openai.com/codex/app-server | 06 |
| 14 | app-server approval request names and decisions | **U** (third-party reports) | — | 06 |
| 15 | `codex exec` flags: `--json`, `--output-schema`, `--sandbox workspace-write`, `exec resume` | V-S | developers.openai.com/codex/noninteractive | 06 |
| 16 | "Sign in with ChatGPT" on Plus, Pro, Business, Edu, Enterprise | V | [Codex README](https://github.com/openai/codex/blob/main/README.md) | 06 |
| 17 | API keys recommended for programmatic Codex workflows. `auth.json` or the OS store. | V-S | developers.openai.com/codex/auth | 06 |
| 18 | Codex native Windows sandbox, elevated and unelevated | V-S | developers.openai.com/codex/windows | 06, 08 |
| 19 | Session 0 isolation and the recommended alternatives | V-S | [Interactive services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services) | 01 |
| 20 | `SendInput` is subject to UIPI | V-S | [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) | 01, 04 |
| 21 | UIAccess requirements and capabilities | V-S | [UIAccess secure-location policy](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/user-account-control-only-elevate-uiaccess-applications-that-are-installed-in-secure-locations) | 04, 05 |
| 22 | Task Scheduler `WakeToRun`. The "Allow wake timers" setting. | V-S | [ITaskSettings WakeToRun](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-itasksettings-get_waketorun) | 10 |
| 23 | Windows Sandbox editions, `.wsb`, the `wsb` CLI (24H2) | V-S | [Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/) | 08 |
| 24 | `wsl.conf` interop and automount settings | V-S | [WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) | 08 |
| 25 | `KeyCredentialManager` / `RequestSignAsync`. A user-level, not app-level, boundary for desktop apps. | V-S | [KeyCredential.RequestSignAsync](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredential.requestsignasync), [Q&A](https://learn.microsoft.com/en-us/answers/questions/5912130/what-is-the-security-boundary-of-windows-hello-key) | 04 |
| 26 | Chrome 136+ ignores remote-debugging switches for the default data directory | V-S | [Chrome blog](https://developer.chrome.com/blog/remote-debugging-port) | 05 |
| 27 | Playwright: automating the default Chrome profile is not supported | V-S | [BrowserType](https://playwright.dev/docs/api/class-browsertype) | 05 |
| 28 | Drive `drive.file` is non-sensitive. `drive.readonly` is restricted and needs a security assessment. | V-S | [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) | 06 |
| 29 | OAuth consent screen in Testing status: 7-day refresh tokens | V-S | [Google Cloud help](https://support.google.com/cloud/answer/15549945) | 06 |
| 30 | Upwork automation guidance | V-S | [Upwork help](https://support.upwork.com/hc/en-us/articles/43342677368467-Use-bots-and-other-automation-properly) | 06, 11 |
| 31 | Upwork API: personal and internal use, about a one-week review, OAuth 2.0, GraphQL | V-S | [Requesting an API key](https://support.upwork.com/hc/en-us/articles/115015857647-How-to-request-an-API-key-from-Upwork), [Developer portal](https://www.upwork.com/developer) | 06, 11 |
| 32 | `sqlite-vec`: license and Windows support | V-S | [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) | 03, 12 |

**Still [I] or [U] and scheduled for M0:**

- UI Automation library choice and license (FlaUI).
- The Windows OCR and Windows.Graphics.Capture APIs.
- The injected-input flag in low-level hooks.
- Time-change notifications.
- Job Object behavior details.
- Recycle-Bin deletion APIs.
- whisper.cpp and model licenses.
- Electron footprint.
- The Node SQLite binding.
- Gmail and Calendar scope names and classifications.
- Google unverified-app user caps.
- OpenAI API retention terms.
- Speech-provider options.
- Windows Focus and Do Not Disturb interaction with alarm audio.
- Headed browser behavior while locked.
- Codex device-code login.
- Upwork job-search API availability.

## 20.6 Self-review against your intent (brief §49)

| Check | Answer | Where |
|---|---|---|
| A general-purpose assistant, not a workflow menu? | **Yes.** An open task loop, capability search, composition, and the development path, with no intent whitelist. M1 acceptance requires a hidden novel task. | [00 §1.4](00-product.md#14-general-capability-defined), [13 §18.4](13-build-plan.md#184-the-exact-boundaries-of-m1) |
| One coherent boss, with delegation? | **Yes.** One Boss Runtime owns contracts and outcomes. Workers take bounded work orders. Worker claims need evidence. | [02 §7](02-boss-and-tasks.md#7-boss-and-worker-coordination) |
| Windows, voice, images, broad access, a real interface? | **Yes.** Process topology, push-to-talk voice, the four image capabilities, T1–T3 access, and ten screens | [01 §4](01-architecture.md#4-windows-deployment), [09](09-interface-and-modalities.md), [05 §11.11](05-capabilities-and-execution.md#1111-broad-computer-access-and-its-honest-boundaries) |
| Can it handle an unfamiliar task? | **Yes.** Composition, exploration, then the Gap Resolver and the Workshop, and resume. | [07 §12.15](07-skills-and-learning.md#1215-the-capability-gap-resolver), [11 §S4](11-scenarios.md#s4-an-unfamiliar-task-that-requires-building-something) |
| Does a newly learned procedure become a skill or a revision? | **Yes.** Extraction with similarity checks, improvement proposals instead of duplicates | [07 §12.7](07-skills-and-learning.md#127-a-new-method-versus-a-one-time-parameter) |
| Is recursion measurable, bounded, and resumable? | **Yes.** L1–L4 artifacts and evidence, `LearningBounds`, cycle and no-progress detection, resume-after-build | [00 §1.6](00-product.md#16-recursive-learning-defined-operationally), [07 §12.13](07-skills-and-learning.md#1213-bounds-cycles-and-no-progress-detection) |
| Memory and rules durable, inspectable, correctable, provider-independent? | **Yes** | [03](03-memory.md), [04](04-policy-and-trust.md) |
| Mandatory rules enforced at real execution boundaries? | **Yes, at E1 from M1**, with E2 for untrusted code. The limit against same-user code is stated honestly until E3 in M6. | [04 §10.9](04-policy-and-trust.md#109-enforcement-levels-and-privilege-tiers) |
| Avoids unnecessary repeated approvals? | **Yes.** Explicit-instruction envelopes, standing permissions, "Always allow like this," a measured unnecessary-question rate | [04 §10.7](04-policy-and-trust.md#107-minimizing-approvals) |
| Status and external effects backed by evidence? | **Yes.** The Verifier-only completion transition, the action lifecycle, evidence grades | [02 §8.5–8.7](02-boss-and-tasks.md#85-task-state-machine), [14 §19.4](14-verification-and-observability.md#194-observability) |
| Broad access and self-modification without false guarantees? | **Yes.** Enforcement levels and privilege tiers, protected modules, honest residual risks | [04 §10.9](04-policy-and-trust.md#109-enforcement-levels-and-privilege-tiers), [08 §13.11](08-workshop-and-release.md#1311-self-improvement-of-jarvis-itself) |
| Subscriptions used where supported, without pretending they cover every API? | **Yes.** An explicit table and fallback chains. The unverified terms are flagged. | [06 §11.16](06-connectors-providers-budgets.md#1116-subscriptions-versus-api-billing) |
| Local-only availability described honestly? | **Yes.** Lifecycle table and alarm states | [01 §4.4](01-architecture.md#44-lifecycle-behavior), [10 §15.4](10-time-and-attention.md#154-delivery-depends-on-the-pcs-actual-state) |
| Phone and cloud possible without discarding the foundation? | **Yes.** NEP, stable IDs, a single-authority model | [01 §5](01-architecture.md#5-phone-and-cloud-extension) |
| Sources, assumptions, and decisions separated? | **Yes.** Tags, §20.5, §2.3, §20.8 | This document |
| Architecture-only instruction obeyed? | **Yes.** Documents only. No code, installs, connections, schedules, or inspection of your files. | [README](README.md) |

**Known weak spots**, stated plainly:

1. Until M6, code running as you could read tokens or alter policy (E1 only).
2. Whether your plans permit the coding workers' subscription use is unverified.
3. The quality of automatic skill extraction is unproven until M3.
4. Visual computer use reliability on *your* applications is unknown until M2.
5. Voice latency targets are unmeasured.
6. Effort estimates are low confidence.

## 20.7 Traceability

| Req | Requirement | Responsible components | Contracts and schemas | Acceptance tests | Milestone |
|---|---|---|---|---|---|
| R-01 | One boss, one identity, task ownership | Boss Runtime, Task Engine, Reporter | `TaskContract`, `WorkOrder`/`WorkerResult` | F07, F30 | M1 |
| R-02 | Windows first | Launcher, Session Agent, Exec Host | NEP | F11, F48 | M1–M2 |
| R-03 | Phone and continuous availability later | Device Link, NEP, stable IDs | `DeviceRegistration`, `CapabilityAdvertisement` | F28 | M7 |
| R-04 | Open-ended requests | Intent Interpreter, Planner, Registry search, Gap Resolver | `TaskContract`, `CapabilityDescriptor` | F04 plus a novel task per milestone | M1 |
| R-05 | Codex and Claude Code as workers | Worker Supervisor, adapters, Workshop, MCP Gateway | `WorkOrder`, `DevWorkOrder` | F04, F07, F51 | M1–M2 |
| R-06 | Subscriptions preferred, budgets, fallbacks | Model Gateway, budget ledger | `Budget`, `UsageLedgerEntry`, fallback chains | F12, F45 | M1 |
| R-07 | Voice, text, images, files, interface | Console, Session Agent, STT/TTS/vision adapters | UI↔Coordinator, `Message` | F25, F26, F44 | M1, M5 |
| R-08 | Broad computer access | Exec Host, Session Agent, Browser Runtime, connectors, UAC batch | NEP, `ProcessRequest`, `CapabilityDescriptor` | F09, F10, F42, F43 | M1–M2 |
| R-09 | Persistent memory and rules | Memory Service, Policy Engine, backups | `MemoryRecord`, `OwnerRule` | F02, F21, F22, F36 | M1 |
| R-10 | Learned methods become skills | Learning Service, Skill Runtime, Release Manager | Skill manifest, `SkillExecutionRecord` | F05, F06 | M3 |
| R-11 | Create software and tools | Workshop, Gap Resolver | `DevWorkOrder`, `PromotionEvidence` | F04, F17, F45 | M1 |
| R-12 | Controlled self-improvement | Release Manager, Update Supervisor | `ReleaseRecord`, `ImprovementProposal` | F23, F47 | M6 |
| R-13 | Suggestions and recurring work | Scheduler, monitors, attention model | `ScheduledJob`, `Monitor`, `Suggestion` | F19, F20, F41 | M4 |
| R-14 | No repeated approvals for authorized work | Policy Engine (envelopes, standing permissions) | `AuthorizationEnvelope`, `DecisionRequest` | F14, boss evaluation (unnecessary-question rate) | M1–M2 |
| R-15 | Accurate status, cost, limits | Verifier, Reporter, budget ledger | `EvidenceRecord`, `UsageReport` | F07, F12, F13 | M1 |
| R-16 | Design first | (process) | — | — | Now |
| R-17 | Decide, authorize, execute, verify separated | Boss, Policy Engine, Broker, Verifier | `AuthorizationDecision`, `NepInvoke`, `ToolResult` | F03, F07, F15 | M1 |
| R-18 | Mid-task correction | Conversation Manager, Task Engine, Broker fencing | Contract revision, `work_order.revised` | F02, F03, steering tests | M1 |
| R-19 | Durable task engine | Task Engine, Event Store | `TaskContract`, `PlanStep`, `Event` | F01, F31 | M1 |
| R-20 | Deterministic scheduling | Scheduler, Exec Host wake timers | `ScheduledJob` | F18, F33, F34, F49 | M1, M4 |
| R-21 | Inspect, edit, export, delete memory | Memory Service, Console | `MemoryCorrection`, export archive | F21, F54 | M1 |
| R-22 | Rules enforced at dispatch and pre-commit | Policy Engine, Broker | `AuthorizationDecision` | F03, F14 | M1–M2 |
| R-23 | Untrusted content is never an instruction | Trust labels, memory guard, grounding | `Event` trust labels, `MemoryProposal` | F15, F46, F53 | M1 |
| R-24 | Isolated development, controlled release | Workshop, Release Manager | `DevWorkOrder`, `ReleaseRecord` | F16, F24 | M1, M3 |
| R-25 | No false completion | Verifier, Reporter wording guard | `SuccessCriterion`, `EvidenceRecord` | F07 | M1 |
| R-26 | Bounded recursion and budgets | Gap Resolver, `LearningBounds`, Model Gateway | `LearningBounds`, `Budget` | F27, F45 | M1, M3 |
| R-27 | Local-first without a future rewrite | Coordinator, NEP, IDs | `NepInvoke`, `Event` | F28 | M1, M7 |
| R-28 | Provider changes preserve everything | Model Gateway, neutral transcript | `ReasoningRequest` | F30, F52 | M1 |
| R-29 | No bypass of service restrictions | Router fallback rules, service policies | `ServicePolicy` | F10, S2 route test | M2, M4 |
| R-30 | Controls and accessibility | Console, Session Agent | UI contract | F09, F44, F48 | M1–M2 |

## 20.8 Owner decisions

Six decisions materially change cost, privacy, autonomy, or deployment. Each has a proposed default.

1. **Boss model and billing.** Use an Anthropic API key with a monthly hard cap that you set, and choose between your requested Claude Opus 5 (legacy) and Claude Opus 5.5 (current) on M0 evaluation evidence.
   *Default:* API key, your cap, Opus 5.5 unless the evaluation favors Opus 5.
   *Effect:* Predictable, visible spend. No dependence on unverified subscription terms for the component that runs all day.
2. **Coding-worker billing.** Use your Claude and ChatGPT subscriptions for the Claude Code and Codex workers inside the Workshop *if* the M0 terms review confirms this personal use is permitted, plus a small API fallback budget.
   *Default:* yes, with a fallback cap you set.
   *Effect:* Uses what you already pay for. No silent paid overflow.
3. **Privacy posture.** Which memory categories may reach the cloud boss model, and whether speech recognition is local or cloud.
   *Default:* `normal` and `personal` may go to the boss provider. `sensitive` only when a task needs it and only to providers you list. `restricted` is local-only. Local speech recognition.
   *Effect:* A balance between answer quality and data exposure.
4. **Initial autonomy and protection.** The standing permissions to start with (default: none for `spend`, `commit`, `communicate`, `publish`, `access_control`). Which rules are *protected* (suggested: archive folders, public sharing, spending limits). Whether to pull the Guard hardening forward from M6 to M2, for example if you plan to connect financial accounts early.
   *Effect:* Prompt frequency against risk.
5. **Environment baseline.** Confirm your Windows edition (Home or Pro), allow WSL2 with a dedicated JARVIS distro, and, on Pro, Windows Sandbox.
   *Default:* WSL2 Workshop (W1), plus Windows Sandbox (W2) on Pro.
   *Effect:* Determines how strongly generated code is isolated.
6. **Availability ambition.** Stay local-only until M7, then choose topology A (the PC stays authoritative, with an end-to-end-encrypted relay: more private) or B (a cloud-authoritative coordinator: always on).
   *Default:* decide at M6, leaning towards A unless always-on monitoring is essential to you.
   *Effect:* Privacy against continuous availability.

## 20.9 The first implementation milestone

The exact in-scope and out-of-scope lists are in [13 §18.4](13-build-plan.md#184-the-exact-boundaries-of-m1).

In one sentence: **M1 is a general, voice-and-text Windows assistant with durable tasks, inspectable memory, enforced rules, file, shell, and web execution, honest status, restart recovery, reminders while the PC is on, and a sandboxed development path that builds missing tools and resumes the original task.** It is not a set of fixed automations. It comes after M0 verifies the integration assumptions and you make the six decisions above.

## 20.10 Status and continuation

- **Complete in this draft.** All 20 deliverables, each with a substantive design ([README](README.md#documents-and-deliverables)).
- **Not complete, by design.** Everything tagged [U], and the account-level checks in M0 (§20.5). The six owner decisions (§20.8).
- **Next.** Your decisions, then the M0 spikes, then Draft 2 of this specification, incorporating the verification report. Implementation begins only after that, and only with your go-ahead.
