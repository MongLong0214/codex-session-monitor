import { describe, expect, it } from "vitest";
import type { Agent } from "@/domain/agent/agent";
import type { AgentStatus } from "@/domain/agent/status";
import type { AgentStatusKind } from "@/domain/agent/status";
import { AgentStatusKindSchema } from "@/domain/agent/status";
import type { DashboardSnapshot } from "@/domain/dashboard";
import type { Incident } from "@/domain/incident/incident";
import {
  agentActivityAt,
  collectCriticalIncidentAgentIds,
  compareAgents,
  compareByDefault,
  deriveBranchOptions,
  EMPTY_AGENT_TABLE_FILTERS,
  isSortableColumn,
  matchesFilters,
  matchesSearch,
  selectVisibleAgentIds,
  statusActivityAt,
  type AgentTableFilters,
} from "./filter-sort";

const NO_CRITICAL_AGENTS: ReadonlySet<string> = new Set();

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

function makeSnapshot(agents: Agent[], incidents: Incident[] = []): DashboardSnapshot {
  return {
    byId: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    allIds: agents.map((agent) => agent.id),
    projects: [],
    incidents,
    summary: {
      totalAgents: agents.length,
      activeProjects: 0,
      statusCounts: Object.fromEntries(AgentStatusKindSchema.options.map((kind) => [kind, 0])) as Record<
        AgentStatusKind,
        number
      >,
      sessionCostUsd: null,
    },
    revision: 1,
    lastSyncedAt: "2026-07-10T01:00:00.000Z",
    warnings: [],
  };
}

function makeIncident(overrides: Partial<Incident> & Pick<Incident, "id">): Incident {
  return {
    severity: "critical",
    type: "stale_heartbeat",
    detectedAt: "2026-07-10T01:00:00.000Z",
    affectedAgentIds: [],
    affectedProjectIds: [],
    summary: "",
    evidence: "",
    suggestedAction: "",
    ...overrides,
  };
}

describe("statusActivityAt", () => {
  const cases: [AgentStatus, string | null][] = [
    [{ kind: "running", startedAt: "2026-01-01T00:00:00.000Z", lastHeartbeatAt: "2026-01-01T09:00:00.000Z" }, "2026-01-01T09:00:00.000Z"],
    [{ kind: "waiting", since: "2026-01-01T02:00:00.000Z" }, "2026-01-01T02:00:00.000Z"],
    [{ kind: "approval_required", requestedAt: "2026-01-01T03:00:00.000Z" }, "2026-01-01T03:00:00.000Z"],
    [{ kind: "blocked", blocker: "lock", since: "2026-01-01T04:00:00.000Z" }, "2026-01-01T04:00:00.000Z"],
    [{ kind: "failed", error: "boom", retryCount: 2, failedAt: "2026-01-01T05:00:00.000Z" }, "2026-01-01T05:00:00.000Z"],
    [{ kind: "completed", completedAt: "2026-01-01T06:00:00.000Z" }, "2026-01-01T06:00:00.000Z"],
    [{ kind: "paused", pausedAt: "2026-01-01T07:00:00.000Z" }, "2026-01-01T07:00:00.000Z"],
    [{ kind: "stale", lastHeartbeatAt: "2026-01-01T08:00:00.000Z" }, "2026-01-01T08:00:00.000Z"],
    [{ kind: "offline", lastSeenAt: null }, null],
  ];

  it.each(cases)("reads the per-variant timestamp for %o", (status, expected) => {
    expect(statusActivityAt(status)).toBe(expected);
  });

  it("falls back to updatedAt when the status carries no timestamp", () => {
    const agent = makeAgent({ id: "a", status: { kind: "offline", lastSeenAt: null }, updatedAt: "2026-05-05T00:00:00.000Z" });
    expect(agentActivityAt(agent)).toBe("2026-05-05T00:00:00.000Z");
  });
});

describe("matchesSearch", () => {
  const agent = makeAgent({
    id: "a",
    displayName: "Refactor Worker",
    currentTask: "Rewrite the reducer",
    project: { cwd: "/repo/polaris", name: "Polaris", repoUrl: null },
    branch: "feat/Table",
  });

  it("matches an empty query", () => {
    expect(matchesSearch(agent, "")).toBe(true);
    expect(matchesSearch(agent, "   ")).toBe(true);
  });

  it("matches case-insensitive substrings of every searchable field", () => {
    expect(matchesSearch(agent, "refactor")).toBe(true);
    expect(matchesSearch(agent, "REDUCER")).toBe(true);
    expect(matchesSearch(agent, "polaris")).toBe(true);
    expect(matchesSearch(agent, "feat/table")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesSearch(agent, "kubernetes")).toBe(false);
  });

  it("tolerates null currentTask and branch", () => {
    const sparse = makeAgent({ id: "b", currentTask: null, branch: null, displayName: "x", project: { cwd: "/c", name: "c", repoUrl: null } });
    expect(matchesSearch(sparse, "anything")).toBe(false);
    expect(matchesSearch(sparse, "x")).toBe(true);
  });
});

describe("matchesFilters", () => {
  const agent = makeAgent({ id: "a", branch: "dev", project: { cwd: "/repo/alpha", name: "alpha", repoUrl: null } });

  it("treats an empty filter list as no constraint", () => {
    expect(matchesFilters(agent, EMPTY_AGENT_TABLE_FILTERS)).toBe(true);
  });

  it("filters by status kind", () => {
    expect(matchesFilters(agent, { ...EMPTY_AGENT_TABLE_FILTERS, statusKinds: ["running"] })).toBe(true);
    expect(matchesFilters(agent, { ...EMPTY_AGENT_TABLE_FILTERS, statusKinds: ["failed"] })).toBe(false);
  });

  it("filters by project cwd, not project name", () => {
    expect(matchesFilters(agent, { ...EMPTY_AGENT_TABLE_FILTERS, projectCwds: ["/repo/alpha"] })).toBe(true);
    expect(matchesFilters(agent, { ...EMPTY_AGENT_TABLE_FILTERS, projectCwds: ["alpha"] })).toBe(false);
  });

  it("excludes a null-branch agent when a branch filter is active", () => {
    const detached = makeAgent({ id: "b", branch: null });
    expect(matchesFilters(detached, { ...EMPTY_AGENT_TABLE_FILTERS, branches: ["dev"] })).toBe(false);
    expect(matchesFilters(detached, EMPTY_AGENT_TABLE_FILTERS)).toBe(true);
  });

  it("ands every active filter together", () => {
    const filters: AgentTableFilters = { search: "agent-a", statusKinds: ["running"], projectCwds: ["/repo/alpha"], branches: ["dev"] };
    expect(matchesFilters(agent, filters)).toBe(true);
    expect(matchesFilters(agent, { ...filters, search: "nope" })).toBe(false);
  });
});

describe("compareByDefault", () => {
  it("ranks a critical-incident agent above a healthier-status agent", () => {
    const failing = makeAgent({ id: "failing", status: { kind: "failed", error: "e", retryCount: 0, failedAt: "2026-07-10T01:00:00.000Z" } });
    const runningButCritical = makeAgent({ id: "critical" });

    expect(compareByDefault(runningButCritical, failing, new Set(["critical"]))).toBeLessThan(0);
    expect(compareByDefault(runningButCritical, failing, NO_CRITICAL_AGENTS)).toBeGreaterThan(0);
  });

  it("orders by the domain's STATUS_SORT_PRIORITY, worst news first", () => {
    const failed = makeAgent({ id: "f", status: { kind: "failed", error: "e", retryCount: 0, failedAt: "2026-07-10T01:00:00.000Z" } });
    const blocked = makeAgent({ id: "b", status: { kind: "blocked", blocker: "x", since: "2026-07-10T01:00:00.000Z" } });
    const completed = makeAgent({ id: "c", status: { kind: "completed", completedAt: "2026-07-10T01:00:00.000Z" } });

    expect(compareByDefault(failed, blocked, NO_CRITICAL_AGENTS)).toBeLessThan(0);
    expect(compareByDefault(blocked, completed, NO_CRITICAL_AGENTS)).toBeLessThan(0);
  });

  it("puts the most recent activity first within one status", () => {
    const older = makeAgent({ id: "older", status: { kind: "waiting", since: "2026-07-10T01:00:00.000Z" } });
    const newer = makeAgent({ id: "newer", status: { kind: "waiting", since: "2026-07-10T05:00:00.000Z" } });

    expect(compareByDefault(newer, older, NO_CRITICAL_AGENTS)).toBeLessThan(0);
  });

  it("is a total order — identical agents fall back to a stable id tiebreak", () => {
    const a = makeAgent({ id: "aaa" });
    const b = makeAgent({ id: "bbb" });

    expect(compareByDefault(a, b, NO_CRITICAL_AGENTS)).toBeLessThan(0);
    expect(compareByDefault(b, a, NO_CRITICAL_AGENTS)).toBeGreaterThan(0);
    expect(compareByDefault(a, a, NO_CRITICAL_AGENTS)).toBe(0);
  });
});

describe("compareAgents (explicit user sort)", () => {
  const cheap = makeAgent({ id: "cheap", costUsd: 1 });
  const pricey = makeAgent({ id: "pricey", costUsd: 9 });
  const unpriced = makeAgent({ id: "unpriced", costUsd: null });

  it("sorts ascending, then flips for desc", () => {
    expect(compareAgents(cheap, pricey, [{ id: "cost", desc: false }], NO_CRITICAL_AGENTS)).toBeLessThan(0);
    expect(compareAgents(cheap, pricey, [{ id: "cost", desc: true }], NO_CRITICAL_AGENTS)).toBeGreaterThan(0);
  });

  it("sorts null values last in ascending order", () => {
    expect(compareAgents(unpriced, pricey, [{ id: "cost", desc: false }], NO_CRITICAL_AGENTS)).toBeGreaterThan(0);
  });

  it("treats a longer run as the larger runningTime value", () => {
    const longRun = makeAgent({ id: "long", startedAt: "2026-07-09T00:00:00.000Z" });
    const shortRun = makeAgent({ id: "short", startedAt: "2026-07-10T00:00:00.000Z" });
    expect(compareAgents(shortRun, longRun, [{ id: "runningTime", desc: false }], NO_CRITICAL_AGENTS)).toBeLessThan(0);
  });

  it("only reports retryCount for the failed variant, sorting the rest last", () => {
    const failedOnce = makeAgent({ id: "r1", status: { kind: "failed", error: "e", retryCount: 1, failedAt: "2026-07-10T01:00:00.000Z" } });
    const running = makeAgent({ id: "r2" });
    expect(compareAgents(failedOnce, running, [{ id: "retryCount", desc: false }], NO_CRITICAL_AGENTS)).toBeLessThan(0);
  });

  it("ignores an unknown column id and stays stable", () => {
    expect(compareAgents(cheap, pricey, [{ id: "progress", desc: false }], NO_CRITICAL_AGENTS)).toBeLessThan(0);
  });

  it("falls back to the default ordering when no sort is applied", () => {
    const failed = makeAgent({ id: "z", status: { kind: "failed", error: "e", retryCount: 0, failedAt: "2026-07-10T01:00:00.000Z" } });
    const running = makeAgent({ id: "a" });
    expect(compareAgents(failed, running, [], NO_CRITICAL_AGENTS)).toBeLessThan(0);
  });
});

describe("isSortableColumn", () => {
  it("marks value columns sortable and control/derived columns not", () => {
    expect(isSortableColumn("status")).toBe(true);
    expect(isSortableColumn("cost")).toBe(true);
    expect(isSortableColumn("select")).toBe(false);
    expect(isSortableColumn("progress")).toBe(false);
    expect(isSortableColumn("actions")).toBe(false);
    expect(isSortableColumn("runtimeId")).toBe(false);
  });
});

describe("collectCriticalIncidentAgentIds", () => {
  it("collects critical and high severities only", () => {
    const incidents = [
      makeIncident({ id: "i1", severity: "critical", affectedAgentIds: ["a"] }),
      makeIncident({ id: "i2", severity: "high", affectedAgentIds: ["b"] }),
      makeIncident({ id: "i3", severity: "medium", affectedAgentIds: ["c"] }),
      makeIncident({ id: "i4", severity: "low", affectedAgentIds: ["d"] }),
    ];
    expect([...collectCriticalIncidentAgentIds(incidents)].sort()).toEqual(["a", "b"]);
  });
});

describe("selectVisibleAgentIds", () => {
  it("returns ids, not agents — the row model never holds Agent objects", () => {
    const snapshot = makeSnapshot([makeAgent({ id: "a" }), makeAgent({ id: "b" })]);
    const ids = selectVisibleAgentIds(snapshot, EMPTY_AGENT_TABLE_FILTERS, []);
    expect(ids).toEqual(expect.arrayContaining(["a", "b"]));
    expect(ids.every((id) => typeof id === "string")).toBe(true);
  });

  it("applies filters then the default sort", () => {
    const snapshot = makeSnapshot([
      makeAgent({ id: "running" }),
      makeAgent({ id: "failed", status: { kind: "failed", error: "e", retryCount: 0, failedAt: "2026-07-10T01:00:00.000Z" } }),
      makeAgent({ id: "other-project", project: { cwd: "/repo/beta", name: "beta", repoUrl: null } }),
    ]);

    // failed outranks the two running agents; the running pair ties on status+activity, so the
    // id tiebreak settles them (other-project < running).
    expect(selectVisibleAgentIds(snapshot, EMPTY_AGENT_TABLE_FILTERS, [])).toEqual([
      "failed",
      "other-project",
      "running",
    ]);
    expect(selectVisibleAgentIds(snapshot, { ...EMPTY_AGENT_TABLE_FILTERS, projectCwds: ["/repo/beta"] }, [])).toEqual([
      "other-project",
    ]);
  });

  it("floats critical-incident agents to the top of the default order", () => {
    const snapshot = makeSnapshot(
      [
        makeAgent({ id: "failed", status: { kind: "failed", error: "e", retryCount: 0, failedAt: "2026-07-10T01:00:00.000Z" } }),
        makeAgent({ id: "running" }),
      ],
      [makeIncident({ id: "i1", severity: "critical", affectedAgentIds: ["running"] })],
    );

    expect(selectVisibleAgentIds(snapshot, EMPTY_AGENT_TABLE_FILTERS, [])).toEqual(["running", "failed"]);
  });

  it("skips ids missing from byId rather than throwing", () => {
    const snapshot = makeSnapshot([makeAgent({ id: "a" })]);
    snapshot.allIds.push("ghost");
    expect(selectVisibleAgentIds(snapshot, EMPTY_AGENT_TABLE_FILTERS, [])).toEqual(["a"]);
  });
});

describe("deriveBranchOptions", () => {
  it("returns distinct, sorted, non-null branches from the live snapshot", () => {
    const snapshot = makeSnapshot([
      makeAgent({ id: "a", branch: "main" }),
      makeAgent({ id: "b", branch: "dev" }),
      makeAgent({ id: "c", branch: "main" }),
      makeAgent({ id: "d", branch: null }),
    ]);
    expect(deriveBranchOptions(snapshot)).toEqual(["dev", "main"]);
  });
});
