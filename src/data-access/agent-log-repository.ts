import type { AgentLogsResponse } from "@/domain/agent/logs";

/**
 * Read side of a single agent's activity log. Implementations resolve the rollout file path from
 * their own current snapshot — never from caller-supplied input — so a request can't steer the
 * reader at an arbitrary path.
 */
export interface AgentLogRepository {
  readLines(agentId: string, limit: number): Promise<AgentLogsResponse>;
}
