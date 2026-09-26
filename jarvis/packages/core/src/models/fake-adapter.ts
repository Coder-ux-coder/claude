import type { ReasoningAdapter, ReasoningEvent, ReasoningRequest } from "@jarvis/shared";

export type FakeTurn =
  | { text?: string; structured?: unknown; tool_calls?: { tool: string; input: unknown }[]; stop?: "end" | "tool_use" | "max_tokens" | "refusal"; tokens?: { input: number; output: number } }
  | ((req: ReasoningRequest) => FakeTurn);

/**
 * Deterministic scripted adapter for tests and offline mode: replays turns in order,
 * or computes them from the request. Records every request it received.
 */
export class FakeAdapter implements ReasoningAdapter {
  readonly requests: ReasoningRequest[] = [];
  constructor(readonly id: string, private turns: FakeTurn[] = [], private fallback?: (req: ReasoningRequest) => FakeTurn) {}
  push(...t: FakeTurn[]): void { this.turns.push(...t); }
  capabilities() { return { tools: true, vision: true, structured_output: true, max_context_tokens: 200_000, streaming: false, prompt_caching: false }; }
  async *run(req: ReasoningRequest, signal: AbortSignal): AsyncIterable<ReasoningEvent> {
    this.requests.push(req);
    if (signal.aborted) { yield { type: "stop", reason: "error" }; return; }
    let t = this.turns.shift() ?? this.fallback?.(req) ?? { text: "" };
    while (typeof t === "function") t = t(req);
    yield { type: "usage", usage: { tokens: t.tokens ?? { input: 100, output: 50 }, duration_ms: 1 } };
    if (t.stop === "refusal") { yield { type: "stop", reason: "refusal" }; return; }
    if (t.text) yield { type: "text_delta", text: t.text };
    for (const [i, c] of (t.tool_calls ?? []).entries()) yield { type: "tool_call", call_id: `call_${this.requests.length}_${i}`, tool: c.tool, input: c.input };
    if (t.structured !== undefined) yield { type: "structured_output", value: t.structured };
    yield { type: "stop", reason: t.stop ?? (t.tool_calls?.length ? "tool_use" : "end") };
  }
}
