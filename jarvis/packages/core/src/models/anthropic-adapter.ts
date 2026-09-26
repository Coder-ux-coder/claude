import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import {
  JarvisError, toStructured,
  type NeutralMessage, type ReasoningAdapter, type ReasoningEvent, type ReasoningRequest, type StructuredError,
} from "@jarvis/shared";
import { MODELS } from "./price-table.js";

export interface AnthropicAdapterOptions {
  model: string;                                   // e.g. "claude-opus-5-5"
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Runs `fn` with the API key inside the vault boundary; the key is never stored here. */
  withKey<T>(fn: (key: string) => Promise<T>): Promise<T>;
  fetch?: typeof fetch;                            // tests inject a mock transport
  baseURL?: string;
}

/**
 * Anthropic Messages API adapter (06 §11.17). Opus 5.5 specifics: thinking cannot be
 * disabled (the `thinking` parameter is omitted; depth is set by `output_config.effort`,
 * sent explicitly); forced tool_choice is not supported (auto only); a `refusal` stop is
 * surfaced, never retried silently; thinking blocks are bound to the conversation, so the
 * exact assistant content is kept in `native` and sent back only to this adapter.
 */
export class AnthropicAdapter implements ReasoningAdapter {
  readonly id: string;
  constructor(private o: AnthropicAdapterOptions) { this.id = `anthropic:${o.model}`; }

  capabilities() {
    const m = MODELS[this.o.model];
    return { tools: true, vision: true, structured_output: true, max_context_tokens: m?.context_tokens ?? 200_000, streaming: true, prompt_caching: true };
  }

  /** Neutral transcript → Messages API params. Native blocks are reused only if this adapter produced them. */
  toMessages(transcript: NeutralMessage[]): Anthropic.MessageParam[] {
    return transcript.map(m => {
      if (m.role === "assistant" && m.native?.adapter === this.id) return { role: "assistant", content: m.native.content as Anthropic.ContentBlockParam[] };
      const content: Anthropic.ContentBlockParam[] = m.content.map(c => {
        switch (c.type) {
          case "text": return { type: "text", text: c.text };
          case "image": return { type: "image", source: { type: "base64", media_type: c.media_type as "image/png", data: c.data_base64 } };
          case "tool_call": return { type: "tool_use", id: c.call_id, name: c.tool, input: c.input as Record<string, unknown> };
          case "tool_result": return { type: "tool_result", tool_use_id: c.call_id, content: typeof c.output === "string" ? c.output : JSON.stringify(c.output), ...(c.is_error ? { is_error: true } : {}) };
        }
      });
      return { role: m.role, content };
    });
  }

  buildParams(req: ReasoningRequest): Anthropic.MessageCreateParamsNonStreaming {
    const system: Anthropic.TextBlockParam[] = req.system.map(b => ({ type: "text", text: b.text, ...(b.cacheable ? { cache_control: { type: "ephemeral" as const } } : {}) }));
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.o.model,
      max_tokens: req.limits.max_output_tokens,
      system,
      messages: this.toMessages(req.transcript),
      output_config: {
        effort: this.o.effort ?? "medium",
        ...(req.output_schema ? { format: (({ type, schema }) => ({ type, schema }))(jsonSchemaOutputFormat(req.output_schema as { type: "object" })) } : {}),
      },
    };
    if (req.tools?.length) {
      params.tools = req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }));
      params.tool_choice = { type: "auto" };      // forced tool_choice returns 400 on Opus 5.5
    }
    return params;
  }

  mapError(e: unknown): StructuredError {
    const src = { capability_id: this.id, executor: "model_gateway", node_id: "local" };
    if (e instanceof Anthropic.RateLimitError) {
      const ra = Number(e.headers?.get?.("retry-after") ?? NaN);
      return new JarvisError("rate_limited", "the model provider is rate limiting", { source: src, ...(Number.isFinite(ra) ? { retry_after_s: ra } : {}) }).structured;
    }
    if (e instanceof Anthropic.AuthenticationError) return new JarvisError("auth_required", "the Anthropic API key was rejected", { source: src }).structured;
    if (e instanceof Anthropic.PermissionDeniedError) return new JarvisError("external_refusal", "the API key lacks permission for this model", { source: src }).structured;
    if (e instanceof Anthropic.BadRequestError) return new JarvisError("invalid_input", `request rejected: ${e.message}`.slice(0, 300), { source: src }).structured;
    if (e instanceof Anthropic.NotFoundError) return new JarvisError("unsupported_operation", `model or endpoint not found: ${this.o.model}`, { source: src }).structured;
    if (e instanceof Anthropic.APIUserAbortError) return new JarvisError("cancelled", "request cancelled", { source: src }).structured;
    if (e instanceof Anthropic.APIConnectionError) return new JarvisError("transient_service_error", "cannot reach the model provider (network)", { source: src }).structured;
    if (e instanceof Anthropic.InternalServerError || (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500)) return new JarvisError("transient_service_error", "the model provider had an error", { source: src }).structured;
    return toStructured(e, src);
  }

  async *run(req: ReasoningRequest, signal: AbortSignal): AsyncIterable<ReasoningEvent> {
    const started = Date.now();
    let msg: Anthropic.Message;
    try {
      msg = await this.o.withKey(async key => {
        const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: req.limits.timeout_s * 1000, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), ...(this.o.baseURL ? { baseURL: this.o.baseURL } : {}) });
        return client.messages.create(this.buildParams(req), { signal });
      });
    } catch (e) {
      yield { type: "stop", reason: "error", error: e instanceof JarvisError ? e.structured : this.mapError(e) };
      return;
    }
    const u = msg.usage;
    yield { type: "usage", usage: { tokens: { input: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens,
      ...(u.cache_read_input_tokens ? { cache_read: u.cache_read_input_tokens } : {}), ...(u.cache_creation_input_tokens ? { cache_write: u.cache_creation_input_tokens } : {}) }, duration_ms: Date.now() - started } };
    if (msg.stop_reason === "refusal") { yield { type: "stop", reason: "refusal" }; return; }
    let text = "";
    for (const b of msg.content) {
      if (b.type === "text") { text += b.text; yield { type: "text_delta", text: b.text }; }
      else if (b.type === "tool_use") yield { type: "tool_call", call_id: b.id, tool: b.name, input: b.input };
    }
    if (req.output_schema && msg.stop_reason !== "max_tokens") {
      try { yield { type: "structured_output", value: JSON.parse(text) }; }
      catch { yield { type: "structured_output", value: { __unparseable: text.slice(0, 2000) } }; }
    }
    // The exact assistant content (including thinking blocks) for append-only continuity.
    yield { type: "native", native: { adapter: this.id, content: msg.content } };
    yield { type: "stop", reason: msg.stop_reason === "tool_use" ? "tool_use" : msg.stop_reason === "max_tokens" ? "max_tokens" : "end" };
  }
}
