import type { AgentActionRequest, AgentActionResult, AgentActionType } from "@/domain/agent/actions";

/**
 * Write side. Implementations resolve every process id and working directory from their own
 * current snapshot — never from caller-supplied input — so a request body can't steer a
 * signal or a child process at an arbitrary pid/path.
 */
export interface AgentCommandRepository {
  execute(agentId: string, request: AgentActionRequest): Promise<AgentActionResult>;
  executeBulk(agentIds: string[], action: AgentActionType, force?: boolean): Promise<AgentActionResult[]>;
}
