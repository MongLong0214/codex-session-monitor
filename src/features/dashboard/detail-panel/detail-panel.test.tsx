import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { buildMockSnapshot } from "@/data-access/mock-adapter";
import type { AgentId } from "@/domain/agent/agent";
import type { DashboardSnapshot } from "@/domain/dashboard";
import { dashboardKeys } from "@/lib/query/keys";
import { createQueryClient } from "@/lib/query/query-client";
import { DetailPanel } from "./detail-panel";

vi.mock("@/lib/query/api", () => ({
  fetchDashboardSnapshot: vi.fn(),
  fetchAgentLogs: vi.fn(),
  postAgentAction: vi.fn(),
  postBulkAgentAction: vi.fn(),
}));

import { fetchAgentLogs, fetchDashboardSnapshot, postAgentAction } from "@/lib/query/api";

/** Reuses the project's shared deterministic fixture instead of inventing new test data. */
const NOW_MS = Date.parse("2026-07-10T12:00:00.000Z");
const SNAPSHOT: DashboardSnapshot = buildMockSnapshot(NOW_MS);

/** Codex agent with an observed runtime pid — pause/resume/stop should be enabled. */
const CODEX_AGENT_ID: AgentId = "mock-main-monitor";
/** Claude-Code-sourced agent — runtimePids is always [] for this source, so process-signal
 * actions must render disabled with a reason (see action-availability.ts). */
const CLAUDE_CODE_AGENT_ID: AgentId = "mock-claude-refactor";

function renderPanel(
  agentId: AgentId | null,
  options: { onClose?: () => void; restoreFocusRef?: React.RefObject<HTMLElement | null> } = {},
) {
  const { onClose = vi.fn(), restoreFocusRef } = options;
  const queryClient = createQueryClient();
  queryClient.setQueryData(dashboardKeys.snapshot(), SNAPSHOT);

  const utils = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <DetailPanel agentId={agentId} onClose={onClose} {...(restoreFocusRef ? { restoreFocusRef } : {})} />
      </QueryClientProvider>
    </ThemeProvider>,
  );

  return { ...utils, queryClient, onClose };
}

beforeEach(() => {
  vi.mocked(fetchDashboardSnapshot).mockResolvedValue(SNAPSHOT);
  vi.mocked(fetchAgentLogs).mockResolvedValue({ agentId: CODEX_AGENT_ID, lines: [], isTruncated: false });
  vi.mocked(postAgentAction).mockResolvedValue({
    agentId: CODEX_AGENT_ID,
    action: "view_diff",
    status: "success",
    message: "변경 사항이 없습니다.",
  });
});

describe("DetailPanel open/close", () => {
  it("AC: renders nothing when agentId is null", () => {
    renderPanel(null);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("AC: opening the panel with an agent id shows that agent's name and status", async () => {
    renderPanel(CODEX_AGENT_ID);

    const panel = await screen.findByRole("complementary", { name: "에이전트 상세" });
    expect(panel).toHaveTextContent("Codex Session Monitor 마이그레이션");
    expect(panel).toHaveTextContent("실행 중");
  });

  it("AC: the close button calls onClose", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel(CODEX_AGENT_ID);
    await screen.findByRole("complementary", { name: "에이전트 상세" });

    await user.click(screen.getByRole("button", { name: "상세 패널 닫기" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("AC: the close button restores focus to restoreFocusRef's element when one is supplied", async () => {
    const user = userEvent.setup();

    function Harness() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button">
            상세 보기 트리거
          </button>
          <DetailPanel agentId={CODEX_AGENT_ID} onClose={vi.fn()} restoreFocusRef={triggerRef} />
        </>
      );
    }

    const queryClient = createQueryClient();
    queryClient.setQueryData(dashboardKeys.snapshot(), SNAPSHOT);
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>
      </ThemeProvider>,
    );

    await screen.findByRole("complementary", { name: "에이전트 상세" });
    await user.click(screen.getByRole("button", { name: "상세 패널 닫기" }));

    expect(screen.getByRole("button", { name: "상세 보기 트리거" })).toHaveFocus();
  });

  it("AC: without restoreFocusRef, closing still calls onClose and does not throw", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel(CODEX_AGENT_ID);
    await screen.findByRole("complementary", { name: "에이전트 상세" });

    await user.click(screen.getByRole("button", { name: "상세 패널 닫기" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("AC: pressing Escape closes the panel the same way the close button does", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel(CODEX_AGENT_ID);
    await screen.findByRole("complementary", { name: "에이전트 상세" });

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("DetailPanel loading/empty states", () => {
  it("AC: shows a loading spinner while the agent has not resolved yet", async () => {
    let resolveSnapshot!: (snapshot: DashboardSnapshot) => void;
    vi.mocked(fetchDashboardSnapshot).mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const queryClient = createQueryClient();
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <DetailPanel agentId={CODEX_AGENT_ID} onClose={vi.fn()} />
        </QueryClientProvider>
      </ThemeProvider>,
    );

    expect(await screen.findByLabelText("에이전트를 불러오는 중")).toBeInTheDocument();

    resolveSnapshot(SNAPSHOT);
    await waitFor(() => {
      expect(screen.queryByLabelText("에이전트를 불러오는 중")).not.toBeInTheDocument();
    });
  });

  it("AC: shows an empty state when the agent id is not present in the snapshot", async () => {
    renderPanel("does-not-exist");

    expect(await screen.findByText("에이전트를 찾을 수 없습니다")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "에이전트 상세 탭" })).not.toBeInTheDocument();
  });
});

describe("DetailPanel tab switching", () => {
  it("AC: opens on the 개요 tab by default and switches content when another tab is selected", async () => {
    const user = userEvent.setup();
    renderPanel(CODEX_AGENT_ID);
    await screen.findByRole("complementary", { name: "에이전트 상세" });

    // TabList renders as a <nav> of plain buttons (aria-current, not the ARIA tabs widget).
    const tabs = screen.getByRole("navigation", { name: "에이전트 상세 탭" });
    expect(tabs).toBeInTheDocument();
    // Overview content: the metadata list's 상태 row is only rendered by OverviewTab.
    expect(screen.getByText("마지막 신호")).toBeInTheDocument();

    await user.click(within(tabs).getByRole("button", { name: "로그" }));
    await waitFor(() => {
      expect(screen.getByRole("log", { name: "에이전트 활동 로그" })).toBeInTheDocument();
    });

    await user.click(within(tabs).getByRole("button", { name: "변경 사항" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "새로고침" })).toBeInTheDocument();
    });
    // ChangesTab fires view_diff on mount.
    await waitFor(() => {
      expect(postAgentAction).toHaveBeenCalled();
    });
  });
});

describe("DetailPanel disabled-action reasons", () => {
  it("AC: an agent with an observed runtime pid gets enabled process-signal actions", async () => {
    renderPanel(CODEX_AGENT_ID);
    await screen.findByRole("complementary", { name: "에이전트 상세" });

    expect(screen.getByRole("button", { name: "정지(SIGSTOP)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "재개(SIGCONT)" })).toBeEnabled();
  });

  it("AC: a Claude-Code-sourced agent (never a runtime pid) renders process-signal actions disabled with a reason", async () => {
    renderPanel(CLAUDE_CODE_AGENT_ID);
    await screen.findByRole("complementary", { name: "에이전트 상세" });

    const pauseButton = screen.getByRole("button", { name: "정지(SIGSTOP)" });
    const resumeButton = screen.getByRole("button", { name: "재개(SIGCONT)" });
    // Button uses aria-disabled (not native disabled) so the reason stays reachable via tooltip.
    expect(pauseButton).toHaveAttribute("aria-disabled", "true");
    expect(resumeButton).toHaveAttribute("aria-disabled", "true");

    // stop/pause/resume all share the same reason text (rendered once per tooltip), so assert presence rather than uniqueness.
    expect(screen.getAllByText("작업 디렉터리에서 실행 중인 Codex 프로세스를 찾지 못했습니다.").length).toBeGreaterThan(0);
  });

  it("AC: retry/approve/reject always render disabled with the no-control-channel explanation", async () => {
    renderPanel(CODEX_AGENT_ID);
    await screen.findByRole("complementary", { name: "에이전트 상세" });

    expect(screen.getByRole("button", { name: "재시도" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "승인" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "거부" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/재시도 · 승인 · 거부는 항상 비활성입니다\./)).toBeInTheDocument();
  });
});

describe("DetailPanel stop confirmation", () => {
  it("AC: clicking 중지 opens a confirmation dialog, and Cancel closes it without sending the action", async () => {
    const user = userEvent.setup();
    renderPanel(CODEX_AGENT_ID);
    await screen.findByRole("complementary", { name: "에이전트 상세" });

    await user.click(screen.getByRole("button", { name: "중지" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Codex Session Monitor 마이그레이션 중지");

    await user.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(postAgentAction).not.toHaveBeenCalledWith(CODEX_AGENT_ID, { action: "stop" });
  });
});
