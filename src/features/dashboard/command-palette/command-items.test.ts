import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/domain/agent/agent";
import type { DashboardSnapshot } from "@/domain/dashboard";
import { buildCommandItems, COMMAND_GROUP, type CommandPaletteCallbacks } from "./command-items";

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    displayName: `agent-${overrides.id}`,
    source: "codex",
    role: "main",
    project: { cwd: "/repo/alpha", name: "alpha", repoUrl: null },
    branch: "main",
    commitSha: null,
    model: "gpt-5",
    reasoningEffort: null,
    status: { kind: "running", startedAt: "2026-07-10T00:00:00.000Z", lastHeartbeatAt: "2026-07-10T01:00:00.000Z" },
    currentTask: null,
    tokensUsed: 0,
    costUsd: null,
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T01:00:00.000Z",
    lastHeartbeatAt: "2026-07-10T01:00:00.000Z",
    runtimePids: [],
    parentId: null,
    childIds: [],
    cliVersion: null,
    approvalMode: null,
    rolloutPath: `/rollouts/${overrides.id}.jsonl`,
    ...overrides,
  };
}

function makeSnapshot(agents: Agent[]): DashboardSnapshot {
  const projectByCwd = new Map(agents.map((agent) => [agent.project.cwd, agent.project]));
  return {
    byId: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    allIds: agents.map((agent) => agent.id),
    projects: [...projectByCwd.values()],
    incidents: [],
    summary: { totalAgents: agents.length, activeProjects: projectByCwd.size, statusCounts: {} as never, sessionCostUsd: null },
    revision: 1,
    lastSyncedAt: "2026-07-10T01:00:00.000Z",
    warnings: [],
  };
}

function noopCallbacks(): CommandPaletteCallbacks {
  return {
    onOpenAgentDetail: vi.fn(),
    onApplyProjectFilter: vi.fn(),
    onApplyBranchFilter: vi.fn(),
    onSetTheme: vi.fn(),
    onSetDensity: vi.fn(),
    onRunAgentAction: vi.fn(),
  };
}

const AGENT_ALPHA = makeAgent({
  id: "alpha",
  project: { cwd: "/repo/alpha", name: "alpha", repoUrl: null },
  branch: "main",
  runtimePids: [123],
});
const AGENT_BETA = makeAgent({
  id: "beta",
  project: { cwd: "/repo/beta", name: "beta", repoUrl: null },
  branch: "dev",
  runtimePids: [],
});

describe("buildCommandItems", () => {
  it("always offers the theme and density commands", () => {
    const items = buildCommandItems({ snapshot: undefined, currentAgent: null, callbacks: noopCallbacks() });
    const ids = items.map((item) => item.id);

    expect(ids).toEqual(
      expect.arrayContaining(["theme:light", "theme:dark", "theme:system", "density:compact", "density:comfortable"]),
    );
  });

  it("emits searchable agent, project and branch items from the snapshot", () => {
    const items = buildCommandItems({
      snapshot: makeSnapshot([AGENT_ALPHA, AGENT_BETA]),
      currentAgent: null,
      callbacks: noopCallbacks(),
    });
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(byId.get("agent:alpha")?.auxiliaryData?.group).toBe(COMMAND_GROUP.agents);
    expect(byId.get("project:/repo/beta")?.label).toBe("beta");
    // deriveBranchOptions sorts branches; both agents contribute one each.
    expect(byId.get("branch:dev")?.auxiliaryData?.group).toBe(COMMAND_GROUP.branches);
    expect(byId.get("branch:main")).toBeDefined();
  });

  it("offers pause/resume/stop for a current agent with a live process but never retry", () => {
    const items = buildCommandItems({
      snapshot: makeSnapshot([AGENT_ALPHA]),
      currentAgent: AGENT_ALPHA,
      callbacks: noopCallbacks(),
    });
    const actionIds = items.filter((item) => item.id.startsWith("action:")).map((item) => item.id);

    expect(actionIds).toEqual(["action:pause", "action:resume", "action:stop"]);
    expect(actionIds).not.toContain("action:retry");
  });

  it("offers no current-agent actions when the agent has no observed process", () => {
    const items = buildCommandItems({
      snapshot: makeSnapshot([AGENT_BETA]),
      currentAgent: AGENT_BETA,
      callbacks: noopCallbacks(),
    });

    expect(items.some((item) => item.id.startsWith("action:"))).toBe(false);
  });

  it("wires each item's run closure to the matching callback", () => {
    const callbacks = noopCallbacks();
    const items = buildCommandItems({
      snapshot: makeSnapshot([AGENT_ALPHA]),
      currentAgent: AGENT_ALPHA,
      callbacks,
    });
    const run = (id: string) => items.find((item) => item.id === id)?.run();

    run("agent:alpha");
    run("project:/repo/alpha");
    run("branch:main");
    run("theme:dark");
    run("density:comfortable");
    run("action:stop");

    expect(callbacks.onOpenAgentDetail).toHaveBeenCalledWith("alpha");
    expect(callbacks.onApplyProjectFilter).toHaveBeenCalledWith("/repo/alpha");
    expect(callbacks.onApplyBranchFilter).toHaveBeenCalledWith("main");
    expect(callbacks.onSetTheme).toHaveBeenCalledWith("dark");
    expect(callbacks.onSetDensity).toHaveBeenCalledWith("comfortable");
    expect(callbacks.onRunAgentAction).toHaveBeenCalledWith(AGENT_ALPHA, "stop");
  });
});
