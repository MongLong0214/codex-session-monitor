import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import type { Agent, ProjectRef } from "@/domain/agent/agent";
import type { AgentStatus } from "@/domain/agent/status";

import { ratesForModel } from "./claude-pricing";
import { STALE_HEARTBEAT_THRESHOLD_MS } from "./incident-detection";

/**
 * Claude Code session reader. Mirrors the spirit of the Codex local-adapter (schema-adaptive,
 * graceful degradation, a warnings array, "never fabricate a signal that isn't really there"),
 * but reads Claude Code's own local transcripts instead of Codex's SQLite state DB.
 *
 * Transcripts live at `<claudeHome>/projects/<encoded-cwd>/<sessionId>.jsonl`, one JSONL event per
 * line. The `<encoded-cwd>` directory name is NOT reliably reversible (project paths can contain
 * literal hyphens), so we never decode it — the real `cwd` is read from the file content instead.
 */

/** Mirrors local-adapter.RECENT_ACTIVITY_MS (private there). "Recent activity" ⇒ running. */
const RECENT_ACTIVITY_MS = 5 * 60 * 1000;
/** Shared source of truth with the stale detector and the Codex adapter's idle threshold. */
const OBSERVED_IDLE_MS = STALE_HEARTBEAT_THRESHOLD_MS;
/**
 * Only sessions whose file was touched within this window are surfaced — the same recency tier the
 * Codex adapter falls back to when process correlation is unavailable, which is always the case for
 * Claude Code here (see the process-liveness note below). Keeps a 900MB+ transcript tree from being
 * scanned in full on every poll.
 */
const ACTIVE_WINDOW_MS = OBSERVED_IDLE_MS;
/** Safety cap so a pathological window (hundreds of just-touched files) can't stall a snapshot. */
const MAX_SESSIONS = 40;
const SCAN_CONCURRENCY = 4;
const DISPLAY_NAME_MAX = 120;
const CURRENT_TASK_MAX = 220;

const SUBSTANTIVE_TYPES = new Set(["user", "assistant", "system", "attachment"]);

/**
 * Claude Code has no documented env override analogous to Codex's CODEX_HOME; CLAUDE_CONFIG_DIR is
 * the one the CLI is observed to honor, so we check it defensively and default to ~/.claude.
 */
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNonNegativeInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

/** Mirrors local-adapter.compactText: collapse whitespace, trim, ellipsize past maxLength. */
export function compactText(value: unknown, maxLength = CURRENT_TASK_MAX): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function isoToMs(value: unknown): number | null {
  const text = asString(value);
  if (!text) {
    return null;
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function toIso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function warn(message: string): string {
  return `Claude Code 세션 읽기 경고: ${message}`;
}

/** One session index entry, as found in `<projectDir>/sessions-index.json` when present. */
interface SessionIndexEntry {
  sessionId: string;
  isSidechain: boolean;
  aiTitle: string | null;
  firstPrompt: string | null;
}

/**
 * Loads the project directory's sessions-index.json into a lookup by sessionId. On this machine the
 * index was observed to be entirely stale (its fullPath entries pointed at deleted files), so it is
 * used ONLY as optional metadata enrichment for files we independently discovered — never as the
 * enumeration source. Absent/corrupt index ⇒ empty map, degrading exactly like the Codex adapter.
 */
async function readSessionIndex(projectDir: string): Promise<Map<string, SessionIndexEntry>> {
  const byId = new Map<string, SessionIndexEntry>();

  let raw: string;
  try {
    raw = await readFile(path.join(projectDir, "sessions-index.json"), "utf8");
  } catch {
    return byId;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return byId;
  }

  const entries = toRecord(parsed)?.entries;
  if (!Array.isArray(entries)) {
    return byId;
  }

  for (const entry of entries) {
    const record = toRecord(entry);
    const sessionId = asString(record?.sessionId);
    if (!record || !sessionId) {
      continue;
    }

    byId.set(sessionId, {
      sessionId,
      isSidechain: record.isSidechain === true,
      aiTitle: asString(record.summary),
      firstPrompt: asString(record.firstPrompt),
    });
  }

  return byId;
}

/** Deduplicated per-response usage — one entry per Claude API response (message.id), not per line. */
interface ResponseUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  ephemeral5mTokens: number;
  ephemeral1hTokens: number;
}

/** Everything one JSONL transcript yields after a single streaming pass. */
export interface SessionScan {
  cwd: string | null;
  gitBranch: string | null;
  cliVersion: string | null;
  permissionMode: string | null;
  aiTitle: string | null;
  firstUserText: string | null;
  lastText: string | null;
  model: string | null;
  firstActivityMs: number | null;
  lastActivityMs: number | null;
  /** Keyed by message.id so the multi-line thinking/text/tool_use split of one response is counted once. */
  responsesById: Map<string, ResponseUsage>;
}

function emptyScan(): SessionScan {
  return {
    cwd: null,
    gitBranch: null,
    cliVersion: null,
    permissionMode: null,
    aiTitle: null,
    firstUserText: null,
    lastText: null,
    model: null,
    firstActivityMs: null,
    lastActivityMs: null,
    responsesById: new Map(),
  };
}

/** A first user prompt is usable only if it is real prose — not a tool result or a slash-command echo. */
function usableUserPrompt(content: unknown, isMeta: boolean): string | null {
  if (isMeta || typeof content !== "string") {
    return null;
  }

  const trimmed = content.trim();
  if (trimmed.startsWith("<local-command-") || trimmed.startsWith("<command-name>")) {
    return null;
  }

  /**
   * Sub-agent sessions arrive wrapped in an envelope tag (e.g. `<teammate-message ...>…`), which is
   * machine plumbing, not a title. Strip a leading/trailing XML-ish wrapper so the display name is
   * the human prose inside — matching this project's preference for clean titles over raw dumps.
   */
  const unwrapped = trimmed
    .replace(/^(?:\s*<[^>]+>\s*)+/, "")
    .replace(/(?:\s*<\/[^>]+>\s*)+$/, "")
    .trim();

  return unwrapped || null;
}

/** Human-meaningful text of a substantive line, or "" — mirrors local-adapter.textFromResponseItem. */
export function textFromLine(type: string, message: Record<string, unknown> | null, content: unknown): string {
  if (type === "assistant" && message) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .map((block) => {
        const record = toRecord(block);
        if (record?.type === "text") {
          return asString(record.text) ?? "";
        }
        if (record?.type === "tool_use") {
          return `도구 실행: ${asString(record.name) ?? "이름 없는 도구"}`;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
    return compactText(text);
  }

  if (type === "user") {
    return compactText(typeof content === "string" ? content : "");
  }

  return "";
}

function accumulateAssistant(scan: SessionScan, message: Record<string, unknown>): void {
  const id = asString(message.id);
  if (!id || scan.responsesById.has(id)) {
    /**
     * One API response is written as several assistant lines (thinking, text, each tool_use) that
     * ALL repeat the identical usage block. Keying on message.id counts it once — a naive per-line
     * sum was measured to overcount tokens/cost by ~2.3x on real data.
     */
    return;
  }

  const usage = toRecord(message.usage) ?? {};
  const cacheCreation = toRecord(usage.cache_creation) ?? {};

  scan.responsesById.set(id, {
    model: asString(message.model),
    inputTokens: asNonNegativeInteger(usage.input_tokens),
    outputTokens: asNonNegativeInteger(usage.output_tokens),
    cacheCreationTokens: asNonNegativeInteger(usage.cache_creation_input_tokens),
    cacheReadTokens: asNonNegativeInteger(usage.cache_read_input_tokens),
    ephemeral5mTokens: asNonNegativeInteger(cacheCreation.ephemeral_5m_input_tokens),
    ephemeral1hTokens: asNonNegativeInteger(cacheCreation.ephemeral_1h_input_tokens),
  });
}

function applyLine(scan: SessionScan, entry: Record<string, unknown>): void {
  const type = asString(entry.type);
  if (!type) {
    return;
  }

  const cwd = asString(entry.cwd);
  if (cwd) {
    scan.cwd = cwd;
  }
  const branch = asString(entry.gitBranch);
  if (branch) {
    scan.gitBranch = branch;
  }
  const version = asString(entry.version);
  if (version) {
    scan.cliVersion = version;
  }

  if (type === "ai-title") {
    scan.aiTitle = asString(entry.aiTitle) ?? scan.aiTitle;
    return;
  }

  if (type === "permission-mode") {
    scan.permissionMode = asString(entry.permissionMode) ?? scan.permissionMode;
    return;
  }

  const timestampMs = isoToMs(entry.timestamp);
  if (timestampMs !== null && SUBSTANTIVE_TYPES.has(type)) {
    scan.firstActivityMs ??= timestampMs;
    scan.lastActivityMs = timestampMs;
  }

  const message = toRecord(entry.message);

  if (type === "user" && scan.firstUserText === null) {
    const prompt = usableUserPrompt(message?.content, entry.isMeta === true);
    if (prompt) {
      scan.firstUserText = prompt;
    }
  }

  if (type === "assistant" && message) {
    const model = asString(message.model);
    if (model) {
      scan.model = model;
    }
    accumulateAssistant(scan, message);
  }

  const text = textFromLine(type, message, message?.content);
  if (text) {
    scan.lastText = text;
  }
}

async function scanSessionFile(filePath: string): Promise<SessionScan> {
  const scan = emptyScan();
  const reader = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      /** Cheap prefilter — most non-JSON/blank lines never reach JSON.parse. */
      if (!line.startsWith("{")) {
        continue;
      }

      try {
        const entry = toRecord(JSON.parse(line));
        if (entry) {
          applyLine(scan, entry);
        }
      } catch {
        // 잘린 줄이나 비 JSON 줄은 무시한다.
      }
    }
  } finally {
    reader.close();
  }

  return scan;
}

/** Total tokens billed across the session (deduped) — spec's four raw usage counters, summed. */
export function totalTokens(responses: Iterable<ResponseUsage>): number {
  let total = 0;
  for (const usage of responses) {
    total += usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  }
  return total;
}

/**
 * Real dollar cost, or null when it cannot be computed honestly. Rule: if the session contains ANY
 * response from a model missing from the pricing table AND that response actually billed tokens, the
 * whole session's cost is null rather than a misleading partial total. Zero-token unknown responses
 * (e.g. `<synthetic>`) never force null. This is the conservative, honest choice — a partial figure
 * presented as complete would be worse than none (the same discipline the Codex adapter applies).
 */
export function sessionCostUsd(responses: Iterable<ResponseUsage>): number | null {
  let cost = 0;

  for (const usage of responses) {
    const rates = ratesForModel(usage.model);
    if (!rates) {
      const billed =
        usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens > 0;
      if (billed) {
        return null;
      }
      continue;
    }

    cost +=
      (usage.inputTokens * rates.input +
        usage.ephemeral5mTokens * rates.cacheWrite5m +
        usage.ephemeral1hTokens * rates.cacheWrite1h +
        usage.cacheReadTokens * rates.cacheRead +
        usage.outputTokens * rates.output) /
      1_000_000;
  }

  return Number(cost.toFixed(4));
}

/** Prefer the auto-generated conversation title; fall back to a real first prompt; else a placeholder. */
export function pickDisplayName(aiTitle: string | null, firstUserText: string | null, isSubagent: boolean): string {
  const chosen = compactText(aiTitle ?? "", DISPLAY_NAME_MAX) || compactText(firstUserText ?? "", DISPLAY_NAME_MAX);
  if (chosen) {
    return chosen;
  }

  return isSubagent ? "이름 없는 서브 에이전트" : "이름 없는 메인 세션";
}

/**
 * File-recency classifier. Claude Code CLI processes cannot be reliably correlated to a session in
 * this environment (confirmed via ps — no unambiguous match), so liveness rests purely on activity
 * recency, reusing the Codex adapter's own thresholds. Only running/waiting/stale are ever emitted;
 * there is no honest completion/approval/failure signal in the tail, so those kinds are never faked.
 */
export function classifyClaudeStatus(lastActivityMs: number, now: number): AgentStatus {
  const age = now - lastActivityMs;
  const lastIso = toIso(lastActivityMs);

  if (age <= RECENT_ACTIVITY_MS) {
    return { kind: "running", startedAt: lastIso, lastHeartbeatAt: lastIso };
  }

  if (age <= OBSERVED_IDLE_MS) {
    return { kind: "waiting", since: lastIso };
  }

  return { kind: "stale", lastHeartbeatAt: lastIso };
}

function projectRefFromCwd(cwd: string | null): ProjectRef {
  const resolved = cwd ? path.resolve(cwd) : "";
  const name = resolved ? path.basename(resolved) : "";
  /** No git-origin URL exists anywhere in Claude Code session data — null is correct, not a gap. */
  return { cwd: resolved, name: name || "(작업 디렉터리 없음)", repoUrl: null };
}

interface DiscoveredFile {
  sessionId: string;
  filePath: string;
  projectDir: string;
  mtimeMs: number;
}

async function discoverActiveFiles(now: number): Promise<DiscoveredFile[]> {
  const projectsRoot = path.join(claudeHome(), "projects");

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsRoot);
  } catch {
    return [];
  }

  const found: DiscoveredFile[] = [];

  await Promise.all(
    projectDirs.map(async (dirName) => {
      const projectDir = path.join(projectsRoot, dirName);
      let entries: string[];
      try {
        entries = await readdir(projectDir);
      } catch {
        return;
      }

      await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".jsonl"))
          .map(async (entry) => {
            const filePath = path.join(projectDir, entry);
            try {
              const fileStat = await stat(filePath);
              if (now - fileStat.mtimeMs <= ACTIVE_WINDOW_MS) {
                found.push({ sessionId: entry.slice(0, -".jsonl".length), filePath, projectDir, mtimeMs: fileStat.mtimeMs });
              }
            } catch {
              // 사라졌거나 접근 불가한 파일은 건너뛴다.
            }
          }),
      );
    }),
  );

  return found.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function work(): Promise<void> {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const value = values[currentIndex];
      if (value !== undefined) {
        results[currentIndex] = await mapper(value);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => work()));
  return results;
}

function toAgent(file: DiscoveredFile, scan: SessionScan, indexEntry: SessionIndexEntry | undefined, now: number): Agent {
  const isSubagent = indexEntry?.isSidechain === true;
  const responses = scan.responsesById.values();
  const lastActivityMs = scan.lastActivityMs ?? file.mtimeMs;
  const startedAtMs = scan.firstActivityMs ?? lastActivityMs;
  const aiTitle = scan.aiTitle ?? indexEntry?.aiTitle ?? null;
  const firstUserText = scan.firstUserText ?? indexEntry?.firstPrompt ?? null;

  return {
    id: file.sessionId,
    displayName: pickDisplayName(aiTitle, firstUserText, isSubagent),
    role: isSubagent ? "subagent" : "main",
    project: projectRefFromCwd(scan.cwd),
    branch: scan.gitBranch,
    commitSha: null,
    model: scan.model,
    reasoningEffort: null,
    status: classifyClaudeStatus(lastActivityMs, now),
    currentTask: scan.lastText ?? (firstUserText ? compactText(firstUserText) : null),
    tokensUsed: totalTokens(scan.responsesById.values()),
    costUsd: sessionCostUsd(responses),
    startedAt: toIso(startedAtMs),
    updatedAt: toIso(lastActivityMs),
    lastHeartbeatAt: scan.lastActivityMs === null ? null : toIso(scan.lastActivityMs),
    runtimePids: [],
    parentId: null,
    childIds: [],
    cliVersion: scan.cliVersion,
    approvalMode: scan.permissionMode,
    rolloutPath: file.filePath,
    source: "claude_code",
  };
}

export interface ClaudeCodeCollection {
  agents: Agent[];
  warnings: string[];
}

/**
 * Reads Claude Code's local transcripts and returns them as Agents plus any degradation warnings.
 * Never throws: any failure (missing ~/.claude, unreadable file) degrades to fewer agents + a
 * warning, so the merged snapshot still shows the other source's agents.
 */
export async function collectClaudeCodeAgents(now: number): Promise<ClaudeCodeCollection> {
  const warnings: string[] = [];

  let discovered: DiscoveredFile[];
  try {
    discovered = await discoverActiveFiles(now);
  } catch {
    return { agents: [], warnings: [warn("세션 디렉터리를 읽지 못했습니다.")] };
  }

  if (discovered.length === 0) {
    return { agents: [], warnings };
  }

  if (discovered.length > MAX_SESSIONS) {
    warnings.push(warn(`최근 세션이 ${discovered.length}개로 많아 최신 ${MAX_SESSIONS}개만 표시합니다.`));
    discovered = discovered.slice(0, MAX_SESSIONS);
  }

  const indexCache = new Map<string, Map<string, SessionIndexEntry>>();
  async function indexFor(projectDir: string): Promise<Map<string, SessionIndexEntry>> {
    const cached = indexCache.get(projectDir);
    if (cached) {
      return cached;
    }
    const loaded = await readSessionIndex(projectDir);
    indexCache.set(projectDir, loaded);
    return loaded;
  }

  const agents = await mapWithConcurrency(discovered, SCAN_CONCURRENCY, async (file) => {
    try {
      const [scan, index] = await Promise.all([scanSessionFile(file.filePath), indexFor(file.projectDir)]);
      return toAgent(file, scan, index.get(file.sessionId), now);
    } catch {
      return null;
    }
  });

  const usable = agents.filter((agent): agent is Agent => agent !== null);
  if (usable.length < discovered.length) {
    warnings.push(warn(`세션 파일 ${discovered.length - usable.length}개를 읽지 못해 건너뛰었습니다.`));
  }

  /** Deterministic order (updatedAt desc, id asc) so the merged snapshot fingerprint is stable. */
  usable.sort((left, right) => {
    const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return byUpdated !== 0 ? byUpdated : left.id.localeCompare(right.id);
  });

  return { agents: usable, warnings };
}
