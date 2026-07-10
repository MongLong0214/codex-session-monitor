import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  activityCandidatesFromTail,
  buildStateQuery,
  classifyNode,
  describeRolloutEvent,
  selectLatestActivities,
  selectRootThreads,
} from "./local-adapter";
import { STALE_HEARTBEAT_THRESHOLD_MS } from "./incident-detection";

/**
 * Ported from the retired legacy suite (test/session-data.test.mjs) when server.mjs + lib/ were
 * removed. These cover the core Codex engine — status classification, root selection, rollout-event
 * parsing, parent→child activity routing, and schema-resilient SQL generation — which no other file
 * in the Vitest suite exercised. Only functions already exported by local-adapter.ts are used, so
 * production code is untouched.
 */

const now = 1_800_000_000_000;
const execFileAsync = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface ThreadInput {
  id: string;
  cwd?: string | null;
  updatedAt?: number | null;
  title?: string | null;
  agentNickname?: string | null;
}

/** Full ThreadRow shape (camelCase, as the TypeScript port emits) so selectRootThreads type-checks. */
function thread(input: ThreadInput) {
  return {
    id: input.id,
    rolloutPath: null,
    createdAt: null,
    updatedAt: input.updatedAt ?? null,
    cwd: input.cwd ?? null,
    title: input.title ?? null,
    tokensUsed: 0,
    agentNickname: input.agentNickname ?? null,
    model: null,
    reasoningEffort: null,
    cliVersion: null,
    approvalMode: null,
    gitBranch: null,
    gitSha: null,
    gitOriginUrl: null,
    firstUserMessage: null,
    preview: null,
  };
}

function edge(parentThreadId: string, childThreadId: string, status: string | null = null) {
  return { parentThreadId, childThreadId, status };
}

function codexProcess(pid: number, cwd: string | null) {
  return { pid, ppid: 1, state: "R", elapsed: "00:00", cpuPercent: 0, memoryPercent: 0, command: "codex", cwd };
}

async function queryJson(databasePath: string, sql: string): Promise<Record<string, unknown>[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", databasePath, sql], { maxBuffer: MAX_BUFFER });
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
}

async function createDatabase(schema: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-session-monitor-"));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const databasePath = path.join(directory, "state.sqlite");
  await execFileAsync("sqlite3", [databasePath, schema]);
  return databasePath;
}

/** Mirrors readThreadsAndEdges' PRAGMA-derived column sets, then drives the exported buildStateQuery. */
async function columnsOf(databasePath: string, table: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const row of await queryJson(databasePath, `PRAGMA table_info(${table})`)) {
    if (typeof row.name === "string") {
      names.add(row.name);
    }
  }
  return names;
}

async function runStateQuery(
  databasePath: string,
  workspaceLimits: Map<string, number>,
): Promise<{ threads: Record<string, unknown>[]; edges: Record<string, unknown>[] }> {
  const threadColumns = await columnsOf(databasePath, "threads");
  const edgeColumns = await columnsOf(databasePath, "thread_spawn_edges");
  const records = await queryJson(databasePath, buildStateQuery(threadColumns, edgeColumns, workspaceLimits, now));
  return {
    threads: records.filter((record) => record.record_type === "thread"),
    edges: records.filter((record) => record.record_type === "edge"),
  };
}

describe("classifyNode", () => {
  it("prefers a completion signal over a live workspace runtime", () => {
    expect(
      classifyNode({
        activity: { kind: "completed", text: "", timestamp: now - 500 },
        edgeStatus: "open",
        hasWorkspaceRuntime: true,
        isRoot: false,
        now,
      }),
    ).toBe("completed");
  });

  it("treats a closed child edge as completed even with recent activity and a shared-directory process", () => {
    expect(
      classifyNode({
        activity: { kind: "event", text: "", timestamp: now - 500 },
        edgeStatus: "closed",
        hasWorkspaceRuntime: true,
        isRoot: false,
        now,
      }),
    ).toBe("completed");
  });

  it("is working when the latest activity is within the recent-activity window", () => {
    expect(
      classifyNode({
        activity: { kind: "message", text: "", timestamp: now - 60_000 },
        edgeStatus: null,
        hasWorkspaceRuntime: false,
        isRoot: false,
        now,
      }),
    ).toBe("working");
  });

  it("is observed for a root with a live workspace runtime but no recent activity", () => {
    expect(
      classifyNode({
        activity: { kind: "event", text: "", timestamp: now - 10 * 60_000 },
        edgeStatus: null,
        hasWorkspaceRuntime: true,
        isRoot: true,
        now,
      }),
    ).toBe("observed");
  });

  it("is waiting for an open edge with no recent activity and no root runtime", () => {
    expect(
      classifyNode({
        activity: { kind: "event", text: "", timestamp: now - 10 * 60_000 },
        edgeStatus: "open",
        hasWorkspaceRuntime: false,
        isRoot: false,
        now,
      }),
    ).toBe("waiting");
  });

  it("is stale once activity is older than the idle threshold with nothing keeping it alive", () => {
    expect(
      classifyNode({
        activity: { kind: "event", text: "", timestamp: now - (STALE_HEARTBEAT_THRESHOLD_MS + 60_000) },
        edgeStatus: null,
        hasWorkspaceRuntime: false,
        isRoot: false,
        now,
      }),
    ).toBe("stale");
  });

  it("is unknown when there is no activity timestamp and nothing else to classify on", () => {
    expect(
      classifyNode({
        activity: { kind: "unknown", text: "", timestamp: null },
        edgeStatus: null,
        hasWorkspaceRuntime: false,
        isRoot: false,
        now,
      }),
    ).toBe("unknown");
  });
});

describe("describeRolloutEvent", () => {
  it("reads a sub-agent activity event as a recent work signal", () => {
    expect(
      describeRolloutEvent({
        timestamp: "2026-07-10T00:42:35.788Z",
        type: "event_msg",
        payload: { type: "sub_agent_activity", kind: "interacted", occurred_at_ms: now - 500 },
      }),
    ).toEqual({ kind: "event", text: "하위 에이전트 최근 활동", timestamp: now - 500 });
  });

  it("recognizes a task_complete event as a completion signal", () => {
    expect(
      describeRolloutEvent({
        timestamp: now - 500,
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ).toEqual({ kind: "completed", text: "작업 완료 신호", timestamp: now - 500 });
  });
});

describe("activityCandidatesFromTail + selectLatestActivities", () => {
  it("routes a parent rollout's sub-agent signal to the target child thread", () => {
    const candidates = activityCandidatesFromTail(
      [
        JSON.stringify({
          timestamp: now - 2_000,
          type: "event_msg",
          payload: { type: "agent_message", message: "메인 에이전트가 확인했습니다." },
        }),
        JSON.stringify({
          timestamp: now - 1_000,
          type: "event_msg",
          payload: {
            type: "sub_agent_activity",
            agent_thread_id: "child-thread",
            kind: "started",
            occurred_at_ms: now - 500,
          },
        }),
      ].join("\n"),
      "parent-thread",
    );

    const activities = selectLatestActivities(candidates, new Set(["parent-thread", "child-thread"]));

    expect(activities.get("parent-thread")?.text).toBe("메인 에이전트가 확인했습니다.");
    expect(activities.get("child-thread")?.text).toBe("하위 에이전트 작업 시작");
    expect(activities.get("child-thread")?.timestamp).toBe(now - 500);
  });
});

describe("selectRootThreads", () => {
  it("picks the live workspace's main session and excludes children and idle workspaces", () => {
    const threads = [
      thread({ id: "root-live", cwd: "/workspace/live", title: "메인 작업", updatedAt: now - 1_000 }),
      thread({ id: "child-live", cwd: "/workspace/live", agentNickname: "분석 담당", updatedAt: now - 500 }),
      thread({ id: "root-old", cwd: "/workspace/old", title: "오래된 작업", updatedAt: now - 86_400_000 }),
    ];
    const edges = [edge("root-live", "child-live", "open")];
    const processes = [codexProcess(41, "/workspace/live")];

    const roots = selectRootThreads(threads, edges, processes, now);
    expect(roots.map((root) => root.id)).toEqual(["root-live"]);
  });

  it("shows no more past sessions in a directory than there are live processes", () => {
    const threads = [
      thread({ id: "latest", cwd: "/workspace/live", updatedAt: now - 100 }),
      thread({ id: "older", cwd: "/workspace/live", updatedAt: now - 1_000 }),
      thread({ id: "oldest", cwd: "/workspace/live", updatedAt: now - 10_000 }),
    ];
    const processes = [codexProcess(10, "/workspace/live"), codexProcess(11, "/workspace/live")];

    const roots = selectRootThreads(threads, [], processes, now);
    expect(roots.map((root) => root.id)).toEqual(["latest", "older"]);
  });

  it("does not hide a live child whose edge points at a vanished (archived) parent", () => {
    const threads = [thread({ id: "orphan-child", cwd: "/workspace/live", updatedAt: now - 1_000 })];
    const edges = [edge("archived-parent", "orphan-child", "closed")];
    const processes = [codexProcess(41, "/workspace/live")];

    const roots = selectRootThreads(threads, edges, processes, now);
    expect(roots.map((root) => root.id)).toEqual(["orphan-child"]);
  });
});

describe("buildStateQuery (against a real sqlite state DB)", () => {
  it("reads the current schema, keeping the edge status", async () => {
    const databasePath = await createDatabase(`
      CREATE TABLE threads (
        id TEXT, rollout_path TEXT, updated_at INTEGER, cwd TEXT, title TEXT,
        tokens_used INTEGER, agent_nickname TEXT, agent_role TEXT, model TEXT, archived INTEGER
      );
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
      INSERT INTO threads VALUES ('root', '/tmp/root.jsonl', ${now}, '/workspace/live', '메인', 10, '메인', 'main', 'gpt-5', 0);
      INSERT INTO threads VALUES ('child', '/tmp/child.jsonl', ${now}, '/workspace/live', '하위', 5, '하위', 'subagent', 'gpt-5', 0);
      INSERT INTO thread_spawn_edges VALUES ('root', 'child', 'closed');
    `);

    const { threads, edges } = await runStateQuery(databasePath, new Map());

    expect(threads.map((record) => record.id).sort()).toEqual(["child", "root"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ parent_thread_id: "root", child_thread_id: "child", edge_status: "closed" });
  });

  it("reads a minimal schema with no status column, defaulting edge status to null", async () => {
    const databasePath = await createDatabase(`
      CREATE TABLE threads (id TEXT, updated_at INTEGER, cwd TEXT);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      INSERT INTO threads VALUES ('root', ${now}, '/workspace/live');
      INSERT INTO threads VALUES ('child', ${now}, '/workspace/live');
      INSERT INTO thread_spawn_edges VALUES ('root', 'child');
    `);

    const { threads, edges } = await runStateQuery(databasePath, new Map());

    expect(threads.map((record) => record.id).sort()).toEqual(["child", "root"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ parent_thread_id: "root", child_thread_id: "child", edge_status: null });
  });

  it("reads only the live workspace and its subtree, not the thousands of old sessions elsewhere", async () => {
    const databasePath = await createDatabase(`
      CREATE TABLE threads (
        id TEXT, rollout_path TEXT, updated_at INTEGER, cwd TEXT, title TEXT,
        tokens_used INTEGER, agent_nickname TEXT, agent_role TEXT, model TEXT, archived INTEGER
      );
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
      INSERT INTO threads VALUES ('live-root', NULL, ${now}, '/workspace/current', '현재 메인', 0, NULL, NULL, NULL, 0);
      INSERT INTO threads VALUES ('live-child', NULL, ${now}, '/workspace/current', '현재 하위', 0, NULL, NULL, NULL, 0);
      INSERT INTO thread_spawn_edges VALUES ('live-root', 'live-child', 'open');
      WITH RECURSIVE number(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM number WHERE value < 1500
      )
      INSERT INTO threads
      SELECT printf('old-%04d', value), NULL, ${now - 86_400_000}, '/workspace/old', '과거 세션', 0, NULL, NULL, NULL, 0
      FROM number;
    `);

    const { threads, edges } = await runStateQuery(databasePath, new Map([["/workspace/current", 1]]));

    expect(threads.map((record) => record.id).sort()).toEqual(["live-child", "live-root"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ parent_thread_id: "live-root", child_thread_id: "live-child", edge_status: "open" });
  });

  it("falls back to the most recent second-precision roots when no process is running", async () => {
    const databasePath = await createDatabase(`
      CREATE TABLE threads (id TEXT, updated_at INTEGER, cwd TEXT, archived INTEGER);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
      INSERT INTO threads VALUES ('recent-root', ${Math.floor((now - 1_000) / 1000)}, '/workspace/recent', 0);
      INSERT INTO threads VALUES ('recent-child', ${Math.floor((now - 500) / 1000)}, '/workspace/recent', 0);
      INSERT INTO thread_spawn_edges VALUES ('recent-root', 'recent-child', 'open');
    `);

    const { threads } = await runStateQuery(databasePath, new Map());

    expect(threads.map((record) => record.id).sort()).toEqual(["recent-child", "recent-root"]);
  });
});
