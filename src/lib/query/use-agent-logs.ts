import { useQuery } from "@tanstack/react-query";
import type { AgentId } from "@/domain/agent/agent";
import { DEFAULT_AGENT_LOG_LIMIT } from "@/domain/agent/logs";
import { fetchAgentLogs } from "./api";
import { agentKeys } from "./keys";

/** No SSE channel carries log lines, so an open Logs tab polls; a closed one costs nothing. */
const LOG_POLL_INTERVAL_MS = 5_000;

interface UseAgentLogsOptions {
  /** Lazy-load contract: false until the panel is open AND the Logs tab is the active one. */
  isEnabled: boolean;
  limit?: number;
}

export function useAgentLogs(agentId: AgentId, { isEnabled, limit = DEFAULT_AGENT_LOG_LIMIT }: UseAgentLogsOptions) {
  return useQuery({
    queryKey: agentKeys.logs(agentId, limit),
    queryFn: ({ signal }) => fetchAgentLogs(agentId, limit, signal),
    enabled: isEnabled,
    refetchInterval: isEnabled ? LOG_POLL_INTERVAL_MS : false,
    /** A tab revisit within one poll window reuses the cache instead of flashing a spinner. */
    staleTime: LOG_POLL_INTERVAL_MS,
  });
}
