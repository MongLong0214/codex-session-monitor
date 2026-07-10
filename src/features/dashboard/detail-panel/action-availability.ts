import type { AgentActionType } from "@/domain/agent/actions";
import type { Agent } from "@/domain/agent/agent";

/**
 * Why an action cannot run right now. These mirror the local adapter's own refusal paths
 * (data-access/local-adapter.ts) so a disabled button never contradicts what the server would answer.
 */
export const NO_CONTROL_CHANNEL_REASON =
  "이 모니터는 읽기 전용 관찰자입니다. 외부에서 실행된 세션에는 stdin/PTY 제어 채널이 없어 이 동작을 보낼 수 없습니다.";
const NO_RUNTIME_REASON = "작업 디렉터리에서 실행 중인 Codex 프로세스를 찾지 못했습니다.";
const NO_WORKING_DIRECTORY_REASON = "에이전트의 작업 디렉터리를 확인할 수 없습니다.";

/** ACTION_HANDLERS answers these with status "skipped" unconditionally — never "sometimes available". */
const NO_CONTROL_CHANNEL_ACTIONS = new Set<AgentActionType>(["retry", "approve", "reject"]);

/** signalAgentProcesses() short-circuits when the agent has no observed pids. */
const PROCESS_SIGNAL_ACTIONS = new Set<AgentActionType>(["stop", "pause", "resume"]);

export interface ActionAvailability {
  isDisabled: boolean;
  /** Surfaced as the button's tooltip; Button switches to aria-disabled so it stays focusable. */
  reason: string | null;
}

const AVAILABLE: ActionAvailability = { isDisabled: false, reason: null };

export function resolveActionAvailability(agent: Agent, action: AgentActionType): ActionAvailability {
  if (NO_CONTROL_CHANNEL_ACTIONS.has(action)) {
    return { isDisabled: true, reason: NO_CONTROL_CHANNEL_REASON };
  }

  if (PROCESS_SIGNAL_ACTIONS.has(action)) {
    return agent.runtimePids.length > 0 ? AVAILABLE : { isDisabled: true, reason: NO_RUNTIME_REASON };
  }

  return agent.project.cwd ? AVAILABLE : { isDisabled: true, reason: NO_WORKING_DIRECTORY_REASON };
}
