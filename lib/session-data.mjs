import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RECENT_ACTIVITY_MS = 5 * 60 * 1000;
const OBSERVED_IDLE_MS = 30 * 60 * 1000;
const SNAPSHOT_CACHE_MS = 1_000;
const ACTIVITY_READ_CONCURRENCY = 4;

let cachedSnapshot = null;
let cachedSnapshotAt = 0;
let snapshotInFlight = null;

function compactText(value, maxLength = 220) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function asTimestamp(value) {
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function stateDbHome() {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  return stdout;
}

async function discoverStateDatabase(codexHome = stateDbHome()) {
  let entries;
  try {
    entries = await readdir(codexHome);
  } catch {
    return null;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => /^state_.*\.sqlite$/.test(entry))
      .map(async (entry) => {
        const filePath = path.join(codexHome, entry);
        const fileStat = await stat(filePath);
        return { filePath, mtimeMs: fileStat.mtimeMs };
      }),
  );

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filePath ?? null;
}

async function queryJson(databasePath, query) {
  const stdout = await run("sqlite3", ["-readonly", "-json", databasePath, query]);
  return JSON.parse(stdout || "[]");
}

function selectedColumn(columns, tableAlias, column, alias = column) {
  return columns.has(column) ? `${tableAlias}.${column} AS ${alias}` : `NULL AS ${alias}`;
}

function databaseWarning(message) {
  return `Codex 상태 데이터베이스 호환성 경고: ${message}`;
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function workspaceLimitsFromProcesses(processes) {
  const limits = new Map();
  for (const process of processes) {
    const cwd = normalizeCwd(process.cwd);
    if (cwd) {
      limits.set(cwd, (limits.get(cwd) || 0) + 1);
    }
  }
  return limits;
}

function visibleThreadCondition(columns, tableAlias) {
  return columns.has("archived") ? `COALESCE(${tableAlias}.archived, 0) = 0` : "1 = 1";
}

function normalizedTimestampExpression(columns, tableAlias) {
  if (!columns.has("updated_at")) {
    return "0";
  }

  const value = `${tableAlias}.updated_at`;
  const textValue = `CAST(${value} AS TEXT)`;
  return `
    CASE
      WHEN ${textValue} <> '' AND ${textValue} NOT GLOB '*[^0-9]*'
        THEN CASE WHEN CAST(${value} AS REAL) < 10000000000 THEN CAST(${value} AS REAL) * 1000 ELSE CAST(${value} AS REAL) END
      ELSE COALESCE(CAST(strftime('%s', ${value}) AS REAL) * 1000, 0)
    END`;
}

function buildStateQuery(threadColumns, edgeColumns, workspaceLimits, now) {
  const threadFields = ["id", "rollout_path", "updated_at", "cwd", "title", "tokens_used", "agent_nickname", "agent_role", "model"]
    .map((column) => selectedColumn(threadColumns, "t", column))
    .join(", ");
  const threadVisible = visibleThreadCondition(threadColumns, "t");
  const parentVisible = visibleThreadCondition(threadColumns, "parent");
  const childVisible = visibleThreadCondition(threadColumns, "child");
  const edgeCtes =
    edgeColumns.size > 0
      ? `
        valid_edges AS (
          SELECT e.parent_thread_id, e.child_thread_id, ${selectedColumn(edgeColumns, "e", "status", "edge_status")}
          FROM thread_spawn_edges e
          JOIN threads parent ON parent.id = e.parent_thread_id
          JOIN threads child ON child.id = e.child_thread_id
          WHERE ${parentVisible} AND ${childVisible}
        ),
        child_edges AS (
          SELECT e.parent_thread_id, e.child_thread_id, ${selectedColumn(edgeColumns, "e", "status", "edge_status")}
          FROM thread_spawn_edges e
          JOIN threads child ON child.id = e.child_thread_id
          WHERE ${childVisible}
        ),`
      : `
        valid_edges AS (
          SELECT NULL AS parent_thread_id, NULL AS child_thread_id, NULL AS edge_status WHERE 0
        ),
        child_edges AS (
          SELECT NULL AS parent_thread_id, NULL AS child_thread_id, NULL AS edge_status WHERE 0
        ),`;
  const workspaceRows =
    workspaceLimits.size > 0
      ? [...workspaceLimits]
          .map(([cwd, limit]) => `SELECT ${sqlString(cwd)} AS cwd, ${limit} AS root_limit`)
          .join(" UNION ALL ")
      : "SELECT NULL AS cwd, 0 AS root_limit WHERE 0";
  const rootPartition = threadColumns.has("cwd") ? "t.cwd" : "''";
  const normalizedUpdatedAt = normalizedTimestampExpression(threadColumns, "t");
  const rootOrder = threadColumns.has("updated_at") ? `${normalizedUpdatedAt} DESC` : "t.id ASC";
  const fallbackRecency = threadColumns.has("updated_at") ? `WHERE normalized_updated_at >= ${now - OBSERVED_IDLE_MS}` : "";

  return `
    WITH RECURSIVE
    ${edgeCtes}
    workspace_limits(cwd, root_limit) AS (
      ${workspaceRows}
    ),
    root_headers AS (
      SELECT
        t.id,
        ${selectedColumn(threadColumns, "t", "cwd")},
        ${selectedColumn(threadColumns, "t", "updated_at")},
        ${normalizedUpdatedAt} AS normalized_updated_at,
        ROW_NUMBER() OVER (PARTITION BY ${rootPartition} ORDER BY ${rootOrder}) AS workspace_rank
      FROM threads t
      WHERE ${threadVisible}
        AND NOT EXISTS (SELECT 1 FROM valid_edges edge WHERE edge.child_thread_id = t.id)
    ),
    live_roots AS (
      SELECT root.id
      FROM root_headers root
      JOIN workspace_limits workspace ON workspace.cwd = root.cwd
      WHERE root.workspace_rank <= workspace.root_limit
    ),
    fallback_roots AS (
      SELECT id
      FROM root_headers
      ${fallbackRecency}
      ORDER BY normalized_updated_at DESC
      LIMIT 2
    ),
    selected_roots AS (
      SELECT id FROM live_roots
      UNION ALL
      SELECT id FROM fallback_roots WHERE NOT EXISTS (SELECT 1 FROM live_roots)
    ),
    descendants(id) AS (
      SELECT id FROM selected_roots
      UNION
      SELECT edge.child_thread_id
      FROM valid_edges edge
      JOIN descendants parent ON parent.id = edge.parent_thread_id
    )
    SELECT
      'thread' AS record_type,
      ${threadFields},
      NULL AS parent_thread_id,
      NULL AS child_thread_id,
      NULL AS edge_status
    FROM threads t
    JOIN descendants descendant ON descendant.id = t.id
    WHERE ${threadVisible}
    UNION ALL
    SELECT
      'edge' AS record_type,
      NULL AS id,
      NULL AS rollout_path,
      NULL AS updated_at,
      NULL AS cwd,
      NULL AS title,
      NULL AS tokens_used,
      NULL AS agent_nickname,
      NULL AS agent_role,
      NULL AS model,
      edge.parent_thread_id,
      edge.child_thread_id,
      edge.edge_status
    FROM child_edges edge
    JOIN descendants descendant ON descendant.id = edge.child_thread_id`;
}

async function readThreadsAndEdges(databasePath, processes = [], now = Date.now()) {
  let threadColumns;
  let edgeColumns;
  try {
    const [threadSchema, edgeSchema] = await Promise.all([
      queryJson(databasePath, "PRAGMA table_info(threads)"),
      queryJson(databasePath, "PRAGMA table_info(thread_spawn_edges)"),
    ]);
    threadColumns = new Set(threadSchema.map((column) => column.name));
    edgeColumns = new Set(edgeSchema.map((column) => column.name));
  } catch {
    return { threads: [], edges: [], warnings: [databaseWarning("테이블 구조를 읽지 못했습니다.")] };
  }

  if (!threadColumns.has("id")) {
    return { threads: [], edges: [], warnings: [databaseWarning("threads.id 열이 없어 세션을 표시할 수 없습니다.")] };
  }

  const warnings = [];
  const hasUsableEdges = edgeColumns.has("parent_thread_id") && edgeColumns.has("child_thread_id");
  if (edgeColumns.size > 0 && !hasUsableEdges) {
    warnings.push(databaseWarning("thread_spawn_edges의 부모/자식 열이 없어 계층을 복원할 수 없습니다."));
    edgeColumns = new Set();
  }
  if (edgeColumns.size === 0) {
    warnings.push(databaseWarning("thread_spawn_edges를 찾지 못해 세션을 최상위로 표시합니다."));
  }

  try {
    const records = await queryJson(databasePath, buildStateQuery(threadColumns, edgeColumns, workspaceLimitsFromProcesses(processes), now));
    const threads = records
      .filter((record) => record.record_type === "thread")
      .map(({ record_type: _recordType, parent_thread_id: _parent, child_thread_id: _child, edge_status: _status, ...thread }) => thread);
    const edges = records
      .filter((record) => record.record_type === "edge")
      .map(({ parent_thread_id, child_thread_id, edge_status }) => ({
        parent_thread_id,
        child_thread_id,
        status: edge_status,
      }));
    return { threads, edges, warnings };
  } catch {
    return { threads: [], edges: [], warnings: [...warnings, databaseWarning("세션 데이터를 읽지 못했습니다.")] };
  }
}

function parseProcessRows(stdout) {
  return stdout
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
      if (!match) {
        return null;
      }

      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        state: match[3],
        elapsed: match[4],
        cpuPercent: Number(match[5]),
        memoryPercent: Number(match[6]),
        command: match[7],
      };
    })
    .filter(Boolean);
}

function isNativeCodexProcess(command) {
  const isCodex = /(?:^|\s|\/)codex(?:\s|$)/.test(command);
  const isNodeWrapper = /^node\s+.*\/bin\/codex(?:\s|$)/.test(command);
  return isCodex && !isNodeWrapper && !command.includes("codex-session-monitor");
}

async function getProcessCwd(pid) {
  try {
    const stdout = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = stdout.split("\n").find((value) => value.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

async function getRunningCodexProcesses() {
  const stdout = await run("ps", ["-Ao", "pid=,ppid=,stat=,etime=,pcpu=,pmem=,command="]);
  const candidates = parseProcessRows(stdout).filter((process) => isNativeCodexProcess(process.command));

  return mapWithConcurrency(candidates, ACTIVITY_READ_CONCURRENCY, async (process) => ({
    ...process,
    cwd: await getProcessCwd(process.pid),
  }));
}

async function readTail(filePath, maxBytes = 640_000) {
  if (!filePath) {
    return "";
  }

  try {
    const handle = await open(filePath, "r");
    try {
      const fileStat = await handle.stat();
      const length = Math.min(fileStat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, fileStat.size - length));
      const tail = buffer.toString("utf8");
      const startsMidRecord = fileStat.size > length;
      const firstLineEnd = tail.indexOf("\n");
      return startsMidRecord && firstLineEnd >= 0 ? tail.slice(firstLineEnd + 1) : tail;
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function textFromResponseItem(payload) {
  if (payload?.type === "message") {
    const contents = Array.isArray(payload.content) ? payload.content : [];
    return compactText(
      contents
        .map((content) => content.text || content.value || "")
        .filter(Boolean)
        .join(" "),
    );
  }

  if (payload?.type === "function_call" || payload?.type === "custom_tool_call") {
    return compactText(`도구 실행: ${payload.name || "이름 없는 도구"}`);
  }

  return "";
}

function describeRolloutEvent(entry) {
  const payload = entry?.payload || {};
  const timestamp = asTimestamp(payload?.occurred_at_ms || entry?.timestamp || entry?.created_at || payload?.timestamp);

  if (entry?.type === "event_msg") {
    const eventType = payload.type || entry?.event_type;
    if (eventType === "task_complete") {
      return { kind: "completed", text: "작업 완료 신호", timestamp };
    }

    if (eventType === "sub_agent_activity") {
      const labels = {
        started: "하위 에이전트 작업 시작",
        interacted: "하위 에이전트 최근 활동",
      };
      return { kind: "event", text: labels[payload.kind] || "하위 에이전트 활동", timestamp };
    }

    const text = compactText(payload.message || payload.text || payload.summary || "");
    if (text) {
      return { kind: eventType === "agent_message" ? "message" : "event", text, timestamp };
    }
  }

  if (entry?.type === "response_item") {
    const text = textFromResponseItem(payload);
    if (text) {
      return { kind: "response", text, timestamp };
    }
  }

  if (entry?.type === "task_complete" || payload?.type === "task_complete") {
    return { kind: "completed", text: "작업 완료 신호", timestamp };
  }

  return null;
}

function activityCandidatesFromTail(tail, sourceThreadId) {
  const lines = tail.split("\n");
  const candidates = [];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      const item = describeRolloutEvent(entry);
      if (item) {
        const payload = entry?.payload || {};
        candidates.push({
          targetThreadId: typeof payload.agent_thread_id === "string" && payload.agent_thread_id ? payload.agent_thread_id : sourceThreadId,
          activity: item,
        });
      }
    } catch {
      // 잘린 첫 줄과 비 JSON 줄은 무시한다.
    }
  }

  return candidates;
}

async function getActivityCandidates(thread) {
  const tail = await readTail(thread.rollout_path);
  return activityCandidatesFromTail(tail, thread.id);
}

function selectLatestActivities(candidates, selectedIds) {
  const activities = new Map();
  for (const candidate of candidates) {
    if (!selectedIds.has(candidate.targetThreadId)) {
      continue;
    }

    const previous = activities.get(candidate.targetThreadId);
    if (!previous || (candidate.activity.timestamp || 0) > (previous.timestamp || 0)) {
      activities.set(candidate.targetThreadId, candidate.activity);
    }
  }
  return activities;
}

async function collectLatestActivities(threadById, selectedIds) {
  const candidates = (
    await mapWithConcurrency([...selectedIds], ACTIVITY_READ_CONCURRENCY, async (id) => {
      const thread = threadById.get(id);
      return thread ? getActivityCandidates(thread) : [];
    })
  ).flat();
  return selectLatestActivities(candidates, selectedIds);
}

function normalizeCwd(cwd) {
  return typeof cwd === "string" && cwd ? path.resolve(cwd) : null;
}

function rootLimitForWorkspace(processCount) {
  return Math.max(1, processCount);
}

export function selectRootThreads(threads, edges, processes, now = Date.now()) {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const childIds = new Set(
    edges
      .filter((edge) => threadById.has(edge.parent_thread_id) && threadById.has(edge.child_thread_id))
      .map((edge) => edge.child_thread_id),
  );
  const roots = threads.filter((thread) => !childIds.has(thread.id));
  const liveCountsByCwd = new Map();

  for (const process of processes) {
    const cwd = normalizeCwd(process.cwd);
    if (cwd) {
      liveCountsByCwd.set(cwd, (liveCountsByCwd.get(cwd) || 0) + 1);
    }
  }

  const byWorkspace = new Map();
  for (const root of roots) {
    const cwd = normalizeCwd(root.cwd);
    const isObservedWorkspace = cwd && liveCountsByCwd.has(cwd);

    if (isObservedWorkspace) {
      const collection = byWorkspace.get(cwd) || [];
      collection.push(root);
      byWorkspace.set(cwd, collection);
    }
  }

  const selected = [];
  for (const [cwd, rootsForWorkspace] of byWorkspace) {
    rootsForWorkspace
      .sort((left, right) => (asTimestamp(right.updated_at) || 0) - (asTimestamp(left.updated_at) || 0))
      .slice(0, rootLimitForWorkspace(liveCountsByCwd.get(cwd) || 0))
      .forEach((root) => selected.push(root));
  }

  if (selected.length === 0) {
    roots
      .filter((root) => (asTimestamp(root.updated_at) || 0) >= now - OBSERVED_IDLE_MS)
      .sort((left, right) => (asTimestamp(right.updated_at) || 0) - (asTimestamp(left.updated_at) || 0))
      .slice(0, 2)
      .forEach((root) => selected.push(root));
  }

  return selected.sort((left, right) => (asTimestamp(right.updated_at) || 0) - (asTimestamp(left.updated_at) || 0));
}

function getDisplayTitle(thread, isRoot) {
  return compactText(
    thread.title || thread.agent_nickname || (isRoot ? "이름 없는 메인 세션" : "이름 없는 서브 에이전트"),
    120,
  );
}

function buildChildrenIndex(edges, threadById) {
  const childrenByParent = new Map();
  const edgeByChild = new Map();

  for (const edge of edges) {
    if (!threadById.has(edge.child_thread_id)) {
      continue;
    }

    edgeByChild.set(edge.child_thread_id, edge);
    if (!threadById.has(edge.parent_thread_id)) {
      continue;
    }

    const children = childrenByParent.get(edge.parent_thread_id) || [];
    children.push(edge.child_thread_id);
    childrenByParent.set(edge.parent_thread_id, children);
  }

  return { childrenByParent, edgeByChild };
}

function descendantIds(rootId, childrenByParent) {
  const ids = [];
  const queue = [rootId];
  const seen = new Set();

  for (let index = 0; index < queue.length; index += 1) {
    const currentId = queue[index];
    if (seen.has(currentId)) {
      continue;
    }

    seen.add(currentId);
    ids.push(currentId);
    for (const childId of childrenByParent.get(currentId) || []) {
      queue.push(childId);
    }
  }

  return ids;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function work() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, work));
  return results;
}

export function classifyNode({ activity, edgeStatus, hasWorkspaceRuntime, isRoot, now = Date.now() }) {
  if (activity?.kind === "completed" || edgeStatus === "closed" || edgeStatus === "completed") {
    return "completed";
  }

  const timestamp = activity?.timestamp || null;
  if (timestamp && now - timestamp <= RECENT_ACTIVITY_MS) {
    return "working";
  }

  if (isRoot && hasWorkspaceRuntime) {
    return "observed";
  }

  if (edgeStatus === "open" || hasWorkspaceRuntime) {
    return "waiting";
  }

  if (timestamp && now - timestamp > OBSERVED_IDLE_MS) {
    return "stale";
  }

  return "unknown";
}

function mapProcessesByCwd(processes) {
  const result = new Map();
  for (const process of processes) {
    const cwd = normalizeCwd(process.cwd);
    if (!cwd) {
      continue;
    }

    const values = result.get(cwd) || [];
    values.push(process);
    result.set(cwd, values);
  }
  return result;
}

export function buildSessionForest({ threads, edges, processes, activities, now = Date.now() }) {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const { childrenByParent, edgeByChild } = buildChildrenIndex(edges, threadById);
  const selectedRoots = selectRootThreads(threads, edges, processes, now);
  const processesByCwd = mapProcessesByCwd(processes);
  const includedIds = new Set();

  for (const root of selectedRoots) {
    for (const id of descendantIds(root.id, childrenByParent)) {
      includedIds.add(id);
    }
  }

  function makeNode(id, isRoot, ancestry = new Set()) {
    const thread = threadById.get(id);
    const edge = edgeByChild.get(id);
    const cwd = normalizeCwd(thread.cwd);
    const runtime = cwd ? processesByCwd.get(cwd) || [] : [];
    const activity = activities.get(id) || {
      kind: "unknown",
      text: "최근 활동을 찾지 못했습니다",
      timestamp: asTimestamp(thread.updated_at),
    };
    const status = classifyNode({
      activity,
      edgeStatus: edge?.status,
      hasWorkspaceRuntime: runtime.length > 0,
      isRoot,
      now,
    });
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(id);

    return {
      id: thread.id,
      title: getDisplayTitle(thread, isRoot),
      agentName: thread.agent_nickname || (isRoot ? "메인 에이전트" : "서브 에이전트"),
      role: thread.agent_role || (isRoot ? "main" : "subagent"),
      cwd: thread.cwd || null,
      model: thread.model || null,
      tokensUsed: Number(thread.tokens_used) || 0,
      updatedAt: asTimestamp(thread.updated_at),
      status,
      edgeStatus: edge?.status || null,
      activity,
      runtimePids: runtime.map((process) => process.pid),
      children: (childrenByParent.get(id) || [])
        .filter((childId) => includedIds.has(childId) && !nextAncestry.has(childId))
        .map((childId) => makeNode(childId, false, nextAncestry)),
    };
  }

  return selectedRoots.map((root) => makeNode(root.id, true));
}

function countNodes(nodes) {
  return nodes.reduce((count, node) => count + 1 + countNodes(node.children), 0);
}

function countNodesWithStatus(nodes, status) {
  return nodes.reduce(
    (count, node) => count + (node.status === status ? 1 : 0) + countNodesWithStatus(node.children, status),
    0,
  );
}

async function buildDashboardSnapshot(generatedAt) {
  const [databasePath, processes] = await Promise.all([discoverStateDatabase(), getRunningCodexProcesses()]);

  if (!databasePath) {
    return {
      generatedAt,
      source: { database: null, mode: "read-only" },
      summary: { roots: 0, agents: 0, liveProcesses: processes.length, workingAgents: 0 },
      sessions: [],
      runtimes: processes,
      warnings: ["Codex 상태 데이터베이스를 찾지 못했습니다."],
    };
  }

  const { threads, edges, warnings } = await readThreadsAndEdges(databasePath, processes, generatedAt);
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const { childrenByParent } = buildChildrenIndex(edges, threadById);
  const selectedRoots = selectRootThreads(threads, edges, processes, generatedAt);
  const selectedIds = new Set(selectedRoots.flatMap((root) => descendantIds(root.id, childrenByParent)));
  const activities = await collectLatestActivities(threadById, selectedIds);
  const sessions = buildSessionForest({ threads, edges, processes, activities, now: generatedAt });

  return {
    generatedAt,
    source: {
      database: path.basename(databasePath),
      mode: "read-only",
    },
    summary: {
      roots: sessions.length,
      agents: countNodes(sessions),
      liveProcesses: processes.length,
      workingAgents: countNodesWithStatus(sessions, "working") + countNodesWithStatus(sessions, "observed"),
    },
    sessions,
    runtimes: processes,
    warnings,
  };
}

export async function getDashboardSnapshot() {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshotAt < SNAPSHOT_CACHE_MS) {
    return cachedSnapshot;
  }

  if (snapshotInFlight) {
    return snapshotInFlight;
  }

  snapshotInFlight = buildDashboardSnapshot(now)
    .then((snapshot) => {
      cachedSnapshot = snapshot;
      cachedSnapshotAt = Date.now();
      return snapshot;
    })
    .finally(() => {
      snapshotInFlight = null;
    });

  return snapshotInFlight;
}

export const _testing = {
  asTimestamp,
  activityCandidatesFromTail,
  buildStateQuery,
  collectLatestActivities,
  compactText,
  describeRolloutEvent,
  mapWithConcurrency,
  parseProcessRows,
  readThreadsAndEdges,
  selectLatestActivities,
};
