/**
 * Claude API token pricing, in US dollars per one million tokens.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-07-10).
 * This is a maintained, sourced fact table — update the rates here when Anthropic changes them,
 * not inside the adapter logic. Every rate below is verbatim from that page on that date.
 *
 * Unlike the Codex state DB (which carries no cost figures, so local-adapter.ts always returns
 * costUsd: null), Claude Code session transcripts carry real per-message token usage, so a real
 * dollar cost can be computed for any session whose models are all present in this table.
 */

/** Per-million-token rates for a single model. `null` for a model means "not priced — cost unknown". */
export interface ModelRates {
  /** Base (uncached) input tokens. */
  input: number;
  /** Writing tokens into the 5-minute ephemeral cache. */
  cacheWrite5m: number;
  /** Writing tokens into the 1-hour ephemeral cache. */
  cacheWrite1h: number;
  /** Reading tokens back out of any cache (a cache hit). */
  cacheRead: number;
  /** Output (generated) tokens. */
  output: number;
}

export const CLAUDE_MODEL_RATES: Record<string, ModelRates> = {
  /**
   * Introductory pricing in effect through 2026-08-31. After that date it rises to
   * input $3 / 5m-write $3.75 / 1h-write $6 / cache-read $0.30 / output $15 — intentionally NOT
   * encoded as a date-conditional switch here (out of scope); update these numbers when it changes.
   */
  "claude-sonnet-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
  "claude-opus-4-8": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
};

export function ratesForModel(model: string | null): ModelRates | null {
  return model ? (CLAUDE_MODEL_RATES[model] ?? null) : null;
}
