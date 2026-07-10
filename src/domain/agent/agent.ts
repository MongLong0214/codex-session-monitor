import { z } from "zod";
import { AgentStatusSchema } from "./status";

export const ProjectRefSchema = z.object({
  /** Canonical absolute working directory — the real grouping key (git_branch/cwd from Codex state DB). */
  cwd: z.string(),
  /** Derived from repo origin URL when available, otherwise the last path segment of cwd. */
  name: z.string(),
  repoUrl: z.string().nullable(),
});
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  /** Which CLI produced this session — the always-present discriminator between the two sources. */
  source: z.enum(["codex", "claude_code"]),
  role: z.enum(["main", "subagent"]),
  project: ProjectRefSchema,
  branch: z.string().nullable(),
  commitSha: z.string().nullable(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  status: AgentStatusSchema,
  currentTask: z.string().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  /**
   * Null unless a pricing table is configured — Codex's state DB has no cost figures,
   * so real/local mode never fabricates a dollar amount (see data-access/local-adapter.ts).
   */
  costUsd: z.number().nonnegative().nullable(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
  runtimePids: z.array(z.number().int()),
  parentId: z.string().nullable(),
  childIds: z.array(z.string()),
  cliVersion: z.string().nullable(),
  approvalMode: z.string().nullable(),
  rolloutPath: z.string(),
});
export type Agent = z.infer<typeof AgentSchema>;
export type AgentId = Agent["id"];
