import type { AgentCommandRepository } from "./agent-command-repository";
import type { AgentLogRepository } from "./agent-log-repository";
import type { DashboardRepository } from "./dashboard-repository";
import { localAgentCommandRepository, localDashboardRepository } from "./local-adapter";
import { localAgentLogRepository } from "./local-agent-logs";

/**
 * Single wiring point for the route handlers. Module-level singletons are correct here because the
 * adapter's snapshot cache and revision counter are per-process state, and this tool is by design a
 * single local process.
 */
export const dashboardRepository: DashboardRepository = localDashboardRepository;
export const agentCommandRepository: AgentCommandRepository = localAgentCommandRepository;
export const agentLogRepository: AgentLogRepository = localAgentLogRepository;
