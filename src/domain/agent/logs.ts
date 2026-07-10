import { z } from "zod";

/**
 * Codex's rollout JSONL vocabulary carries no severity field. Grepping real rollout files on this
 * machine yields only `task_started`, `task_complete`, `agent_message`, `sub_agent_activity`,
 * `token_count`, `patch_apply_end` and tool-call events — none of them marks a line as an error or
 * a warning. The local reader can therefore only ever justify "info"; the other two members exist
 * so the log filter is built for the full vocabulary a richer adapter could supply. Mirrors the
 * LocalStatusKind narrowing in data-access/local-adapter.ts.
 */
export const AgentLogLevelSchema = z.enum(["info", "warning", "error"]);
export type AgentLogLevel = z.infer<typeof AgentLogLevelSchema>;

/** The subset the local rollout reader can prove. Makes the gap a compile-time guarantee. */
export type LocalAgentLogLevel = Extract<AgentLogLevel, "info">;

export const AgentLogLineSchema = z.object({
  /** Stable within one response (source line ordinal), so the list has a key that is not the index. */
  id: z.string(),
  /** Null when a rollout entry carries no parseable timestamp — never back-filled with `now`. */
  timestamp: z.iso.datetime().nullable(),
  level: AgentLogLevelSchema,
  text: z.string(),
});
export type AgentLogLine = z.infer<typeof AgentLogLineSchema>;

export const AgentLogsResponseSchema = z.object({
  agentId: z.string(),
  /** Chronological (oldest first), already clamped to the requested limit. */
  lines: z.array(AgentLogLineSchema),
  /** True when older lines exist beyond what the tail read returned — the history is not complete. */
  isTruncated: z.boolean(),
});
export type AgentLogsResponse = z.infer<typeof AgentLogsResponseSchema>;

export const DEFAULT_AGENT_LOG_LIMIT = 500;
export const MAX_AGENT_LOG_LIMIT = 2_000;

export const AgentLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_AGENT_LOG_LIMIT).default(DEFAULT_AGENT_LOG_LIMIT),
});
export type AgentLogQuery = z.infer<typeof AgentLogQuerySchema>;
