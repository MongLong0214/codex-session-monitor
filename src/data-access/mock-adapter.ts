import type { AgentActionRequest, AgentActionResult, AgentActionType } from "@/domain/agent/actions";
import type { Agent, ProjectRef } from "@/domain/agent/agent";
import type { AgentStatus, AgentStatusKind } from "@/domain/agent/status";
import { AgentStatusKindSchema } from "@/domain/agent/status";
import type { DashboardSnapshot, DashboardSummary } from "@/domain/dashboard";

import type { AgentCommandRepository } from "./agent-command-repository";
import type { DashboardRepository } from "./dashboard-repository";
import { detectIncidents } from "./incident-detection";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const NO_CONTROL_CHANNEL_MESSAGE =
  "이 모니터는 읽기 전용 관찰자입니다. 외부에서 실행된 세션의 stdin/PTY 제어 채널이 없어 이 동작을 수행할 수 없습니다.";

/** Deterministic PRNG. The bulk generator must be byte-identical for the same (count, seed, now). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function repeatToLength(fragment: string, minLength: number): string {
  return fragment.repeat(Math.ceil(minLength / fragment.length)).slice(0, minLength);
}

const PROJECT_MONITOR: ProjectRef = {
  cwd: "/Users/dev/WebstormProjects/codex-session-monitor",
  name: "codex-session-monitor",
  repoUrl: "git@github.com:example-user/codex-session-monitor.git",
};

const PROJECT_NEWSLETTER: ProjectRef = {
  cwd: "/Users/dev/WebstormProjects/market-digest-service",
  name: "market-digest-service",
  repoUrl: "https://github.com/example-user/market-digest-service.git",
};

/** No origin remote — exercises the "repoUrl is null, fall back to cwd basename" path. */
const PROJECT_POLARIS: ProjectRef = {
  cwd: "/Users/dev/WebstormProjects/docs-portal",
  name: "docs-portal",
  repoUrl: null,
};

/**
 * A Claude-Code-hosted project. repoUrl is null because Claude Code session data carries no
 * git-origin URL — matching real claude-code-adapter behavior, not a fixture gap.
 */
const PROJECT_CLAUDE_LAB: ProjectRef = {
  cwd: "/Users/dev/workspace/agent-playground",
  name: "agent-playground",
  repoUrl: null,
};

/** 150+ char name/branch/task, for column truncation and ellipsis testing. */
const LONG_PROJECT_NAME = repeatToLength("extremely-long-monorepo-package-name-that-should-truncate-", 168);
const LONG_BRANCH_NAME = repeatToLength("feature/very-long-branch-name-for-truncation-testing-", 154);
const LONG_TASK_TEXT = repeatToLength(
  "리팩터링 중: src/features/dashboard/components/agent-table.tsx 의 가상 스크롤 경계를 재계산하고 열 너비를 재측정합니다. ",
  212,
);

const PROJECT_LONG: ProjectRef = {
  cwd: "/Users/dev/WebstormProjects/very-long-workspace-path/packages/internal-tooling/dashboard-renderer",
  name: LONG_PROJECT_NAME,
  repoUrl: "git@github.com:example-user/very-long-workspace-path.git",
};

/** Two agents naming this same path — the fixture that a future concurrent_file_edit detector needs. */
const SHARED_FILE_PATH = "src/features/dashboard/components/agent-table.tsx";

const LOG_SHAPED_TASK = [
  "[16:41:02] tool-call rg --files-with-matches 'AgentStatusKind' src/",
  "[16:41:03] patch_apply_end src/data-access/local-adapter.ts (+42 -7)",
  "[16:41:09] agent_message 상태 매핑을 5종으로 좁혔습니다. 타입체크 재실행 중…",
].join(" ");

interface FixtureSpec {
  id: string;
  displayName: string;
  /** Omitted ⇒ "codex"; the Claude Code fixtures set it explicitly to exercise the new discriminator. */
  source?: Agent["source"];
  role: Agent["role"];
  project: ProjectRef;
  branch: string | null;
  commitSha: string | null;
  model: string | null;
  reasoningEffort: string | null;
  status: AgentStatus;
  currentTask: string | null;
  tokensUsed: number;
  costUsd: number | null;
  startedAtOffsetMs: number;
  updatedAtOffsetMs: number;
  lastHeartbeatOffsetMs: number | null;
  runtimePids: number[];
  parentId: string | null;
  childIds: string[];
  cliVersion: string | null;
  approvalMode: string | null;
}

function fixtureSpecs(now: number): FixtureSpec[] {
  const at = (offsetMs: number): string => iso(now - offsetMs);

  return [
    {
      id: "mock-main-monitor",
      displayName: "Codex Session Monitor 마이그레이션",
      role: "main",
      project: PROJECT_MONITOR,
      branch: "main",
      commitSha: "8c02361f4a1b9d3e7c5a2f8b6d4e1c9a3b7f5e2d",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      status: { kind: "running", startedAt: at(3 * HOUR_MS), lastHeartbeatAt: at(12_000) },
      currentTask: "src/data-access/local-adapter.ts 포팅을 마무리하고 타입체크를 실행합니다.",
      tokensUsed: 184_302,
      costUsd: null,
      startedAtOffsetMs: 3 * HOUR_MS,
      updatedAtOffsetMs: 12_000,
      lastHeartbeatOffsetMs: 12_000,
      runtimePids: [50326],
      parentId: null,
      childIds: ["mock-sub-table", "mock-sub-virtual"],
      cliVersion: "0.144.1",
      approvalMode: "never",
    },
    {
      id: "mock-sub-table",
      displayName: "에이전트 테이블 열 정의",
      role: "subagent",
      project: PROJECT_MONITOR,
      branch: "main",
      commitSha: "8c02361f4a1b9d3e7c5a2f8b6d4e1c9a3b7f5e2d",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      status: { kind: "running", startedAt: at(92 * MINUTE_MS), lastHeartbeatAt: at(31_000) },
      currentTask: `${SHARED_FILE_PATH} 에 상태 뱃지 열을 추가하는 중입니다.`,
      tokensUsed: 42_881,
      costUsd: null,
      startedAtOffsetMs: 92 * MINUTE_MS,
      updatedAtOffsetMs: 31_000,
      lastHeartbeatOffsetMs: 31_000,
      runtimePids: [50326],
      parentId: "mock-main-monitor",
      childIds: ["mock-sub-deep"],
      cliVersion: "0.144.1",
      approvalMode: "never",
    },
    {
      id: "mock-sub-deep",
      displayName: "가상 스크롤 측정",
      role: "subagent",
      project: PROJECT_MONITOR,
      branch: "main",
      commitSha: "8c02361f4a1b9d3e7c5a2f8b6d4e1c9a3b7f5e2d",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      status: { kind: "running", startedAt: at(38 * MINUTE_MS), lastHeartbeatAt: at(48_000) },
      currentTask: LOG_SHAPED_TASK,
      tokensUsed: 12_004,
      costUsd: null,
      startedAtOffsetMs: 38 * MINUTE_MS,
      updatedAtOffsetMs: 48_000,
      lastHeartbeatOffsetMs: 48_000,
      runtimePids: [50326],
      parentId: "mock-sub-table",
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "never",
    },
    {
      id: "mock-sub-virtual",
      displayName: "테이블 가상화 검토",
      role: "subagent",
      project: PROJECT_MONITOR,
      branch: "main",
      commitSha: "8c02361f4a1b9d3e7c5a2f8b6d4e1c9a3b7f5e2d",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      // 같은 파일을 편집 중인 두 번째 에이전트 — concurrent_file_edit 픽스처 쌍.
      status: { kind: "waiting", since: at(6 * MINUTE_MS) },
      currentTask: `${SHARED_FILE_PATH} 의 행 높이 계산 결과를 기다리는 중입니다.`,
      tokensUsed: 8_120,
      costUsd: null,
      startedAtOffsetMs: 70 * MINUTE_MS,
      updatedAtOffsetMs: 6 * MINUTE_MS,
      lastHeartbeatOffsetMs: 6 * MINUTE_MS,
      runtimePids: [],
      parentId: "mock-main-monitor",
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "never",
    },
    {
      id: "mock-main-newsletter",
      displayName: "TLI v3 과학적 재구성",
      role: "main",
      project: PROJECT_NEWSLETTER,
      branch: "feat/tli-v3",
      commitSha: "93a14abc72fd3870a28ce442cf89763aaeb0ba55",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      status: { kind: "running", startedAt: at(5 * HOUR_MS), lastHeartbeatAt: at(45_000) },
      currentTask: "지표 정규화 파이프라인을 재작성하고 백테스트를 재실행합니다.",
      tokensUsed: 512_774,
      costUsd: null,
      startedAtOffsetMs: 5 * HOUR_MS,
      updatedAtOffsetMs: 45_000,
      lastHeartbeatOffsetMs: 45_000,
      runtimePids: [50412, 50413],
      parentId: null,
      childIds: ["mock-sub-ingest", "mock-sub-digest"],
      cliVersion: "0.144.1",
      approvalMode: "on-request",
    },
    {
      id: "mock-sub-ingest",
      displayName: "가격 데이터 수집기",
      role: "subagent",
      project: PROJECT_NEWSLETTER,
      branch: "feat/tli-v3",
      commitSha: "93a14abc72fd3870a28ce442cf89763aaeb0ba55",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      status: { kind: "completed", completedAt: at(22 * MINUTE_MS) },
      currentTask: "커밋 3f2a1c9 'feat(ingest): add adjusted-close normalization' 을 남기고 종료했습니다.",
      tokensUsed: 76_310,
      costUsd: null,
      startedAtOffsetMs: 4 * HOUR_MS,
      updatedAtOffsetMs: 22 * MINUTE_MS,
      lastHeartbeatOffsetMs: 22 * MINUTE_MS,
      runtimePids: [],
      parentId: "mock-main-newsletter",
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "on-request",
    },
    {
      id: "mock-sub-digest",
      displayName: "다이제스트 렌더러",
      role: "subagent",
      project: PROJECT_NEWSLETTER,
      branch: "feat/tli-v3",
      commitSha: "93a14abc72fd3870a28ce442cf89763aaeb0ba55",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      // 반복 실패 성격의 픽스처: retryCount 3.
      status: {
        kind: "failed",
        error: "vitest exited with code 1 — 4 tests failed in digest-renderer.test.ts",
        retryCount: 3,
        failedAt: at(9 * MINUTE_MS),
      },
      currentTask: "digest-renderer.test.ts 의 스냅샷 4건이 계속 실패합니다.",
      tokensUsed: 98_442,
      costUsd: null,
      startedAtOffsetMs: 3 * HOUR_MS,
      updatedAtOffsetMs: 9 * MINUTE_MS,
      lastHeartbeatOffsetMs: 9 * MINUTE_MS,
      runtimePids: [],
      parentId: "mock-main-newsletter",
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "on-request",
    },
    {
      id: "mock-blocked-merge",
      displayName: "리베이스 충돌 해결",
      role: "main",
      project: PROJECT_NEWSLETTER,
      branch: "feat/rebase-domain-types",
      commitSha: "ecff09334611aef31171d870549f5e30dea1fc18",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      status: {
        kind: "blocked",
        blocker: "merge conflict in src/domain/agent/agent.ts (both modified)",
        since: at(26 * MINUTE_MS),
      },
      currentTask: "git rebase main 중 src/domain/agent/agent.ts 충돌로 중단되었습니다.",
      tokensUsed: 33_950,
      costUsd: null,
      startedAtOffsetMs: 2 * HOUR_MS,
      updatedAtOffsetMs: 26 * MINUTE_MS,
      lastHeartbeatOffsetMs: 26 * MINUTE_MS,
      runtimePids: [50588],
      parentId: null,
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "on-request",
    },
    {
      id: "mock-approval-deploy",
      displayName: "릴리스 배포 승인 대기",
      role: "main",
      project: PROJECT_POLARIS,
      branch: "release/2026.07",
      commitSha: "aa77b1240c8e5f6d9b3a1e4c7f2d8a5b6c3e9f10",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      status: {
        kind: "approval_required",
        requestedAt: at(18 * MINUTE_MS),
        reason: "gh pr merge --admin 실행 승인이 필요합니다.",
      },
      currentTask: "gh pr merge --admin 실행 전 사용자 승인을 기다립니다.",
      tokensUsed: 21_006,
      costUsd: null,
      startedAtOffsetMs: 80 * MINUTE_MS,
      updatedAtOffsetMs: 18 * MINUTE_MS,
      lastHeartbeatOffsetMs: 18 * MINUTE_MS,
      runtimePids: [50701],
      parentId: null,
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "untrusted",
    },
    {
      id: "mock-stale-worker",
      displayName: "레거시 스타일 정리",
      role: "main",
      project: PROJECT_POLARIS,
      branch: "chore/legacy-styles",
      commitSha: "4d5e6f70819a2b3c4d5e6f708192a3b4c5d6e7f8",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      // 47분 무활동 → stale_heartbeat 인시던트를 트리거한다 (임계값 30분).
      status: { kind: "stale", lastHeartbeatAt: at(47 * MINUTE_MS) },
      currentTask: "public/app.css 의 미사용 규칙을 제거하던 중 응답이 끊겼습니다.",
      tokensUsed: 15_233,
      costUsd: null,
      startedAtOffsetMs: 4 * HOUR_MS,
      updatedAtOffsetMs: 47 * MINUTE_MS,
      lastHeartbeatOffsetMs: 47 * MINUTE_MS,
      runtimePids: [],
      parentId: null,
      childIds: [],
      cliVersion: "0.143.0",
      approvalMode: "never",
    },
    {
      id: "mock-offline-runner",
      displayName: "야간 배치 실행기",
      role: "main",
      project: PROJECT_POLARIS,
      branch: "main",
      commitSha: "1122334455667788990011223344556677889900",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      status: { kind: "offline", lastSeenAt: at(3 * HOUR_MS) },
      currentTask: "야간 배치가 종료된 뒤 프로세스가 관측되지 않습니다.",
      tokensUsed: 64_120,
      costUsd: null,
      startedAtOffsetMs: 9 * HOUR_MS,
      updatedAtOffsetMs: 3 * HOUR_MS,
      lastHeartbeatOffsetMs: 3 * HOUR_MS,
      runtimePids: [],
      parentId: null,
      childIds: [],
      cliVersion: "0.143.0",
      approvalMode: "never",
    },
    {
      id: "mock-offline-never",
      displayName: "이름 없는 메인 세션",
      role: "main",
      project: PROJECT_POLARIS,
      // 선택 필드 누락 픽스처: branch/commitSha/model/currentTask 전부 null.
      branch: null,
      commitSha: null,
      model: null,
      reasoningEffort: null,
      status: { kind: "offline", lastSeenAt: null },
      currentTask: null,
      tokensUsed: 0,
      costUsd: null,
      startedAtOffsetMs: 26 * HOUR_MS,
      updatedAtOffsetMs: 26 * HOUR_MS,
      lastHeartbeatOffsetMs: null,
      runtimePids: [],
      parentId: null,
      childIds: [],
      cliVersion: null,
      approvalMode: null,
    },
    {
      id: "mock-paused-batch",
      displayName: "인덱싱 배치 (일시정지)",
      role: "main",
      project: PROJECT_NEWSLETTER,
      branch: "chore/reindex",
      commitSha: "99aabbccddeeff00112233445566778899aabbcc",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      status: { kind: "paused", pausedAt: at(14 * MINUTE_MS) },
      currentTask: "SIGSTOP 으로 일시정지된 상태입니다. SIGCONT 로 재개할 수 있습니다.",
      tokensUsed: 9_870,
      costUsd: null,
      startedAtOffsetMs: 100 * MINUTE_MS,
      updatedAtOffsetMs: 14 * MINUTE_MS,
      lastHeartbeatOffsetMs: 14 * MINUTE_MS,
      runtimePids: [50822],
      parentId: null,
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "never",
    },
    {
      id: "mock-cost-spike",
      displayName: "대규모 리팩터링 (비용 급증)",
      role: "main",
      project: PROJECT_NEWSLETTER,
      branch: "refactor/whole-repo",
      commitSha: "deadbeef00112233445566778899aabbccddeeff",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      status: { kind: "running", startedAt: at(7 * HOUR_MS), lastHeartbeatAt: at(5_000) },
      currentTask: "저장소 전체 타입 시그니처를 재작성하는 중입니다. 토큰 사용량이 급증했습니다.",
      tokensUsed: 4_812_665,
      // 모의 모드에서만 비용을 시뮬레이션한다. 로컬 어댑터는 가격표가 없어 항상 null이다.
      costUsd: 42.87,
      startedAtOffsetMs: 7 * HOUR_MS,
      updatedAtOffsetMs: 5_000,
      lastHeartbeatOffsetMs: 5_000,
      runtimePids: [50901],
      parentId: null,
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "never",
    },
    {
      id: "mock-long-names",
      displayName: repeatToLength("아주 긴 세션 제목이 표에서 어떻게 잘리는지 확인하기 위한 픽스처입니다 ", 158),
      role: "main",
      project: PROJECT_LONG,
      branch: LONG_BRANCH_NAME,
      commitSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      status: { kind: "running", startedAt: at(50 * MINUTE_MS), lastHeartbeatAt: at(20_000) },
      currentTask: LONG_TASK_TEXT,
      tokensUsed: 130_450,
      costUsd: null,
      startedAtOffsetMs: 50 * MINUTE_MS,
      updatedAtOffsetMs: 20_000,
      lastHeartbeatOffsetMs: 20_000,
      runtimePids: [51002],
      parentId: null,
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "never",
    },
    {
      id: "mock-commit-flavored",
      displayName: "인증 토큰 회전",
      role: "main",
      project: PROJECT_POLARIS,
      branch: "fix/session-token-rotation",
      commitSha: "3f2a1c9d8e7b6a5f4c3d2e1b0a9f8e7d6c5b4a39",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      status: { kind: "completed", completedAt: at(41 * MINUTE_MS) },
      currentTask: "커밋 3f2a1c9 'fix(auth): rotate session token on privilege change' 를 푸시했습니다.",
      tokensUsed: 55_120,
      costUsd: null,
      startedAtOffsetMs: 3 * HOUR_MS,
      updatedAtOffsetMs: 41 * MINUTE_MS,
      lastHeartbeatOffsetMs: 41 * MINUTE_MS,
      runtimePids: [],
      parentId: null,
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "on-request",
    },
    {
      id: "mock-pr-flavored",
      displayName: "PR 리뷰 대기",
      role: "main",
      project: PROJECT_MONITOR,
      branch: "feat/sse-bridge",
      commitSha: "77665544332211009988aabbccddeeff00112233",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      status: { kind: "waiting", since: at(11 * MINUTE_MS) },
      currentTask: "gh pr create --fill 로 생성한 https://github.com/example-user/codex-session-monitor/pull/128 리뷰를 기다립니다.",
      tokensUsed: 27_640,
      costUsd: null,
      startedAtOffsetMs: 2 * HOUR_MS,
      updatedAtOffsetMs: 11 * MINUTE_MS,
      lastHeartbeatOffsetMs: 11 * MINUTE_MS,
      runtimePids: [],
      parentId: null,
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: "never",
    },
    {
      // Claude Code 세션은 실제 토큰 사용량으로 진짜 비용을 계산할 수 있어 costUsd가 non-null이다.
      id: "mock-claude-refactor",
      displayName: "타입 안전성 리팩터링 계획 수립",
      source: "claude_code",
      role: "main",
      project: PROJECT_CLAUDE_LAB,
      branch: "main",
      // Claude Code 세션 데이터에는 커밋 SHA 필드가 없다 — 실제 어댑터도 항상 null이다.
      commitSha: null,
      model: "claude-opus-4-8",
      // reasoning_effort 개념이 없다 — 실제 어댑터도 null.
      reasoningEffort: null,
      status: { kind: "running", startedAt: at(2 * HOUR_MS), lastHeartbeatAt: at(8_000) },
      currentTask: "도구 실행: Edit — src/lib 전반의 any 타입을 제거하는 중입니다.",
      tokensUsed: 1_284_502,
      costUsd: 8.47,
      startedAtOffsetMs: 2 * HOUR_MS,
      updatedAtOffsetMs: 8_000,
      lastHeartbeatOffsetMs: 8_000,
      // Claude CLI 프로세스는 세션과 신뢰성 있게 매핑되지 않는다 — 항상 빈 배열.
      runtimePids: [],
      parentId: null,
      childIds: [],
      // Claude Code CLI 버전 형식.
      cliVersion: "2.1.202",
      // permissionMode 를 approvalMode 로 매핑한다.
      approvalMode: "auto",
    },
    {
      id: "mock-claude-tests",
      displayName: "Vitest 커버리지 보강",
      source: "claude_code",
      role: "main",
      // 같은 cwd 를 Codex 세션과 공유 — 병합 시 ProjectRef 가 하나로 합쳐지는지 검증하는 픽스처.
      project: PROJECT_MONITOR,
      branch: "main",
      commitSha: null,
      model: "claude-sonnet-5",
      reasoningEffort: null,
      status: { kind: "waiting", since: at(9 * MINUTE_MS) },
      currentTask: "사용자 입력 대기 중: 테스트 픽스처 명명 규칙을 확인해 주세요.",
      tokensUsed: 642_180,
      costUsd: 2.31,
      startedAtOffsetMs: 70 * MINUTE_MS,
      updatedAtOffsetMs: 9 * MINUTE_MS,
      lastHeartbeatOffsetMs: 9 * MINUTE_MS,
      runtimePids: [],
      parentId: null,
      childIds: [],
      cliVersion: "2.1.199",
      approvalMode: "normal",
    },
    {
      // 51분 무활동 → stale_heartbeat 인시던트를 트리거한다 (임계값 30분).
      id: "mock-claude-stale",
      displayName: "문서 사이트 리브랜딩",
      source: "claude_code",
      role: "main",
      project: PROJECT_CLAUDE_LAB,
      branch: "docs/rebrand",
      commitSha: null,
      model: "claude-opus-4-8",
      reasoningEffort: null,
      status: { kind: "stale", lastHeartbeatAt: at(51 * MINUTE_MS) },
      currentTask: "도구 실행: Write — 랜딩 페이지 카피를 다시 쓰던 중 응답이 끊겼습니다.",
      tokensUsed: 318_744,
      costUsd: 1.06,
      startedAtOffsetMs: 3 * HOUR_MS,
      updatedAtOffsetMs: 51 * MINUTE_MS,
      lastHeartbeatOffsetMs: 51 * MINUTE_MS,
      runtimePids: [],
      parentId: null,
      childIds: [],
      cliVersion: "2.1.199",
      approvalMode: "auto",
    },
    {
      // 가격표에 없는 모델 → costUsd 는 정직하게 null (부분 합계를 완전한 총액처럼 보이게 하지 않는다).
      id: "mock-claude-unknown-model",
      displayName: "실험적 모델로 프로토타이핑",
      source: "claude_code",
      role: "main",
      project: PROJECT_CLAUDE_LAB,
      branch: "spike/new-model",
      commitSha: null,
      model: "claude-fable-5",
      reasoningEffort: null,
      status: { kind: "running", startedAt: at(40 * MINUTE_MS), lastHeartbeatAt: at(15_000) },
      currentTask: "가격표에 없는 모델을 사용 중이라 비용을 계산할 수 없습니다.",
      tokensUsed: 205_991,
      costUsd: null,
      startedAtOffsetMs: 40 * MINUTE_MS,
      updatedAtOffsetMs: 15_000,
      lastHeartbeatOffsetMs: 15_000,
      runtimePids: [],
      parentId: null,
      childIds: [],
      cliVersion: "2.1.202",
      approvalMode: "auto",
    },
  ];
}

function toAgent(spec: FixtureSpec, now: number): Agent {
  const source = spec.source ?? "codex";

  return {
    id: spec.id,
    displayName: spec.displayName,
    source,
    role: spec.role,
    project: spec.project,
    branch: spec.branch,
    commitSha: spec.commitSha,
    model: spec.model,
    reasoningEffort: spec.reasoningEffort,
    status: spec.status,
    currentTask: spec.currentTask,
    tokensUsed: spec.tokensUsed,
    costUsd: spec.costUsd,
    startedAt: iso(now - spec.startedAtOffsetMs),
    updatedAt: iso(now - spec.updatedAtOffsetMs),
    lastHeartbeatAt: spec.lastHeartbeatOffsetMs === null ? null : iso(now - spec.lastHeartbeatOffsetMs),
    runtimePids: spec.runtimePids,
    parentId: spec.parentId,
    childIds: spec.childIds,
    cliVersion: spec.cliVersion,
    approvalMode: spec.approvalMode,
    rolloutPath:
      source === "claude_code"
        ? `/Users/dev/.claude/projects/-Users-dev-workspace-${spec.id}/${spec.id}.jsonl`
        : `/Users/dev/.codex/sessions/2026/07/10/rollout-${spec.id}.jsonl`,
  };
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

  let sessionCostUsd: number | null = null;
  for (const agent of agents) {
    statusCounts[agent.status.kind] += 1;
    if (agent.costUsd !== null) {
      sessionCostUsd = (sessionCostUsd ?? 0) + agent.costUsd;
    }
  }

  return {
    totalAgents: agents.length,
    activeProjects: projects.length,
    statusCounts,
    sessionCostUsd: sessionCostUsd === null ? null : Number(sessionCostUsd.toFixed(2)),
  };
}

function collectProjects(agents: readonly Agent[]): ProjectRef[] {
  const projects: ProjectRef[] = [];
  const seen = new Set<string>();

  for (const agent of agents) {
    if (!seen.has(agent.project.cwd)) {
      seen.add(agent.project.cwd);
      projects.push(agent.project);
    }
  }

  return projects;
}

function toSnapshot(agents: readonly Agent[], now: number): DashboardSnapshot {
  const projects = collectProjects(agents);
  const byId: Record<string, Agent> = {};
  for (const agent of agents) {
    byId[agent.id] = agent;
  }

  return {
    byId,
    allIds: agents.map((agent) => agent.id),
    projects,
    incidents: detectIncidents({ agents, projects, now }),
    summary: buildSummary(agents, projects),
    // Pure function of its inputs — no counter, so the same `now` always yields the same snapshot.
    revision: 1,
    lastSyncedAt: iso(now),
    warnings: [],
  };
}

/** 21 hand-written agents (17 Codex + 4 Claude Code) covering all nine AgentStatusKind values. */
export function buildMockSnapshot(now: number): DashboardSnapshot {
  return toSnapshot(
    fixtureSpecs(now).map((spec) => toAgent(spec, now)),
    now,
  );
}

const BULK_PROJECTS: ProjectRef[] = [
  { cwd: "/tmp/bulk/alpha-service", name: "alpha-service", repoUrl: "git@github.com:acme/alpha-service.git" },
  { cwd: "/tmp/bulk/beta-web", name: "beta-web", repoUrl: "https://github.com/acme/beta-web.git" },
  { cwd: "/tmp/bulk/gamma-worker", name: "gamma-worker", repoUrl: null },
  { cwd: "/tmp/bulk/delta-api", name: "delta-api", repoUrl: "git@github.com:acme/delta-api.git" },
  { cwd: "/tmp/bulk/epsilon-cli", name: "epsilon-cli", repoUrl: null },
  { cwd: "/tmp/bulk/zeta-infra", name: "zeta-infra", repoUrl: "https://github.com/acme/zeta-infra.git" },
];

const BULK_BRANCHES = ["main", "develop", "feat/perf", "fix/flaky-test", "chore/deps", "release/2026.07"];

function bulkStatus(kind: AgentStatusKind, now: number, ageMs: number, idleMs: number): AgentStatus {
  const startedAt = iso(now - ageMs);
  const seenAt = iso(now - idleMs);

  if (kind === "running") {
    return { kind, startedAt, lastHeartbeatAt: seenAt };
  }
  if (kind === "waiting") {
    return { kind, since: seenAt };
  }
  if (kind === "approval_required") {
    return { kind, requestedAt: seenAt, reason: "쓰기 권한이 필요한 명령 승인 대기" };
  }
  if (kind === "blocked") {
    return { kind, blocker: "merge conflict in src/index.ts", since: seenAt };
  }
  if (kind === "failed") {
    return { kind, error: "build failed: tsc exited with code 2", retryCount: 2, failedAt: seenAt };
  }
  if (kind === "completed") {
    return { kind, completedAt: seenAt };
  }
  if (kind === "paused") {
    return { kind, pausedAt: seenAt };
  }
  if (kind === "stale") {
    return { kind, lastHeartbeatAt: seenAt };
  }
  return { kind, lastSeenAt: seenAt };
}

/**
 * Byte-identical for the same (count, seed, now) — every value derives from the seeded PRNG or from
 * `now`, never from Date.now()/Math.random(). Used to stress the table's virtualization.
 */
export function generateBulkSnapshot(count: number, seed: number, now: number): DashboardSnapshot {
  const random = mulberry32(seed);
  const statusKinds = AgentStatusKindSchema.options;
  const agents: Agent[] = [];

  let currentMainId: string | null = null;
  const childIdsByMain = new Map<string, string[]>();

  for (let index = 0; index < count; index += 1) {
    const id = `bulk-${String(index).padStart(6, "0")}`;
    const project = BULK_PROJECTS[index % BULK_PROJECTS.length] ?? BULK_PROJECTS[0];
    const branch = BULK_BRANCHES[Math.floor(random() * BULK_BRANCHES.length)] ?? "main";
    const kind = statusKinds[index % statusKinds.length] ?? "running";

    if (!project) {
      continue;
    }

    const ageMs = Math.floor(random() * 12 * HOUR_MS) + MINUTE_MS;
    const idleMs = Math.floor(random() * ageMs);
    const isMain = index % 6 === 0;

    if (isMain) {
      currentMainId = id;
      childIdsByMain.set(id, []);
    } else if (currentMainId) {
      childIdsByMain.get(currentMainId)?.push(id);
    }

    const parentId = isMain ? null : currentMainId;
    const heartbeatOffsetMs = kind === "offline" && index % 12 === 0 ? null : idleMs;

    agents.push({
      id,
      displayName: `${project.name} 작업 #${index}`,
      /** Every third bulk agent is Claude-Code-sourced so virtualization stress covers both sources. */
      source: index % 3 === 0 ? "claude_code" : "codex",
      role: isMain ? "main" : "subagent",
      project,
      branch: index % 9 === 0 ? null : branch,
      commitSha: index % 9 === 0 ? null : Math.floor(random() * 0xfffffff).toString(16).padStart(40, "0"),
      model: "gpt-5.6-sol",
      reasoningEffort: index % 3 === 0 ? "high" : "medium",
      status: bulkStatus(kind, now, ageMs, idleMs),
      currentTask: `[bulk] ${project.name} 에서 ${branch} 브랜치의 작업 ${index}를 처리하는 중입니다.`,
      tokensUsed: Math.floor(random() * 500_000),
      costUsd: index % 7 === 0 ? Number((random() * 20).toFixed(2)) : null,
      startedAt: iso(now - ageMs),
      updatedAt: iso(now - idleMs),
      lastHeartbeatAt: heartbeatOffsetMs === null ? null : iso(now - heartbeatOffsetMs),
      runtimePids: kind === "running" ? [40_000 + index] : [],
      parentId,
      childIds: [],
      cliVersion: "0.144.1",
      approvalMode: index % 2 === 0 ? "never" : "on-request",
      rolloutPath: `/tmp/bulk/rollouts/${id}.jsonl`,
    });
  }

  const withChildren = agents.map((agent) => ({ ...agent, childIds: childIdsByMain.get(agent.id) ?? [] }));
  return toSnapshot(withChildren, now);
}

/**
 * Simulates results without ever touching child_process — mock mode must never signal a real pid
 * or spawn a real command. retry/approve/reject stay "skipped" to match the domain contract.
 */
function simulateOutcome(action: AgentActionType): Omit<AgentActionResult, "agentId" | "action"> {
  if (action === "retry" || action === "approve" || action === "reject") {
    return { status: "skipped", message: NO_CONTROL_CHANNEL_MESSAGE };
  }

  return { status: "success", message: `모의 어댑터: ${action} 동작을 시뮬레이션했습니다.` };
}

export function createMockAdapter(now: number, snapshot?: DashboardSnapshot): DashboardRepository & AgentCommandRepository {
  const fixture = snapshot ?? buildMockSnapshot(now);

  async function execute(agentId: string, request: AgentActionRequest): Promise<AgentActionResult> {
    if (!fixture.byId[agentId]) {
      return { agentId, action: request.action, status: "skipped", message: "등록되지 않은 에이전트입니다." };
    }

    return { agentId, action: request.action, ...simulateOutcome(request.action) };
  }

  async function executeBulk(agentIds: string[], action: AgentActionType): Promise<AgentActionResult[]> {
    const results: AgentActionResult[] = [];
    for (const agentId of agentIds) {
      results.push(await execute(agentId, { action }));
    }
    return results;
  }

  return {
    getSnapshot: async () => fixture,
    execute,
    executeBulk,
  };
}
