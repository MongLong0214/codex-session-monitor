import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AgentActionRequest, AgentActionResult, AgentActionType } from "@/domain/agent/actions";
import type { Agent, ProjectRef } from "@/domain/agent/agent";
import type { AgentStatus, AgentStatusKind } from "@/domain/agent/status";
import type { DashboardSnapshot, DashboardSummary } from "@/domain/dashboard";

import type { AgentCommandRepository } from "./agent-command-repository";
import { collectClaudeCodeAgents } from "./claude-code-adapter";
import type { DashboardRepository } from "./dashboard-repository";
import { STALE_HEARTBEAT_THRESHOLD_MS, detectIncidents } from "./incident-detection";

const execFileAsync = promisify(execFile);

const RECENT_ACTIVITY_MS = 5 * 60 * 1000;
/** Same threshold the stale-heartbeat detector uses; keeping one constant prevents classifier drift. */
const OBSERVED_IDLE_MS = STALE_HEARTBEAT_THRESHOLD_MS;
const SNAPSHOT_CACHE_MS = 1_000;
const ACTIVITY_READ_CONCURRENCY = 4;
const MAX_EXEC_BUFFER = 8 * 1024 * 1024;
/** Exported so the log reader can report `isTruncated` against the same window it actually read. */
export const TAIL_BYTES = 640_000;
const DIFF_OUTPUT_LIMIT = 2_000;

const NO_CONTROL_CHANNEL_MESSAGE =
  "이 모니터는 읽기 전용 관찰자입니다. 외부에서 실행된 세션의 stdin/PTY 제어 채널이 없어 이 동작을 수행할 수 없습니다.";

/** Legacy 6-state classifier vocabulary, preserved verbatim from lib/session-data.mjs. */
type LegacyStatusKind = "completed" | "working" | "observed" | "waiting" | "stale" | "unknown";

/** Exported so the log reader (local-agent-logs.ts) interprets rollout events through this module. */
export interface RolloutActivity {
  kind: string;
  text: string;
  timestamp: number | null;
}

interface ThreadRow {
  id: string;
  rolloutPath: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  cwd: string | null;
  title: string | null;
  tokensUsed: number;
  agentNickname: string | null;
  model: string | null;
  reasoningEffort: string | null;
  cliVersion: string | null;
  approvalMode: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  gitOriginUrl: string | null;
  firstUserMessage: string | null;
  preview: string | null;
}

interface EdgeRow {
  parentThreadId: string;
  childThreadId: string;
  status: string | null;
}

interface CodexProcess {
  pid: number;
  ppid: number;
  state: string;
  elapsed: string;
  cpuPercent: number;
  memoryPercent: number;
  command: string;
  cwd: string | null;
}

/** Columns pulled from `threads`. Every one is guarded by selectedColumn() against schema drift. */
const THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "created_at",
  "updated_at",
  "cwd",
  "title",
  "tokens_used",
  "agent_nickname",
  "model",
  "reasoning_effort",
  "cli_version",
  "approval_mode",
  "git_branch",
  "git_sha",
  "git_origin_url",
  "first_user_message",
  "preview",
] as const;

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function errorCode(error: unknown): string | null {
  const code = toRecord(error)?.code;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown): string {
  const record = toRecord(error);
  const stderr = record?.stderr;
  if (typeof stderr === "string" && stderr.trim()) {
    return stderr.trim();
  }

  const message = record?.message;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }

  return String(error);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNonNegativeInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function compactText(value: unknown, maxLength = 220): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

/** Codex stores epoch seconds in created_at/updated_at; anything above 10^10 is already milliseconds. */
function asTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? (value > 10_000_000_000 ? value : value * 1000) : null;
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

function toIso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function normalizeCwd(cwd: string | null): string | null {
  return cwd ? path.resolve(cwd) : null;
}

function stateDbHome(): string {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

async function run(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: MAX_EXEC_BUFFER, ...options });
  return stdout;
}

async function discoverStateDatabase(codexHome: string = stateDbHome()): Promise<string | null> {
  let entries: string[];
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

async function queryJson(databasePath: string, query: string): Promise<Record<string, unknown>[]> {
  const stdout = await run("sqlite3", ["-readonly", "-json", databasePath, query]);
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((row): row is Record<string, unknown> => toRecord(row) !== null);
}

function selectedColumn(columns: Set<string>, tableAlias: string, column: string, alias: string = column): string {
  return columns.has(column) ? `${tableAlias}.${column} AS ${alias}` : `NULL AS ${alias}`;
}

function databaseWarning(message: string): string {
  return `Codex 상태 데이터베이스 호환성 경고: ${message}`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function workspaceLimitsFromProcesses(processes: readonly CodexProcess[]): Map<string, number> {
  const limits = new Map<string, number>();
  for (const codexProcess of processes) {
    const cwd = normalizeCwd(codexProcess.cwd);
    if (cwd) {
      limits.set(cwd, (limits.get(cwd) ?? 0) + 1);
    }
  }
  return limits;
}

function visibleThreadCondition(columns: Set<string>, tableAlias: string): string {
  return columns.has("archived") ? `COALESCE(${tableAlias}.archived, 0) = 0` : "1 = 1";
}

function normalizedTimestampExpression(columns: Set<string>, tableAlias: string): string {
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

export function buildStateQuery(
  threadColumns: Set<string>,
  edgeColumns: Set<string>,
  workspaceLimits: Map<string, number>,
  now: number,
): string {
  const threadFields = THREAD_COLUMNS.map((column) => selectedColumn(threadColumns, "t", column)).join(", ");
  /** Derived from the same list so the UNION ALL arms can never fall out of column order. */
  const nullThreadFields = THREAD_COLUMNS.map((column) => `NULL AS ${column}`).join(", ");
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
  const fallbackRecency = threadColumns.has("updated_at")
    ? `WHERE normalized_updated_at >= ${now - OBSERVED_IDLE_MS}`
    : "";

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
      ${nullThreadFields},
      edge.parent_thread_id,
      edge.child_thread_id,
      edge.edge_status
    FROM child_edges edge
    JOIN descendants descendant ON descendant.id = edge.child_thread_id`;
}

function toThreadRow(record: Record<string, unknown>): ThreadRow | null {
  const id = asString(record.id);
  if (!id) {
    return null;
  }

  return {
    id,
    rolloutPath: asString(record.rollout_path),
    createdAt: asTimestamp(record.created_at),
    updatedAt: asTimestamp(record.updated_at),
    cwd: asString(record.cwd),
    title: asString(record.title),
    tokensUsed: asNonNegativeInteger(record.tokens_used),
    agentNickname: asString(record.agent_nickname),
    model: asString(record.model),
    reasoningEffort: asString(record.reasoning_effort),
    cliVersion: asString(record.cli_version),
    approvalMode: asString(record.approval_mode),
    gitBranch: asString(record.git_branch),
    gitSha: asString(record.git_sha),
    gitOriginUrl: asString(record.git_origin_url),
    firstUserMessage: asString(record.first_user_message),
    preview: asString(record.preview),
  };
}

function toEdgeRow(record: Record<string, unknown>): EdgeRow | null {
  const parentThreadId = asString(record.parent_thread_id);
  const childThreadId = asString(record.child_thread_id);
  if (!parentThreadId || !childThreadId) {
    return null;
  }

  return { parentThreadId, childThreadId, status: asString(record.edge_status) };
}

interface StateReadResult {
  threads: ThreadRow[];
  edges: EdgeRow[];
  warnings: string[];
}

async function readThreadsAndEdges(
  databasePath: string,
  processes: readonly CodexProcess[],
  now: number,
): Promise<StateReadResult> {
  let threadColumns: Set<string>;
  let edgeColumns: Set<string>;
  try {
    const [threadSchema, edgeSchema] = await Promise.all([
      queryJson(databasePath, "PRAGMA table_info(threads)"),
      queryJson(databasePath, "PRAGMA table_info(thread_spawn_edges)"),
    ]);
    threadColumns = new Set(threadSchema.map((column) => asString(column.name)).filter((name) => name !== null));
    edgeColumns = new Set(edgeSchema.map((column) => asString(column.name)).filter((name) => name !== null));
  } catch {
    return { threads: [], edges: [], warnings: [databaseWarning("테이블 구조를 읽지 못했습니다.")] };
  }

  if (!threadColumns.has("id")) {
    return {
      threads: [],
      edges: [],
      warnings: [databaseWarning("threads.id 열이 없어 세션을 표시할 수 없습니다.")],
    };
  }

  const warnings: string[] = [];
  const hasUsableEdges = edgeColumns.has("parent_thread_id") && edgeColumns.has("child_thread_id");
  if (edgeColumns.size > 0 && !hasUsableEdges) {
    warnings.push(databaseWarning("thread_spawn_edges의 부모/자식 열이 없어 계층을 복원할 수 없습니다."));
    edgeColumns = new Set();
  }
  if (edgeColumns.size === 0) {
    warnings.push(databaseWarning("thread_spawn_edges를 찾지 못해 세션을 최상위로 표시합니다."));
  }

  try {
    const records = await queryJson(
      databasePath,
      buildStateQuery(threadColumns, edgeColumns, workspaceLimitsFromProcesses(processes), now),
    );
    const threads = records
      .filter((record) => record.record_type === "thread")
      .map(toThreadRow)
      .filter((thread): thread is ThreadRow => thread !== null);
    const edges = records
      .filter((record) => record.record_type === "edge")
      .map(toEdgeRow)
      .filter((edge): edge is EdgeRow => edge !== null);
    return { threads, edges, warnings };
  } catch {
    return { threads: [], edges: [], warnings: [...warnings, databaseWarning("세션 데이터를 읽지 못했습니다.")] };
  }
}

const PROCESS_ROW_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/;

export function parseProcessRows(stdout: string): Omit<CodexProcess, "cwd">[] {
  const rows: Omit<CodexProcess, "cwd">[] = [];

  for (const line of stdout.split("\n")) {
    const match = PROCESS_ROW_PATTERN.exec(line);
    if (!match) {
      continue;
    }

    const [, pid, ppid, state, elapsed, cpuPercent, memoryPercent, command] = match;
    if (!pid || !ppid || !state || !elapsed || !cpuPercent || !memoryPercent || !command) {
      continue;
    }

    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      state,
      elapsed,
      cpuPercent: Number(cpuPercent),
      memoryPercent: Number(memoryPercent),
      command,
    });
  }

  return rows;
}

function isNativeCodexProcess(command: string): boolean {
  const isCodex = /(?:^|\s|\/)codex(?:\s|$)/.test(command);
  const isNodeWrapper = /^node\s+.*\/bin\/codex(?:\s|$)/.test(command);
  return isCodex && !isNodeWrapper && !command.includes("codex-session-monitor");
}

async function getProcessCwd(pid: number): Promise<string | null> {
  try {
    const stdout = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = stdout.split("\n").find((value) => value.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

async function getRunningCodexProcesses(): Promise<CodexProcess[]> {
  let stdout: string;
  try {
    stdout = await run("ps", ["-Ao", "pid=,ppid=,stat=,etime=,pcpu=,pmem=,command="]);
  } catch {
    return [];
  }

  const candidates = parseProcessRows(stdout).filter((codexProcess) => isNativeCodexProcess(codexProcess.command));
  return mapWithConcurrency(candidates, ACTIVITY_READ_CONCURRENCY, async (codexProcess) => ({
    ...codexProcess,
    cwd: await getProcessCwd(codexProcess.pid),
  }));
}

/**
 * Reads the last `maxBytes` of a file and drops the leading partial record. Exported so the log
 * reader shares this exact tail semantics instead of re-deriving it.
 */
export async function readTail(filePath: string | null, maxBytes = TAIL_BYTES): Promise<string> {
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

function textFromResponseItem(payload: Record<string, unknown>): string {
  if (payload.type === "message") {
    const contents = Array.isArray(payload.content) ? payload.content : [];
    return compactText(
      contents
        .map((content) => {
          const record = toRecord(content);
          return asString(record?.text) ?? asString(record?.value) ?? "";
        })
        .filter(Boolean)
        .join(" "),
    );
  }

  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    return compactText(`도구 실행: ${asString(payload.name) ?? "이름 없는 도구"}`);
  }

  return "";
}

const SUB_AGENT_ACTIVITY_LABELS: Record<string, string> = {
  started: "하위 에이전트 작업 시작",
  interacted: "하위 에이전트 최근 활동",
};

export function describeRolloutEvent(entry: Record<string, unknown>): RolloutActivity | null {
  const payload = toRecord(entry.payload) ?? {};
  const timestamp = asTimestamp(
    payload.occurred_at_ms ?? entry.timestamp ?? entry.created_at ?? payload.timestamp ?? null,
  );

  if (entry.type === "event_msg") {
    const eventType = asString(payload.type) ?? asString(entry.event_type);
    if (eventType === "task_complete") {
      return { kind: "completed", text: "작업 완료 신호", timestamp };
    }

    if (eventType === "sub_agent_activity") {
      const kind = asString(payload.kind);
      const label = (kind && SUB_AGENT_ACTIVITY_LABELS[kind]) ?? "하위 에이전트 활동";
      return { kind: "event", text: label, timestamp };
    }

    const text = compactText(asString(payload.message) ?? asString(payload.text) ?? asString(payload.summary) ?? "");
    if (text) {
      return { kind: eventType === "agent_message" ? "message" : "event", text, timestamp };
    }
  }

  if (entry.type === "response_item") {
    const text = textFromResponseItem(payload);
    if (text) {
      return { kind: "response", text, timestamp };
    }
  }

  if (entry.type === "task_complete" || payload.type === "task_complete") {
    return { kind: "completed", text: "작업 완료 신호", timestamp };
  }

  return null;
}

interface ActivityCandidate {
  targetThreadId: string;
  activity: RolloutActivity;
}

export function activityCandidatesFromTail(tail: string, sourceThreadId: string): ActivityCandidate[] {
  const lines = tail.split("\n");
  const candidates: ActivityCandidate[] = [];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line);
      const entry = toRecord(parsed);
      if (!entry) {
        continue;
      }

      const activity = describeRolloutEvent(entry);
      if (activity) {
        const payload = toRecord(entry.payload);
        candidates.push({
          targetThreadId: asString(payload?.agent_thread_id) ?? sourceThreadId,
          activity,
        });
      }
    } catch {
      // 잘린 첫 줄과 비 JSON 줄은 무시한다.
    }
  }

  return candidates;
}

export function selectLatestActivities(
  candidates: readonly ActivityCandidate[],
  selectedIds: ReadonlySet<string>,
): Map<string, RolloutActivity> {
  const activities = new Map<string, RolloutActivity>();

  for (const candidate of candidates) {
    if (!selectedIds.has(candidate.targetThreadId)) {
      continue;
    }

    const previous = activities.get(candidate.targetThreadId);
    if (!previous || (candidate.activity.timestamp ?? 0) > (previous.timestamp ?? 0)) {
      activities.set(candidate.targetThreadId, candidate.activity);
    }
  }

  return activities;
}

async function collectLatestActivities(
  threadById: ReadonlyMap<string, ThreadRow>,
  selectedIds: ReadonlySet<string>,
): Promise<Map<string, RolloutActivity>> {
  const candidates = (
    await mapWithConcurrency([...selectedIds], ACTIVITY_READ_CONCURRENCY, async (id) => {
      const thread = threadById.get(id);
      if (!thread) {
        return [];
      }

      const tail = await readTail(thread.rolloutPath);
      return activityCandidatesFromTail(tail, thread.id);
    })
  ).flat();

  return selectLatestActivities(candidates, selectedIds);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function work(): Promise<void> {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const value = values[currentIndex];
      if (value !== undefined) {
        results[currentIndex] = await mapper(value, currentIndex);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => work()));
  return results;
}

export function classifyNode(input: {
  activity: RolloutActivity | null;
  edgeStatus: string | null;
  hasWorkspaceRuntime: boolean;
  isRoot: boolean;
  now: number;
}): LegacyStatusKind {
  const { activity, edgeStatus, hasWorkspaceRuntime, isRoot, now } = input;

  if (activity?.kind === "completed" || edgeStatus === "closed" || edgeStatus === "completed") {
    return "completed";
  }

  const timestamp = activity?.timestamp ?? null;
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

/**
 * The local adapter can only ever justify five of the nine kinds. blocked/failed/approval_required/
 * paused are never emitted here because the rollout event vocabulary has no error, approval, or
 * pause signal to base them on — see src/domain/agent/status.ts. The mock adapter exercises them.
 * Narrowing the value type makes that gap a compile-time guarantee rather than a convention.
 */
type LocalStatusKind = Extract<AgentStatusKind, "running" | "waiting" | "completed" | "stale" | "offline">;

const LEGACY_TO_STATUS_KIND: Record<LegacyStatusKind, LocalStatusKind> = {
  working: "running",
  observed: "running",
  waiting: "waiting",
  completed: "completed",
  stale: "stale",
  unknown: "offline",
};

function buildAgentStatus(
  legacyKind: LegacyStatusKind,
  startedAtMs: number,
  lastActivityMs: number | null,
): AgentStatus {
  const kind = LEGACY_TO_STATUS_KIND[legacyKind];
  const lastKnownMs = lastActivityMs ?? startedAtMs;

  if (kind === "running") {
    return { kind, startedAt: toIso(startedAtMs), lastHeartbeatAt: toIso(lastKnownMs) };
  }

  if (kind === "waiting") {
    return { kind, since: toIso(lastKnownMs) };
  }

  if (kind === "completed") {
    return { kind, completedAt: toIso(lastKnownMs) };
  }

  if (kind === "stale") {
    return { kind, lastHeartbeatAt: toIso(lastKnownMs) };
  }

  return { kind, lastSeenAt: lastActivityMs === null ? null : toIso(lastActivityMs) };
}

/** Handles both `https://host/owner/repo.git` and the scp-like `git@host:owner/repo.git`. */
function repoNameFromOriginUrl(originUrl: string): string | null {
  const cleaned = originUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const cut = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf(":"));
  const segment = cut >= 0 ? cleaned.slice(cut + 1) : cleaned;
  return segment || null;
}

function buildProjectRef(thread: ThreadRow): ProjectRef {
  const cwd = normalizeCwd(thread.cwd) ?? "";
  const repoUrl = thread.gitOriginUrl;
  const nameFromRepo = repoUrl ? repoNameFromOriginUrl(repoUrl) : null;
  const name = nameFromRepo ?? (cwd ? path.basename(cwd) : "") ?? "";

  return { cwd, name: name || "(작업 디렉터리 없음)", repoUrl };
}

function getDisplayTitle(thread: ThreadRow, isRoot: boolean): string {
  return compactText(
    thread.title ?? thread.agentNickname ?? (isRoot ? "이름 없는 메인 세션" : "이름 없는 서브 에이전트"),
    120,
  );
}

interface ChildrenIndex {
  childrenByParent: Map<string, string[]>;
  edgeByChild: Map<string, EdgeRow>;
}

function buildChildrenIndex(edges: readonly EdgeRow[], threadById: ReadonlyMap<string, ThreadRow>): ChildrenIndex {
  const childrenByParent = new Map<string, string[]>();
  const edgeByChild = new Map<string, EdgeRow>();

  for (const edge of edges) {
    if (!threadById.has(edge.childThreadId)) {
      continue;
    }

    edgeByChild.set(edge.childThreadId, edge);
    if (!threadById.has(edge.parentThreadId)) {
      continue;
    }

    const children = childrenByParent.get(edge.parentThreadId) ?? [];
    children.push(edge.childThreadId);
    childrenByParent.set(edge.parentThreadId, children);
  }

  return { childrenByParent, edgeByChild };
}

function descendantIds(rootId: string, childrenByParent: ReadonlyMap<string, string[]>): string[] {
  const ids: string[] = [];
  const queue: string[] = [rootId];
  const seen = new Set<string>();

  for (let index = 0; index < queue.length; index += 1) {
    const currentId = queue[index];
    if (currentId === undefined || seen.has(currentId)) {
      continue;
    }

    seen.add(currentId);
    ids.push(currentId);
    for (const childId of childrenByParent.get(currentId) ?? []) {
      queue.push(childId);
    }
  }

  return ids;
}

function rootLimitForWorkspace(processCount: number): number {
  return Math.max(1, processCount);
}

export function selectRootThreads(
  threads: readonly ThreadRow[],
  edges: readonly EdgeRow[],
  processes: readonly CodexProcess[],
  now: number,
): ThreadRow[] {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const childIds = new Set(
    edges
      .filter((edge) => threadById.has(edge.parentThreadId) && threadById.has(edge.childThreadId))
      .map((edge) => edge.childThreadId),
  );
  const roots = threads.filter((thread) => !childIds.has(thread.id));
  const liveCountsByCwd = new Map<string, number>();

  for (const codexProcess of processes) {
    const cwd = normalizeCwd(codexProcess.cwd);
    if (cwd) {
      liveCountsByCwd.set(cwd, (liveCountsByCwd.get(cwd) ?? 0) + 1);
    }
  }

  const byWorkspace = new Map<string, ThreadRow[]>();
  for (const root of roots) {
    const cwd = normalizeCwd(root.cwd);
    if (cwd && liveCountsByCwd.has(cwd)) {
      const collection = byWorkspace.get(cwd) ?? [];
      collection.push(root);
      byWorkspace.set(cwd, collection);
    }
  }

  const selected: ThreadRow[] = [];
  for (const [cwd, rootsForWorkspace] of byWorkspace) {
    rootsForWorkspace
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, rootLimitForWorkspace(liveCountsByCwd.get(cwd) ?? 0))
      .forEach((root) => selected.push(root));
  }

  if (selected.length === 0) {
    roots
      .filter((root) => (root.updatedAt ?? 0) >= now - OBSERVED_IDLE_MS)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, 2)
      .forEach((root) => selected.push(root));
  }

  return selected.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function mapProcessesByCwd(processes: readonly CodexProcess[]): Map<string, CodexProcess[]> {
  const result = new Map<string, CodexProcess[]>();

  for (const codexProcess of processes) {
    const cwd = normalizeCwd(codexProcess.cwd);
    if (!cwd) {
      continue;
    }

    const values = result.get(cwd) ?? [];
    values.push(codexProcess);
    result.set(cwd, values);
  }

  return result;
}

function compareThreads(left: ThreadRow, right: ThreadRow): number {
  const byUpdatedAt = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  return byUpdatedAt !== 0 ? byUpdatedAt : left.id.localeCompare(right.id);
}

/**
 * Depth-first preorder from each selected root. Fully determined by the data (roots and siblings
 * sorted by updatedAt desc, id asc), so identical DB state always yields an identical id order —
 * which is what makes the revision fingerprint and the SSE diff stable.
 */
function orderAgentIds(
  roots: readonly ThreadRow[],
  childrenByParent: ReadonlyMap<string, string[]>,
  threadById: ReadonlyMap<string, ThreadRow>,
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  function visit(id: string): void {
    if (seen.has(id)) {
      return;
    }

    seen.add(id);
    ordered.push(id);

    const children = (childrenByParent.get(id) ?? [])
      .map((childId) => threadById.get(childId))
      .filter((child): child is ThreadRow => child !== undefined)
      .sort(compareThreads);

    for (const child of children) {
      visit(child.id);
    }
  }

  for (const root of roots) {
    visit(root.id);
  }

  return ordered;
}

function buildSummary(agents: readonly Agent[], projects: readonly ProjectRef[]): DashboardSummary {
  const statusCounts: Record<AgentStatusKind, number> = {
    running: 0,
    waiting: 0,
    approval_required: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
    paused: 0,
    stale: 0,
    offline: 0,
  };

  for (const agent of agents) {
    statusCounts[agent.status.kind] += 1;
  }

  return {
    totalAgents: agents.length,
    activeProjects: projects.length,
    statusCounts,
    // No pricing table exists for the observed models — a fabricated dollar figure would be worse than none.
    sessionCostUsd: null,
  };
}

type SnapshotContent = Omit<DashboardSnapshot, "revision" | "lastSyncedAt">;

function emptyContent(warnings: string[]): SnapshotContent {
  return {
    byId: {},
    allIds: [],
    projects: [],
    incidents: [],
    summary: buildSummary([], []),
    warnings,
  };
}

function buildContent(
  threads: readonly ThreadRow[],
  edges: readonly EdgeRow[],
  processes: readonly CodexProcess[],
  activities: ReadonlyMap<string, RolloutActivity>,
  warnings: string[],
  now: number,
): SnapshotContent {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const { childrenByParent, edgeByChild } = buildChildrenIndex(edges, threadById);
  const selectedRoots = selectRootThreads(threads, edges, processes, now);
  const processesByCwd = mapProcessesByCwd(processes);

  const includedIds = new Set(selectedRoots.flatMap((root) => descendantIds(root.id, childrenByParent)));
  const allIds = orderAgentIds(selectedRoots, childrenByParent, threadById).filter((id) => includedIds.has(id));

  const byId: Record<string, Agent> = {};
  const projects: ProjectRef[] = [];
  const seenProjectCwds = new Set<string>();

  for (const id of allIds) {
    const thread = threadById.get(id);
    if (!thread) {
      continue;
    }

    const edge = edgeByChild.get(id);
    const parentId = edge && threadById.has(edge.parentThreadId) ? edge.parentThreadId : null;
    const isRoot = parentId === null;

    const cwd = normalizeCwd(thread.cwd);
    const runtime = cwd ? (processesByCwd.get(cwd) ?? []) : [];
    const activity = activities.get(id) ?? null;
    /** Mirrors the legacy default so an activity-less thread still has updatedAt to go stale on. */
    const activityForClassification: RolloutActivity = activity ?? {
      kind: "unknown",
      text: "",
      timestamp: thread.updatedAt,
    };

    const legacyKind = classifyNode({
      activity: activityForClassification,
      edgeStatus: edge?.status ?? null,
      hasWorkspaceRuntime: runtime.length > 0,
      isRoot,
      now,
    });

    const startedAtMs = thread.createdAt ?? thread.updatedAt ?? now;
    const updatedAtMs = thread.updatedAt ?? startedAtMs;
    const lastActivityMs = activity?.timestamp ?? thread.updatedAt ?? null;

    const project = buildProjectRef(thread);
    if (!seenProjectCwds.has(project.cwd)) {
      seenProjectCwds.add(project.cwd);
      projects.push(project);
    }

    const childIds = (childrenByParent.get(id) ?? [])
      .filter((childId) => includedIds.has(childId))
      .map((childId) => threadById.get(childId))
      .filter((child): child is ThreadRow => child !== undefined)
      .sort(compareThreads)
      .map((child) => child.id);

    byId[id] = {
      id,
      displayName: getDisplayTitle(thread, isRoot),
      source: "codex",
      role: isRoot ? "main" : "subagent",
      project,
      branch: thread.gitBranch,
      commitSha: thread.gitSha,
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
      status: buildAgentStatus(legacyKind, startedAtMs, lastActivityMs),
      currentTask: activity?.text || compactText(thread.firstUserMessage ?? thread.preview ?? "") || null,
      tokensUsed: thread.tokensUsed,
      costUsd: null,
      startedAt: toIso(startedAtMs),
      updatedAt: toIso(updatedAtMs),
      lastHeartbeatAt: lastActivityMs === null ? null : toIso(lastActivityMs),
      runtimePids: runtime.map((codexProcess) => codexProcess.pid),
      parentId,
      childIds,
      cliVersion: thread.cliVersion,
      approvalMode: thread.approvalMode,
      rolloutPath: thread.rolloutPath ?? "",
    };
  }

  const agents = allIds.map((id) => byId[id]).filter((agent): agent is Agent => agent !== undefined);
  const incidents = detectIncidents({ agents, projects, now });

  return { byId, allIds, projects, incidents, summary: buildSummary(agents, projects), warnings };
}

/**
 * Merges Claude-Code-sourced agents into the Codex snapshot content — the single orchestration point
 * where the two sources become one snapshot. Each source's own extraction logic stays in its own file
 * (Codex above, Claude in claude-code-adapter.ts); only this final join lives here. Summary is rebuilt
 * over the union (and, unlike buildSummary, sums the real per-session cost that Claude sessions carry),
 * projects are de-duplicated by cwd across both sources, and incidents are re-detected over everyone.
 */
function mergeClaudeContent(
  codex: SnapshotContent,
  claude: readonly Agent[],
  claudeWarnings: string[],
  now: number,
): SnapshotContent {
  if (claude.length === 0) {
    return claudeWarnings.length === 0 ? codex : { ...codex, warnings: [...codex.warnings, ...claudeWarnings] };
  }

  const byId = { ...codex.byId };
  const allIds = [...codex.allIds];
  for (const agent of claude) {
    if (!byId[agent.id]) {
      allIds.push(agent.id);
    }
    byId[agent.id] = agent;
  }

  const projects = [...codex.projects];
  const seenProjectCwds = new Set(projects.map((project) => project.cwd));
  for (const agent of claude) {
    if (!seenProjectCwds.has(agent.project.cwd)) {
      seenProjectCwds.add(agent.project.cwd);
      projects.push(agent.project);
    }
  }

  const agents = allIds.map((id) => byId[id]).filter((agent): agent is Agent => agent !== undefined);

  const statusCounts: Record<AgentStatusKind, number> = {
    running: 0,
    waiting: 0,
    approval_required: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
    paused: 0,
    stale: 0,
    offline: 0,
  };
  let sessionCostUsd: number | null = null;
  for (const agent of agents) {
    statusCounts[agent.status.kind] += 1;
    if (agent.costUsd !== null) {
      sessionCostUsd = (sessionCostUsd ?? 0) + agent.costUsd;
    }
  }

  return {
    byId,
    allIds,
    projects,
    incidents: detectIncidents({ agents, projects, now }),
    summary: {
      totalAgents: agents.length,
      activeProjects: projects.length,
      statusCounts,
      sessionCostUsd: sessionCostUsd === null ? null : Number(sessionCostUsd.toFixed(2)),
    },
    warnings: [...codex.warnings, ...claudeWarnings],
  };
}

let cachedSnapshot: DashboardSnapshot | null = null;
let cachedSnapshotAt = 0;
let snapshotInFlight: Promise<DashboardSnapshot> | null = null;
let revision = 0;
let lastFingerprint: string | null = null;

async function buildDashboardSnapshot(now: number): Promise<DashboardSnapshot> {
  const [databasePath, processes, claude] = await Promise.all([
    discoverStateDatabase(),
    getRunningCodexProcesses(),
    /** Never rejects (see collectClaudeCodeAgents); a defensive catch keeps Codex agents visible regardless. */
    collectClaudeCodeAgents(now).catch(() => ({
      agents: [],
      warnings: ["Claude Code 세션 읽기 경고: 세션을 수집하지 못했습니다."],
    })),
  ]);

  const codexContent = await (async (): Promise<SnapshotContent> => {
    if (!databasePath) {
      return emptyContent(["Codex 상태 데이터베이스를 찾지 못했습니다."]);
    }

    const { threads, edges, warnings } = await readThreadsAndEdges(databasePath, processes, now);
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const { childrenByParent } = buildChildrenIndex(edges, threadById);
    const selectedRoots = selectRootThreads(threads, edges, processes, now);
    const selectedIds = new Set(selectedRoots.flatMap((root) => descendantIds(root.id, childrenByParent)));
    const activities = await collectLatestActivities(threadById, selectedIds);

    return buildContent(threads, edges, processes, activities, warnings, now);
  })();

  const content = mergeClaudeContent(codexContent, claude.agents, claude.warnings, now);

  /**
   * revision only advances when the observable content changed, so a client can treat an unchanged
   * revision as "nothing to reconcile". lastSyncedAt is excluded because it moves on every poll.
   */
  const fingerprint = JSON.stringify(content);
  if (fingerprint !== lastFingerprint) {
    lastFingerprint = fingerprint;
    revision += 1;
  }

  return { ...content, revision, lastSyncedAt: toIso(now) };
}

/** 1s cache + in-flight dedup: concurrent callers share one read of the state DB and rollout logs. */
async function getSnapshot(): Promise<DashboardSnapshot> {
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

export const localDashboardRepository: DashboardRepository = { getSnapshot };

type ActionOutcome = Omit<AgentActionResult, "agentId" | "action">;

interface ActionContext {
  agent: Agent;
  force: boolean;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…(생략)`;
}

/**
 * Codex exposes no thread->pid mapping, so runtimePids are the Codex processes sharing the agent's
 * working directory (see README). Signalling therefore affects every session in that directory —
 * the message says so rather than pretending the signal was precisely targeted.
 */
async function signalAgentProcesses(agent: Agent, signal: NodeJS.Signals, label: string): Promise<ActionOutcome> {
  const pids = agent.runtimePids;
  if (pids.length === 0) {
    return { status: "skipped", message: "실행 중인 프로세스를 찾지 못했습니다." };
  }

  const signaled: number[] = [];
  const alreadyExited: number[] = [];
  const failures: string[] = [];

  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signaled.push(pid);
    } catch (error) {
      if (errorCode(error) === "ESRCH") {
        alreadyExited.push(pid);
      } else {
        failures.push(`PID ${pid}: ${errorMessage(error)}`);
      }
    }
  }

  if (signaled.length === 0 && failures.length === 0) {
    return { status: "skipped", message: `이미 종료된 프로세스입니다 (PID ${alreadyExited.join(", ")}).` };
  }

  if (signaled.length === 0) {
    return { status: "failed", message: `${label} 전송에 실패했습니다. ${failures.join("; ")}` };
  }

  const notes = [
    `작업 디렉터리를 공유하는 Codex 프로세스 ${signaled.length}개에 ${label}를 보냈습니다 (PID ${signaled.join(", ")}).`,
    "세션과 프로세스의 직접 매핑이 없어 같은 디렉터리의 다른 세션도 함께 영향을 받을 수 있습니다.",
  ];
  if (alreadyExited.length > 0) {
    notes.push(`이미 종료된 PID ${alreadyExited.join(", ")}는 건너뛰었습니다.`);
  }
  if (failures.length > 0) {
    notes.push(`일부 실패: ${failures.join("; ")}`);
  }

  return { status: "success", message: notes.join(" ") };
}

/**
 * Path-traversal defense: the directory always comes from this repository's own snapshot for the
 * requested agent, then through realpath + a directory check, before any child process sees it.
 */
async function resolveWorkingDirectory(agent: Agent): Promise<string> {
  const cwd = agent.project.cwd;
  if (!cwd) {
    throw new Error("에이전트의 작업 디렉터리를 확인할 수 없습니다.");
  }

  const canonical = await realpath(cwd);
  const stats = await stat(canonical);
  if (!stats.isDirectory()) {
    throw new Error(`작업 디렉터리가 아닙니다: ${canonical}`);
  }

  return canonical;
}

const ACTION_HANDLERS: Record<AgentActionType, (context: ActionContext) => Promise<ActionOutcome>> = {
  stop: ({ agent, force }) => signalAgentProcesses(agent, force ? "SIGKILL" : "SIGTERM", force ? "SIGKILL" : "SIGTERM"),

  pause: async ({ agent }) => {
    const outcome = await signalAgentProcesses(agent, "SIGSTOP", "SIGSTOP");
    if (outcome.status !== "success") {
      return outcome;
    }
    return {
      status: "success",
      message: `OS 레벨 프로세스 일시정지(SIGSTOP)를 보냈습니다. Codex 자체의 pause 기능이 아닙니다. ${outcome.message}`,
    };
  },

  resume: async ({ agent }) => {
    const outcome = await signalAgentProcesses(agent, "SIGCONT", "SIGCONT");
    if (outcome.status !== "success") {
      return outcome;
    }
    return {
      status: "success",
      message: `OS 레벨 프로세스 재개(SIGCONT)를 보냈습니다. Codex 자체의 resume 기능이 아닙니다. ${outcome.message}`,
    };
  },

  retry: async () => ({ status: "skipped", message: NO_CONTROL_CHANNEL_MESSAGE }),
  approve: async () => ({ status: "skipped", message: NO_CONTROL_CHANNEL_MESSAGE }),
  reject: async () => ({ status: "skipped", message: NO_CONTROL_CHANNEL_MESSAGE }),

  open_terminal: async ({ agent }) => {
    try {
      const cwd = await resolveWorkingDirectory(agent);
      await execFileAsync("open", ["-a", "Terminal", cwd], { maxBuffer: MAX_EXEC_BUFFER });
      return { status: "success", message: `터미널에서 ${cwd}를 열었습니다.` };
    } catch (error) {
      return { status: "failed", message: `터미널을 열지 못했습니다: ${errorMessage(error)}` };
    }
  },

  view_diff: async ({ agent }) => {
    try {
      const cwd = await resolveWorkingDirectory(agent);
      const { stdout } = await execFileAsync("git", ["-C", cwd, "diff", "--stat"], { maxBuffer: MAX_EXEC_BUFFER });
      const output = stdout.trim();
      return {
        status: "success",
        message: output ? truncate(output, DIFF_OUTPUT_LIMIT) : "변경 사항이 없습니다.",
      };
    } catch (error) {
      return { status: "failed", message: `diff를 읽지 못했습니다: ${errorMessage(error)}` };
    }
  },

  create_pr: async ({ agent }) => {
    try {
      const cwd = await resolveWorkingDirectory(agent);
      const { stdout } = await execFileAsync("gh", ["pr", "create", "--fill"], { cwd, maxBuffer: MAX_EXEC_BUFFER });
      const output = stdout.trim();
      return { status: "success", message: output ? truncate(output, DIFF_OUTPUT_LIMIT) : "PR을 생성했습니다." };
    } catch (error) {
      return { status: "failed", message: `PR을 생성하지 못했습니다: ${errorMessage(error)}` };
    }
  },

  open_pr: async ({ agent }) => {
    try {
      const cwd = await resolveWorkingDirectory(agent);
      await execFileAsync("gh", ["pr", "view", "--web"], { cwd, maxBuffer: MAX_EXEC_BUFFER });
      return { status: "success", message: "브라우저에서 PR을 열었습니다." };
    } catch (error) {
      return { status: "failed", message: `PR을 열지 못했습니다: ${errorMessage(error)}` };
    }
  },
};

async function execute(agentId: string, request: AgentActionRequest): Promise<AgentActionResult> {
  const snapshot = await getSnapshot();
  const agent = snapshot.byId[agentId];
  if (!agent) {
    return { agentId, action: request.action, status: "skipped", message: "등록되지 않은 에이전트입니다." };
  }

  try {
    const outcome = await ACTION_HANDLERS[request.action]({ agent, force: request.force ?? false });
    return { agentId, action: request.action, ...outcome };
  } catch (error) {
    return { agentId, action: request.action, status: "failed", message: errorMessage(error) };
  }
}

/** Sequential so one agent's failure never aborts the batch and the result order matches the input. */
async function executeBulk(agentIds: string[], action: AgentActionType, force?: boolean): Promise<AgentActionResult[]> {
  const results: AgentActionResult[] = [];

  for (const agentId of agentIds) {
    results.push(await execute(agentId, force === undefined ? { action } : { action, force }));
  }

  return results;
}

export const localAgentCommandRepository: AgentCommandRepository = { execute, executeBulk };
