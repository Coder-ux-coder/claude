# 06 · Provider Adapters, Connectors, Subscriptions, and Budgets

Deliverable 11, part 2. It covers brief §15 and §35. Terms are defined in the [README glossary](README.md#glossary). Verification tags are explained in the [README](README.md#verification-tags).

---

## 11.15 The common adapter contract

Every model, worker, speech, image, embedding, and service integration implements one contract. The boss never contains provider-specific code paths.

```ts
interface Adapter {
  id: string;                          // "anthropic.messages", "codex.app_server", "google.gmail"
  kind: "model" | "worker" | "stt" | "tts" | "image" | "embedding" | "connector";
  version: string;
  start(): Promise<void>;                               // spawn or initialize; check the pinned version
  authState(account?: string): Promise<{ state: "ok" | "needs_auth" | "expired" | "not_configured";
                                          expires_at?: string; identity?: string }>;
  createSession?(opts: object): Promise<SessionRef>;
  resumeSession?(ref: SessionRef): Promise<SessionRef>;
  invoke(req: object, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  cancel(ref: string): Promise<{ result: "cancelled" | "not_cancellable" | "already_done" }>;
  usage(ref: string): Promise<UsageReport>;             // actual, estimated, or unknown (§11.20)
  health(): Promise<CapabilityHealth[]>;
  mapError(e: unknown): StructuredError;                // into the shared vocabulary (05 §11.6)
  structuredOutput: "native" | "json_schema_flag" | "validate_and_repair";
  timeouts: { connect_s: number; first_event_s: number; total_s: number };
}

type AdapterEvent =
  | { type: "progress"; text: string; pct?: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call_id: string; tool: string; input: unknown }
  | { type: "artifact"; ref: ArtifactRef }
  | { type: "question"; text: string }
  | { type: "usage"; usage: UsageReport }
  | { type: "rate_limit"; reset_at?: string; detail: string }
  | { type: "error"; error: StructuredError }
  | { type: "done"; result?: unknown };
```

**Rate limits and quotas.** Provider signals are mapped to `rate_limited`, with the reset time when one is reported:

- HTTP 429 with `Retry-After`.
- Claude Code's `system/api_retry` stream event, whose `error` categories include `rate_limit`, `authentication_failed`, and `billing_error` [V: [headless docs](https://code.claude.com/docs/en/headless)].
- Codex account and rate-limit notifications [U].

The task moves to `waiting_for_quota` and shows the reset time only if the provider actually reported one.

## 11.16 Subscriptions versus API billing

**Facts that shape the design.**

- A ChatGPT or Claude subscription is **not** an API credit balance. API usage is billed separately, through the Claude Console or the OpenAI Platform [I].
- Claude Code authenticates with a Claude Pro, Max, Team, or Enterprise login, with a Console API key, or through cloud providers. `claude setup-token` issues a one-year subscription OAuth token "for CI pipelines, scripts, or other environments where interactive browser login isn't available." It is used through `CLAUDE_CODE_OAUTH_TOKEN` and "can only make model requests," so it cannot fetch claude.ai connectors [V: [Claude Code authentication](https://code.claude.com/docs/en/authentication)]. `--bare` mode ignores subscription credentials and needs an API key [V: [headless docs](https://code.claude.com/docs/en/headless)].
- Anthropic's Agent SDK documentation states: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."* SDK use is governed by the Commercial Terms [V: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)].
- Codex supports "Sign in with ChatGPT" on Plus, Pro, Business, Edu, and Enterprise plans [V: [Codex README](https://github.com/openai/codex/blob/main/README.md)]. API-key login is `codex login --with-api-key`, and the authentication docs recommend API keys for programmatic workflows such as CI/CD [V-S: [Codex authentication](https://developers.openai.com/codex/auth)].
- Being signed into a desktop app does not authorize a background service, and connectors installed in the Claude or ChatGPT apps are **not** available to JARVIS. JARVIS has its own connectors.

| Use | Route | Where charges appear | Status | Proposed default |
|---|---|---|---|---|
| Boss reasoning | Anthropic Messages API with an API key | Claude Console usage and invoices | [V] for the API and model IDs | **Default**, under a monthly hard cap you set |
| Boss reasoning, "subscription-first" alternative | `claude -p` with your subscription login acting as the boss runtime | Claude plan limits (not exposed as dollars) | Scripted use is documented. The Agent SDK note restricts *third-party products*. Whether this personal pattern fits your plan's terms is **[U]**. Also slower and less controllable. | Not default. Owner decision after M0 verification. |
| Claude Code Worker | `claude -p` (non-bare) with your subscription login in the Workshop | Claude plan limits | Documented for scripts [V]. Plan terms for this personal automation **[U]**. | Default if M0 confirms |
| Codex Worker | Codex app-server, SDK, or `exec` with ChatGPT sign-in in the Workshop | ChatGPT plan limits | Sign-in supported [V]. API keys recommended for CI [V-S]. Personal-automation terms **[U]**. | Default if M0 confirms |
| Coding fallback | Anthropic or OpenAI API key | Provider API billing | [V] / [U] | Only inside the development budget, per the fallback policy (§11.20) |
| Vision and computer use | Anthropic API | Claude Console | [V] | Shares the boss budget |
| Embeddings | Local model | None | Model choice **[U]** | Default |
| Speech-to-text | Local model, or a cloud API | None, or provider | **[U]** | Local default |
| Text-to-speech | Windows voices, or a cloud API | None, or provider | **[U]** | Windows voices |
| Image generation and editing | Provider API, to be chosen | Provider | **[U]** | Off until you choose |

**JARVIS never silently moves a task from a subscription to paid API usage.** The fallback chain is explicit, bounded, and shown (§11.20).

## 11.17 Model adapters

**Boss reasoning and fast reasoning (Anthropic Messages API).**

- Current models, checked 2026-09-25 [V: [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)]:
  - Claude Opus 5.5 `claude-opus-5-5`: $4 / $20 per million input / output tokens, 1M context, 128K max output, retirement not before 2027-09-22.
  - Claude Sonnet 5 `claude-sonnet-5`: $2 / $10.
  - Claude Haiku 4.5 `claude-haiku-4-5-20251001`: $1 / $5, retirement **not before 2026-10-15**.
  - Claude Fable 5.1 `claude-fable-5-1`: $10 / $50.
  - Claude Opus 5 is listed as **legacy, still available**. Its API ID `claude-opus-5` is confirmed via search excerpt [V-S].
  - Batch requests are 50% off, and prompt-cache reads cost a fraction of base input (5% for Opus 5.5).
- Prices go into a **dated price table** used only for *estimates* (§11.20). The provider's billing is authoritative.
- **Lifecycle tracking.** The Model Gateway stores each model's retirement date and warns well before it. Role migration runs through the evaluation suite ([14 §19.3](14-verification-and-observability.md#193-evaluation-plan)). Haiku 4.5's near retirement window is one reason `boss.fast` should be chosen by evaluation, not hard-coded.
- **Features used.** Tool use with strict schema adherence where available (the tool-search documentation refers to a "strict mode" [V]). Streaming. Prompt caching for stable prefixes (persona, rules block, tool specifications). The effort parameter, whose default is `medium` on Opus 5.5 [V]. The 1M context window is *available*, but JARVIS does not fill it by default. Compact context is cheaper and more reliable.

**Vision interpretation** uses the same models, since all current Claude models accept images [V].

**Computer use** uses `computer_toolset_20260801` on Claude 5.5-and-later models ([05 §11.13](05-capabilities-and-execution.md#1113-visual-computer-use)).

**Embeddings.** A local model chosen in M0 for quality, speed, and license. The interface is provider-neutral, and the model ID is stamped on every vector.

**Speech-to-text.**

- Interface: streaming partial transcripts, a final transcript, word-level confidence where available, and a custom vocabulary from entity names (kept local).
- Local option: a whisper.cpp-family model [I, MIT license to confirm] on CPU or GPU.
- Cloud options are evaluated in M0 for latency, accuracy, price, and data retention [U].

**Text-to-speech.** Windows voices through the Session Agent or Electron's Web Speech API [I]. Sentence-level streaming. Immediate stop on barge-in. Cloud neural voices are optional [U].

**Images** are four capabilities with different tools, costs, and privacy:

| Capability | Default tool | Cost | Privacy |
|---|---|---|---|
| Interpretation | Vision model | Metered | The image goes to the provider |
| OCR | Windows OCR (`Windows.Media.Ocr`) [I], vision model fallback | Free locally | Stays local |
| Generation | Provider to choose | Metered per image | Prompt goes to the provider |
| Editing | Provider to choose | Metered | Image goes to the provider |

## 11.18 Coding worker adapters

### Codex Worker

| Surface | What it offers | Verified |
|---|---|---|
| **Codex SDK** (TypeScript, `@openai/codex-sdk`) | `new Codex()`, `codex.startThread()`, `thread.run(...)`, `thread.runStreamed(...)`, `codex.resumeThread(threadId)`. Options include `workingDirectory`, `skipGitRepoCheck`, `outputSchema`, `env`, `config`. It wraps the `codex` CLI and exchanges JSONL events over stdio. Sessions persist under `~/.codex/sessions`. Streamed events include `item.completed` and `turn.completed`. | [V: [SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)] |
| **app-server** | A long-lived JSON-RPC 2.0 server (`codex app-server`) that powers the IDE integrations. Transports: stdio by default, WebSocket, Unix socket [V-S]. Methods include `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `turn/interrupt`, `turn/steer`, `account/read`, `account/login`, `model/list` [V: [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)]. A TypeScript or JSON schema can be generated from the installed CLI [V-S]. Some features are marked experimental [V]. | Mixed |
| **app-server approvals** | Server-initiated requests asking the client to approve command execution or file changes. Third-party integrations report the names `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`, with decisions `accept`, `acceptForSession`, `decline`, `cancel`. | **[U]**: confirm against the generated schema |
| **`codex exec`** | Non-interactive runs: `--json` (JSONL event stream), `--output-schema`, `--sandbox workspace-write`, `codex exec resume` | [V-S: [non-interactive mode](https://developers.openai.com/codex/noninteractive)] |
| **Windows sandbox** | Native modes. "Elevated" uses dedicated lower-privilege sandbox users, filesystem permission boundaries, and firewall rules. "Unelevated" uses a restricted token with ACLs. WSL is also supported. | [V-S: [Codex on Windows](https://developers.openai.com/codex/windows)] |
| **Authentication** | ChatGPT sign-in or API key. `codex login status`. Credentials in `~/.codex/auth.json` or the OS credential store. Device-code login for headless machines. | [V-S], device code [U] |

**Recommendation.** Use the **app-server** for the Codex Worker. It is the richest control surface: live steering, interruption, approval requests answered by JARVIS's Policy Engine, and account state. Pin it to the CLI version whose generated schema passed JARVIS's contract tests. Use the SDK for simpler fire-and-forget jobs, and `exec` for batches.

**Approval routing.** The adapter answers Codex's approval requests by consulting the work order: accept only inside the workspace and the declared effects, decline everything else. The Codex sandbox is defense in depth. JARVIS's own Workshop isolation ([08 §13.3](08-workshop-and-release.md#133-isolation-options)) is the primary boundary.

### Claude Code Worker

| Surface | What it offers | Verified |
|---|---|---|
| **`claude -p`** | Non-interactive runs. `--output-format text\|json\|stream-json` (streaming with `--verbose --include-partial-messages`). `--json-schema` returns `structured_output`. `--resume <session_id>`, `--continue`. `--allowedTools`. `--permission-mode` (for example `dontAsk`, `acceptEdits`, `auto`). `--permission-prompts none` (v2.1.259+). `--permission-prompt-tool`. `--mcp-config`. `--append-system-prompt`. `--settings`. `--bare`. | [V: [headless docs](https://code.claude.com/docs/en/headless)] |
| **Results and events** | JSON output includes `session_id`, usage, and `total_cost_usd`, described as a *client-side estimate that can differ from the bill*. Stream events include `system/init` (with a `capabilities` array), `system/api_retry`, `permission_denied`, and a final `result`. | [V] |
| **Stopping** | SIGTERM exits with code 143 and terminates the process tree of running Bash commands. SIGINT or the SDK's `interrupt()` ends the turn cleanly. A resumed session continues an unfinished turn. | [V] |
| **Agent SDK** | Python and TypeScript libraries with the same agent loop, `canUseTool` permission callbacks, hooks, `settingSources`, MCP servers, and sessions | [V] features. Package names [I] |
| **Sandbox** | Filesystem and network isolation for Bash, PowerShell, and Monitor commands and their children, on **macOS, Linux, and WSL2. Native Windows is not supported.** Strict mode (`allowUnsandboxedCommands: false`). Domain allowlist (`sandbox.network.allowedDomains`, `strictAllowlist`). Credential masking with sentinel substitution on Linux and WSL2. | [V: [sandboxing](https://code.claude.com/docs/en/sandboxing)] |
| **Authentication** | Subscription login inside WSL (a paste-the-code flow when the browser callback cannot reach WSL), or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (not read in bare mode), or an API key. `CLAUDE_CONFIG_DIR` relocates configuration and credentials. | [V] |

**Configuration hygiene matters.** In `claude -p` or SDK runs, repository-supplied hooks, `env` blocks, and helpers run without a trust dialog, and `.mcp.json` servers connect without asking [V: [permissions: what runs before you trust a folder](https://code.claude.com/docs/en/permissions)]. A generated or cloned repository could therefore carry code that runs on startup. JARVIS's default invocation is:

- `--setting-sources user`, so neither project settings nor `.mcp.json` are read.
- `--settings '{"disableAllHooks": true}'`.
- A JARVIS-supplied `--mcp-config` exposing only the MCP Gateway endpoint for this work order.
- `--append-system-prompt` with the work-order framing.
- A dedicated `CLAUDE_CONFIG_DIR` for the Workshop identity.

`--bare` is stricter but ignores subscription credentials, so it is used when the worker runs on an API key.

**Placement.** Because the Claude Code sandbox does not run on native Windows, the Claude Code Worker runs **inside the WSL2 Workshop distro**, with the Claude Code sandbox enabled in strict mode on top of JARVIS's own isolation.

### Common worker protocol

| Work order field | Codex (app-server) | Claude Code (`claude -p`) |
|---|---|---|
| Objective and framing | `turn/start` input | Prompt plus `--append-system-prompt` |
| Context package | `CONTEXT.md`, spec, and tests written into the workspace | Same |
| Allowed capabilities | MCP Gateway entry in the Codex configuration for this thread | `--mcp-config` |
| Output schema | `outputSchema` (SDK) or `--output-schema` (exec) | `--json-schema` |
| Progress | Notifications | `stream-json` events |
| Questions | The worker calls the JARVIS MCP tool `ask_boss`. Workers never contact you directly. | Same |
| Steering | `turn/steer` | Interrupt, then resume with the revision |
| Cancellation | `turn/interrupt`, then kill the process (Job Object or WSL process group) | SIGINT, then SIGTERM, then kill |
| Usage | Token counts. Cost `unknown` on a subscription, `estimated` on an API key. | Token counts. `total_cost_usd` labeled **estimated**. Plan usage `unknown`. |

## 11.19 Service connectors

### Google: Drive, Gmail, Calendar

- **OAuth setup.** You would create an OAuth client in your own Google Cloud project [U: current console flow]. While the consent screen is in **Testing** status, refresh tokens for test users expire after 7 days. Once **In production**, tokens generally last until revoked or left unused for a long period [V-S: [Google Cloud help: app audience](https://support.google.com/cloud/answer/15549945)]. Unverified-app warnings and user caps for sensitive or restricted scopes must be confirmed for single-owner use [U]. This is owner decision U-08.
- **Minimal scopes.**
  - Drive `drive.file` is **non-sensitive**, granting per-file access to files the app created or that you opened with it.
  - `drive.readonly` and `drive` are **restricted** and require a security assessment for verification [V-S: [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)].
  - Recommendation: start with `drive.file` plus explicit file or folder selection by you. Expand only if you want whole-Drive search and accept the trade-offs.
  - Gmail and Calendar read and send scopes are requested **separately**, so triage never implies send authority [U: exact scope names and classifications, M2].
- **Accounts.** Each Google account is its own `acc_…` record, and tasks bind exactly one. API tokens are separate from browser-profile cookies. Document contents are fetched per task into payloads or artifacts with retention. Credentials live only in the vault.
- **Refresh and revocation.** Automatic refresh. Disconnecting revokes the token at Google and deletes it locally.

### Upwork

- **Automation guidance** [V-S: [Upwork: use bots and other automation properly](https://support.upwork.com/hc/en-us/articles/43342677368467-Use-bots-and-other-automation-properly)]:
  - Bots, scrapers, crawlers, and extensions that automatically send requests or collect data are prohibited.
  - Job-alert or watcher tools that scrape or run searches can trigger enforcement.
  - An API key does not permit automation outside the approved use case.
  - Using browser or official-client OAuth tokens or session cookies in scripts is prohibited, as are calling website pages instead of approved endpoints, mixing credentials, exceeding rate limits, and background polling that resembles scraping.
  - Upwork does not approve exceptions for tools that automate interactions.
- **API access** [V-S: [Upwork API help](https://support.upwork.com/hc/en-us/articles/115015857647-How-to-request-an-API-key-from-Upwork)]:
  - Keys are requested per application.
  - Access is for personal and internal use only.
  - Review takes about a week.
  - OAuth 2.0 and a GraphQL API.
  - Whether job search is available to an approved personal key is **[U]**.
- **Connector design.** `connector:upwork.api` exists only if you are approved. Its scopes and rate limits come from the approval, and polling stays conservative and within the approved use case. The service policy is `ui_automation: prohibited`.
- **Reduced route.** Read Upwork's **own job-alert emails** in your inbox through the Gmail connector, parse, match, and notify. Links are for *you* to open. JARVIS does not fetch Upwork pages. Full scenario: [11 §S2](11-scenarios.md#s2-opportunity-monitoring-upwork).

### Generic MCP servers and future services

- External MCP servers can be wrapped as connectors. Unless first-party, they run at T2. Their tool descriptions are untrusted text. Their manifests declare effects, and the Release Manager reviews them.
- **Adding a service** means a connector plugin with descriptors, auth type, service policy, health probe, and reconciliation methods. The Boss Runtime is not modified.

## 11.20 Budgets, cost, and latency

**Budget hierarchy.** Owner (monthly, per provider and total) → provider account → task (`ai_cost_cap`) → work order → development project → monitor (daily) → category limits: image generation, speech processing, background monitors, concurrent model calls, and long-running builds.

```ts
interface Budget {
  budget_id: string;                   // bud_…
  scope: { level: "owner" | "provider" | "task" | "work_order" | "dev_project" | "monitor" | "category"; ref?: string };
  period?: "day" | "month" | "task";
  limit: Money; kind: "hard" | "soft";
  alert_at: number[];                  // e.g. [0.5, 0.8]
  fallback: FallbackPolicy;
}

interface UsageLedgerEntry {
  use_id: string;                      // use_…
  provider: string; account?: string; adapter: string; role: string;
  task_id?: string; work_order_id?: string;
  tokens?: { input: number; output: number; cache_read?: number; cache_write?: number };
  amount?: Money;
  kind: "actual" | "estimated" | "unknown";
  basis: string;                       // "provider usage report", "price table 2026-09-25", "subscription: not exposed"
  at: string;
}
```

**Three kinds of cost, never blended.**

| Kind | Source | Shown as |
|---|---|---|
| **Actual** | A provider billing or usage report, where one exists [U per provider] | "$1.84 billed" |
| **Estimated** | Token counts × a dated price table | "≈ $1.80 (estimate)" |
| **Unknown** | Subscription usage the provider does not expose | "Subscription, cost not reported" plus token counts |

**Pre-call enforcement.** Before each metered call, the Model Gateway estimates the maximum cost: input tokens times the input price, plus `max_output_tokens` times the output price. If that would exceed a hard budget, the call is refused with `budget_exhausted`. Soft budgets alert at the configured fractions.

**Explicit fallback chains, per role.**

```yaml
role: coding.worker
chain:
  - worker: claude_code          # subscription, if M0 confirms terms
  - worker: codex                # subscription, if M0 confirms terms
  - wait_for_reset: { max_wait: 6h, show_reset_time_if_reported: true }
  - ask_owner: { offer: "Use an API key for this task", cap: "<you set the amount>" }
never: [unbounded_paid_retry, silent_subscription_to_api_switch]
```

**Deterministic software first.** Scheduling, routing rules, deduplication, status polling, and simple transformations use no model. Models are woken by **events** (a process exited, a monitor found new items, a step failed), never to poll.

**Right-sized models.** `boss.reasoning` handles planning and genuine ambiguity. `boss.fast` handles classification, extraction, and summaries. The split is chosen by evaluation per role ([14 §19.3](14-verification-and-observability.md#193-evaluation-plan)), with no brand hierarchy.

**Context economy.** Compact context packages ([03 §9.9](03-memory.md#99-context-builder)). Prompt caching on stable prefixes. Summaries of long histories. No large transcript dumps to workers.

**Concurrency limits** (defaults, configurable): 4 concurrent model calls, 2 concurrent workers, 1 concurrent builder, and a daily model budget for monitors.

**Latency.** A voice request gets a fast acknowledgement (a template or `boss.fast`), with a target of about 1 s after speech ends, to be measured in M0. Answers stream. Long tasks run asynchronously with events. The acknowledgement never implies completion.

**At quota limits,** in this order and as configured: wait (showing the reset time when reported), switch to another *authorized* worker, use an approved API fallback within its cap, or ask you. JARVIS never produces an endless cascade of paid retries.
