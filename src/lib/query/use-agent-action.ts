import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AgentActionRequest,
  AgentActionResult,
  BulkAgentActionRequest,
  BulkAgentActionResponse,
} from "@/domain/agent/actions";
import type { Agent, AgentId } from "@/domain/agent/agent";
import type { AgentStatus } from "@/domain/agent/status";
import type { DashboardSnapshot } from "@/domain/dashboard";
import { postAgentAction, postBulkAgentAction } from "./api";
import { dashboardKeys } from "./keys";

export type OptimisticStatus = AgentStatus | ((current: Agent) => AgentStatus);

export interface AgentActionVariables {
  agentId: AgentId;
  request: AgentActionRequest;
  /**
   * Omit to send the action without touching the cache — the call mode `stop` uses, since it is
   * confirmed by a dialog and its outcome is not predictable. Provide it (e.g. for pause/resume)
   * to patch `byId[agentId].status` until the server reconciles.
   */
  optimisticStatus?: OptimisticStatus;
}

interface AgentActionContext {
  previousSnapshot: DashboardSnapshot | undefined;
}

function resolveStatus(optimisticStatus: OptimisticStatus, current: Agent): AgentStatus {
  return typeof optimisticStatus === "function" ? optimisticStatus(current) : optimisticStatus;
}

/**
 * Generic optimistic-update-with-rollback plumbing; the caller decides per invocation whether an
 * action is safe to predict. No action is special-cased and no confirmation dialog lives here —
 * that is the UI layer's call.
 *
 * The optimistic write replaces exactly one `byId` entry, preserving the reference invariant the
 * realtime reducer depends on. `onSettled` always reconciles against the server, so an action the
 * backend answers with "skipped" (retry/approve/reject have no control channel to a Codex process)
 * snaps back to real state rather than lingering as a lie.
 */
export function useAgentAction() {
  const queryClient = useQueryClient();

  return useMutation<AgentActionResult, Error, AgentActionVariables, AgentActionContext>({
    mutationFn: ({ agentId, request }) => postAgentAction(agentId, request),

    onMutate: async ({ agentId, optimisticStatus }) => {
      if (optimisticStatus === undefined) {
        return { previousSnapshot: undefined };
      }

      // An in-flight snapshot refetch would otherwise land after this write and clobber it.
      await queryClient.cancelQueries({ queryKey: dashboardKeys.snapshot() });

      const previousSnapshot = queryClient.getQueryData<DashboardSnapshot>(dashboardKeys.snapshot());
      const current = previousSnapshot?.byId[agentId];
      if (!previousSnapshot || !current) {
        return { previousSnapshot };
      }

      queryClient.setQueryData<DashboardSnapshot>(dashboardKeys.snapshot(), {
        ...previousSnapshot,
        byId: { ...previousSnapshot.byId, [agentId]: { ...current, status: resolveStatus(optimisticStatus, current) } },
        revision: previousSnapshot.revision + 1,
      });

      return { previousSnapshot };
    },

    onError: (_error, _variables, context) => {
      if (context?.previousSnapshot) {
        queryClient.setQueryData(dashboardKeys.snapshot(), context.previousSnapshot);
      }
    },

    onSettled: () => queryClient.invalidateQueries({ queryKey: dashboardKeys.snapshot() }),
  });
}

/** No optimistic path: a bulk result is per-agent partial success, which cannot be predicted client-side. */
export function useBulkAgentAction() {
  const queryClient = useQueryClient();

  return useMutation<BulkAgentActionResponse, Error, BulkAgentActionRequest>({
    mutationFn: postBulkAgentAction,
    onSettled: () => queryClient.invalidateQueries({ queryKey: dashboardKeys.snapshot() }),
  });
}
