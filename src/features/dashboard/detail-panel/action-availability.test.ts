import { describe, expect, it } from "vitest";
import type { AgentActionType } from "@/domain/agent/actions";
import type { Agent } from "@/domain/agent/agent";
import { NO_CONTROL_CHANNEL_REASON, resolveActionAvailability } from "./action-availability";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "thread-1",
    displayName: "메인 세션",
    source: "codex",
    role: "main",
    project: { cwd: "/Users/dev/project", name: "project", repoUrl: null },
    branch: "main",
    commitSha: "0123456789abcdef",
    model: "gpt-5",
    reasoningEffort: "high",
    status: { kind: "running", startedAt: "2026-07-10T11:00:00.000Z", lastHeartbeatAt: "2026-07-10T11:59:00.000Z" },
    currentTask: "테스트 실행 중",
    tokensUsed: 1000,
    costUsd: null,
    startedAt: "2026-07-10T11:00:00.000Z",
    updatedAt: "2026-07-10T11:59:00.000Z",
    lastHeartbeatAt: "2026-07-10T11:59:00.000Z",
    runtimePids: [4242],
    parentId: null,
    childIds: [],
    cliVersion: "0.50.0",
    approvalMode: "on-request",
    rolloutPath: "/Users/dev/.codex/sessions/rollout.jsonl",
    ...overrides,
  };
}

const NO_CONTROL_CHANNEL_ACTIONS: AgentActionType[] = ["retry", "approve", "reject"];
const PROCESS_SIGNAL_ACTIONS: AgentActionType[] = ["stop", "pause", "resume"];
const WORKING_DIRECTORY_ACTIONS: AgentActionType[] = ["open_terminal", "view_diff", "create_pr", "open_pr"];

describe("resolveActionAvailability", () => {
  it.each(NO_CONTROL_CHANNEL_ACTIONS)("disables %s unconditionally — the backend always skips it", (action) => {
    const availability = resolveActionAvailability(makeAgent(), action);
    expect(availability).toEqual({ isDisabled: true, reason: NO_CONTROL_CHANNEL_REASON });
  });

  it.each(NO_CONTROL_CHANNEL_ACTIONS)("keeps %s disabled even for a fully healthy agent", (action) => {
    const agent = makeAgent({ runtimePids: [1, 2, 3], status: { kind: "failed", error: "x", retryCount: 1, failedAt: "2026-07-10T11:00:00.000Z" } });
    expect(resolveActionAvailability(agent, action).isDisabled).toBe(true);
  });

  it.each(PROCESS_SIGNAL_ACTIONS)("enables %s when the agent has observed pids", (action) => {
    expect(resolveActionAvailability(makeAgent(), action)).toEqual({ isDisabled: false, reason: null });
  });

  it.each(PROCESS_SIGNAL_ACTIONS)("disables %s with a reason when no process was observed", (action) => {
    const availability = resolveActionAvailability(makeAgent({ runtimePids: [] }), action);
    expect(availability.isDisabled).toBe(true);
    expect(availability.reason).toContain("실행 중인 Codex 프로세스");
  });

  it.each(WORKING_DIRECTORY_ACTIONS)("enables %s when the working directory resolves", (action) => {
    expect(resolveActionAvailability(makeAgent({ runtimePids: [] }), action)).toEqual({ isDisabled: false, reason: null });
  });

  it.each(WORKING_DIRECTORY_ACTIONS)("disables %s when the agent has no working directory", (action) => {
    const agent = makeAgent({ project: { cwd: "", name: "(작업 디렉터리 없음)", repoUrl: null } });
    const availability = resolveActionAvailability(agent, action);
    expect(availability.isDisabled).toBe(true);
    expect(availability.reason).toContain("작업 디렉터리");
  });
});
