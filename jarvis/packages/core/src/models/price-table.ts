/**
 * Dated price table (06 §11.17), used only for ESTIMATES. The provider's billing is
 * authoritative. USD per million tokens, checked 2026-09-25.
 */
export interface ModelInfo {
  id: string; provider: "anthropic"; input_per_mtok: number; output_per_mtok: number; cache_read_multiplier: number;
  context_tokens: number; max_output_tokens: number; retirement_not_before?: string; status: "active" | "legacy";
  thinking: "always_on" | "adaptive_default" | "optional";
}

export const PRICE_TABLE_DATE = "2026-09-25";
export const MODELS: Record<string, ModelInfo> = {
  "claude-opus-5-5": { id: "claude-opus-5-5", provider: "anthropic", input_per_mtok: 4, output_per_mtok: 20, cache_read_multiplier: 0.05, context_tokens: 1_000_000, max_output_tokens: 128_000, retirement_not_before: "2027-09-22", status: "active", thinking: "always_on" },
  "claude-opus-5": { id: "claude-opus-5", provider: "anthropic", input_per_mtok: 5, output_per_mtok: 25, cache_read_multiplier: 0.1, context_tokens: 1_000_000, max_output_tokens: 128_000, status: "legacy", thinking: "adaptive_default" },
  "claude-sonnet-5": { id: "claude-sonnet-5", provider: "anthropic", input_per_mtok: 2, output_per_mtok: 10, cache_read_multiplier: 0.1, context_tokens: 1_000_000, max_output_tokens: 128_000, status: "active", thinking: "adaptive_default" },
  "claude-haiku-4-5-20251001": { id: "claude-haiku-4-5-20251001", provider: "anthropic", input_per_mtok: 1, output_per_mtok: 5, cache_read_multiplier: 0.1, context_tokens: 200_000, max_output_tokens: 64_000, retirement_not_before: "2026-10-15", status: "active", thinking: "optional" },
  "claude-fable-5-1": { id: "claude-fable-5-1", provider: "anthropic", input_per_mtok: 10, output_per_mtok: 50, cache_read_multiplier: 0.025, context_tokens: 1_000_000, max_output_tokens: 128_000, status: "active", thinking: "always_on" },
};

export function estimateCostUsd(model: string, tokens: { input: number; output: number; cache_read?: number }): number | null {
  const m = MODELS[model];
  if (!m) return null;
  const input = Math.max(0, tokens.input - (tokens.cache_read ?? 0));
  return (input * m.input_per_mtok + (tokens.cache_read ?? 0) * m.input_per_mtok * m.cache_read_multiplier + tokens.output * m.output_per_mtok) / 1e6;
}
