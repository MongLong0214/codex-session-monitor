import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { _testing, buildSessionForest, classifyNode, selectRootThreads } from "../lib/session-data.mjs";

const now = 1_800_000_000_000;
const execFileAsync = promisify(execFile);

async function createDatabase(t, schema) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-session-monitor-"));
  const databasePath = path.join(directory, "state.sqlite");
  t.after(() => rm(directory, { force: true, recursive: true }));
  await execFileAsync("sqlite3", [databasePath, schema]);
  return databasePath;
}

test("실행 중인 작업 디렉터리의 메인 세션과 하위 에이전트를 트리로 만든다", () => {
  const threads = [
    { id: "root-live", cwd: "/workspace/live", title: "메인 작업", updated_at: now - 1_000 },
    { id: "child-live", cwd: "/workspace/live", agent_nickname: "분석 담당", updated_at: now - 500 },
    { id: "root-old", cwd: "/workspace/old", title: "오래된 작업", updated_at: now - 86_400_000 },
  ];
  const edges = [{ parent_thread_id: "root-live", child_thread_id: "child-live", status: "open" }];
  const processes = [{ pid: 41, cwd: "/workspace/live" }];
  const activities = new Map([
    ["root-live", { kind: "message", text: "작업 중", timestamp: now - 1_000 }],
    ["child-live", { kind: "message", text: "검토 중", timestamp: now - 500 }],
  ]);

  const roots = selectRootThreads(threads, edges, processes, now);
  assert.deepEqual(roots.map((thread) => thread.id), ["root-live"]);

  const forest = buildSessionForest({ threads, edges, processes, activities, now });
  assert.equal(forest.length, 1);
  assert.equal(forest[0].id, "root-live");
  assert.equal(forest[0].children[0].id, "child-live");
  assert.equal(forest[0].status, "working");
});

test("완료 신호는 실행 중인 작업 디렉터리보다 우선한다", () => {
  assert.equal(
    classifyNode({
      activity: { kind: "completed", timestamp: now - 500 },
      edgeStatus: "open",
      hasWorkspaceRuntime: true,
      isRoot: false,
      now,
    }),
    "completed",
  );
});

test("닫힌 하위 에지는 최근 활동이나 같은 작업 디렉터리 프로세스보다 완료로 표시한다", () => {
  assert.equal(
    classifyNode({
      activity: { kind: "event", timestamp: now - 500 },
      edgeStatus: "closed",
      hasWorkspaceRuntime: true,
      isRoot: false,
      now,
    }),
    "completed",
  );
});

test("하위 에이전트 활동 이벤트를 최근 작업 신호로 읽는다", () => {
  assert.deepEqual(
    _testing.describeRolloutEvent({
      timestamp: "2026-07-10T00:42:35.788Z",
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        kind: "interacted",
        occurred_at_ms: now - 500,
      },
    }),
    { kind: "event", text: "하위 에이전트 최근 활동", timestamp: now - 500 },
  );
});

test("부모 롤아웃의 하위 활동 신호를 대상 하위 에이전트에 연결한다", () => {
  const candidates = _testing.activityCandidatesFromTail(
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
  const activities = _testing.selectLatestActivities(candidates, new Set(["parent-thread", "child-thread"]));

  assert.equal(activities.get("parent-thread")?.text, "메인 에이전트가 확인했습니다.");
  assert.equal(activities.get("child-thread")?.text, "하위 에이전트 작업 시작");
  assert.equal(activities.get("child-thread")?.timestamp, now - 500);
});

test("부모 롤아웃 파일의 하위 활동을 대상 스레드의 최신 활동으로 합친다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-session-monitor-rollout-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const parentRollout = path.join(directory, "parent.jsonl");
  const childRollout = path.join(directory, "child.jsonl");
  await writeFile(
    parentRollout,
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
          kind: "interacted",
          occurred_at_ms: now - 500,
        },
      }),
    ].join("\n"),
  );
  await writeFile(childRollout, "");

  const activities = await _testing.collectLatestActivities(
    new Map([
      ["parent-thread", { id: "parent-thread", rollout_path: parentRollout }],
      ["child-thread", { id: "child-thread", rollout_path: childRollout }],
    ]),
    new Set(["parent-thread", "child-thread"]),
  );

  assert.equal(activities.get("parent-thread")?.text, "메인 에이전트가 확인했습니다.");
  assert.equal(activities.get("child-thread")?.text, "하위 에이전트 최근 활동");
  assert.equal(activities.get("child-thread")?.timestamp, now - 500);
});

test("같은 작업 디렉터리의 과거 세션은 현재 프로세스 수보다 많이 표시하지 않는다", () => {
  const threads = [
    { id: "latest", cwd: "/workspace/live", updated_at: now - 100 },
    { id: "older", cwd: "/workspace/live", updated_at: now - 1_000 },
    { id: "oldest", cwd: "/workspace/live", updated_at: now - 10_000 },
  ];
  const processes = [
    { pid: 10, cwd: "/workspace/live" },
    { pid: 11, cwd: "/workspace/live" },
  ];

  const roots = selectRootThreads(threads, [], processes, now);
  assert.deepEqual(roots.map((thread) => thread.id), ["latest", "older"]);
});

test("사라진 부모를 가리키는 에지는 현재 하위 세션을 숨기지 않는다", () => {
  const threads = [{ id: "orphan-child", cwd: "/workspace/live", updated_at: now - 1_000 }];
  const edges = [{ parent_thread_id: "archived-parent", child_thread_id: "orphan-child", status: "closed" }];
  const processes = [{ pid: 41, cwd: "/workspace/live" }];

  const roots = selectRootThreads(threads, edges, processes, now);
  assert.deepEqual(roots.map((thread) => thread.id), ["orphan-child"]);

  const forest = buildSessionForest({ threads, edges, processes, activities: new Map(), now });
  assert.deepEqual(forest.map((node) => node.id), ["orphan-child"]);
  assert.equal(forest[0].status, "completed");
});

test("현재·최소·비호환 상태 DB 스키마를 명시적으로 처리한다", async (t) => {
  const currentDatabase = await createDatabase(
    t,
    `
      CREATE TABLE threads (
        id TEXT, rollout_path TEXT, updated_at INTEGER, cwd TEXT, title TEXT,
        tokens_used INTEGER, agent_nickname TEXT, agent_role TEXT, model TEXT, archived INTEGER
      );
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
      INSERT INTO threads VALUES ('root', '/tmp/root.jsonl', ${now}, '/workspace/live', '메인', 10, '메인', 'main', 'gpt-5', 0);
      INSERT INTO threads VALUES ('child', '/tmp/child.jsonl', ${now}, '/workspace/live', '하위', 5, '하위', 'subagent', 'gpt-5', 0);
      INSERT INTO thread_spawn_edges VALUES ('root', 'child', 'closed');
    `,
  );
  const current = await _testing.readThreadsAndEdges(currentDatabase);
  assert.deepEqual(current.threads.map((thread) => thread.id), ["root", "child"]);
  assert.deepEqual(current.edges, [{ parent_thread_id: "root", child_thread_id: "child", status: "closed" }]);
  assert.deepEqual(current.warnings, []);

  const minimalDatabase = await createDatabase(
    t,
    `
      CREATE TABLE threads (id TEXT, updated_at INTEGER, cwd TEXT);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      INSERT INTO threads VALUES ('root', ${now}, '/workspace/live');
      INSERT INTO threads VALUES ('child', ${now}, '/workspace/live');
      INSERT INTO thread_spawn_edges VALUES ('root', 'child');
    `,
  );
  const minimal = await _testing.readThreadsAndEdges(minimalDatabase);
  assert.deepEqual(minimal.threads.map((thread) => thread.id), ["root", "child"]);
  assert.deepEqual(minimal.edges, [{ parent_thread_id: "root", child_thread_id: "child", status: null }]);
  assert.deepEqual(minimal.warnings, []);

  const malformedDatabase = await createDatabase(
    t,
    `
      CREATE TABLE threads (title TEXT);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
    `,
  );
  const malformed = await _testing.readThreadsAndEdges(malformedDatabase);
  assert.deepEqual(malformed.threads, []);
  assert.match(malformed.warnings[0], /threads\.id/);
});

test("롤아웃 활동 읽기는 동시 작업 수를 제한한다", async () => {
  let active = 0;
  let peak = 0;
  const values = await _testing.mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(values, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});

test("실행 중인 작업 디렉터리와 그 하위 트리만 상태 DB에서 읽는다", async (t) => {
  const databasePath = await createDatabase(
    t,
    `
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
        SELECT value + 1 FROM number WHERE value < 1_500
      )
      INSERT INTO threads
      SELECT printf('old-%04d', value), NULL, ${now - 86_400_000}, '/workspace/old', '과거 세션', 0, NULL, NULL, NULL, 0
      FROM number;
    `,
  );

  const result = await _testing.readThreadsAndEdges(databasePath, [{ pid: 7, cwd: "/workspace/current" }], now);
  assert.deepEqual(result.threads.map((thread) => thread.id).sort(), ["live-child", "live-root"]);
  assert.deepEqual(result.edges, [{ parent_thread_id: "live-root", child_thread_id: "live-child", status: "open" }]);
});

test("프로세스가 없을 때 초 단위 updated_at의 최근 루트를 폴백으로 읽는다", async (t) => {
  const databasePath = await createDatabase(
    t,
    `
      CREATE TABLE threads (id TEXT, updated_at INTEGER, cwd TEXT, archived INTEGER);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
      INSERT INTO threads VALUES ('recent-root', ${Math.floor((now - 1_000) / 1000)}, '/workspace/recent', 0);
      INSERT INTO threads VALUES ('recent-child', ${Math.floor((now - 500) / 1000)}, '/workspace/recent', 0);
      INSERT INTO thread_spawn_edges VALUES ('recent-root', 'recent-child', 'open');
    `,
  );

  const result = await _testing.readThreadsAndEdges(databasePath, [], now);
  assert.deepEqual(result.threads.map((thread) => thread.id).sort(), ["recent-child", "recent-root"]);
});
