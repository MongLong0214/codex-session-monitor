import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { buildMockSnapshot } from "@/data-access/mock-adapter";
import type { AgentId } from "@/domain/agent/agent";
import type { DashboardSnapshot } from "@/domain/dashboard";
import { dashboardKeys } from "@/lib/query/keys";
import { createQueryClient } from "@/lib/query/query-client";
import { OperationsTable } from "./operations-table";
import { useAgentTableState } from "./use-table-state";

vi.mock("@/lib/query/api", () => ({
  fetchDashboardSnapshot: vi.fn(),
  fetchAgentLogs: vi.fn(),
  postAgentAction: vi.fn(),
  postBulkAgentAction: vi.fn(),
}));

import { fetchDashboardSnapshot, postBulkAgentAction } from "@/lib/query/api";

/** Reuses the project's shared deterministic fixture (21 hand-written agents) instead of inventing new test data. */
const NOW_MS = Date.parse("2026-07-10T12:00:00.000Z");
const SNAPSHOT: DashboardSnapshot = buildMockSnapshot(NOW_MS);

function agentIdByDisplayName(displayName: string): AgentId {
  const found = Object.values(SNAPSHOT.byId).find((agent) => agent.displayName === displayName);
  if (!found) {
    throw new Error(`fixture agent not found: ${displayName}`);
  }
  return found.id;
}

/** `tableState` is owned by DashboardRoot in production (so the command palette can share it); a
 * thin harness stands in for that owner here, using the real hook with its no-persistence defaults. */
function TableHarness({ onOpenDetail }: { onOpenDetail: (agentId: AgentId) => void }) {
  const tableState = useAgentTableState();
  return <OperationsTable tableState={tableState} onOpenDetail={onOpenDetail} />;
}

function renderTable(onOpenDetail: (agentId: AgentId) => void = vi.fn()) {
  const queryClient = createQueryClient();
  queryClient.setQueryData(dashboardKeys.snapshot(), SNAPSHOT);

  const utils = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TableHarness onOpenDetail={onOpenDetail} />
      </QueryClientProvider>
    </ThemeProvider>,
  );

  return { ...utils, queryClient };
}

beforeEach(() => {
  vi.mocked(fetchDashboardSnapshot).mockResolvedValue(SNAPSHOT);
});

describe("OperationsTable search/filter", () => {
  it("AC: typing in the search box narrows visible rows to matches and updates the visible/total counter", async () => {
    const user = userEvent.setup();
    renderTable();

    const searchInput = await screen.findByRole("textbox", { name: "에이전트 검색" });
    // ASCII substring unique to mock-pr-flavored's currentTask — avoids IME concerns with Korean typing.
    await user.type(searchInput, "pull/128");

    // The 200ms search debounce means the filter lands after typing; wait for the toolbar's own
    // "N / total" counter (proof the debounced filter has actually applied) before asserting on
    // row presence/absence, rather than racing an unrelated row that happens to render regardless.
    await waitFor(() => {
      expect(screen.getByText(`1 / ${SNAPSHOT.allIds.length}개`)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "PR 리뷰 대기 상세 보기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "인증 토큰 회전 상세 보기" })).not.toBeInTheDocument();
  });

  it("AC: selecting a status in the toolbar's 상태 filter narrows rows the same way a status-counter click would", async () => {
    const user = userEvent.setup();
    renderTable();

    await screen.findByRole("table", { name: "에이전트 운영 테이블" });

    const statusTrigger = screen.getByRole("combobox", { name: "상태" });
    await user.click(statusTrigger);
    const listbox = document.getElementById(statusTrigger.getAttribute("aria-controls") ?? "");
    if (!listbox) {
      throw new Error("상태 listbox not found");
    }
    await user.click(within(listbox).getByRole("option", { name: "실패", hidden: true }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "다이제스트 렌더러 상세 보기" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "PR 리뷰 대기 상세 보기" })).not.toBeInTheDocument();
    expect(screen.getByText(`1 / ${SNAPSHOT.allIds.length}개`)).toBeInTheDocument();
  });
});

describe("OperationsTable column visibility", () => {
  it("AC: toggling a column off in 열 표시 hides it, toggling it back on restores it", async () => {
    const user = userEvent.setup();
    renderTable();

    await screen.findByRole("table", { name: "에이전트 운영 테이블" });
    expect(screen.getByRole("columnheader", { name: "현재 작업" })).toBeInTheDocument();

    const columnsTrigger = screen.getByRole("combobox", { name: "열 표시" });
    await user.click(columnsTrigger);
    const listbox = document.getElementById(columnsTrigger.getAttribute("aria-controls") ?? "");
    if (!listbox) {
      throw new Error("열 표시 listbox not found");
    }
    await user.click(within(listbox).getByRole("option", { name: "현재 작업", hidden: true }));

    await waitFor(() => {
      expect(screen.queryByRole("columnheader", { name: "현재 작업" })).not.toBeInTheDocument();
    });

    await user.click(columnsTrigger);
    await user.click(within(listbox).getByRole("option", { name: "현재 작업", hidden: true }));

    await waitFor(() => {
      expect(screen.getByRole("columnheader", { name: "현재 작업" })).toBeInTheDocument();
    });
  });
});

describe("OperationsTable row density", () => {
  it("AC: toggling density between 조밀/여유 actually changes the rendered row height", async () => {
    const user = userEvent.setup();
    const { container } = renderTable();

    const table = await waitFor(() => {
      const el = container.querySelector("table");
      if (!el) {
        throw new Error("table not rendered yet");
      }
      return el;
    });

    // useAgentTableState defaults density to DEFAULT_DASHBOARD_SETTINGS.rowDensity ("compact" -> 34px).
    expect(table.style.getPropertyValue("--row-height")).toBe("34px");

    await user.click(screen.getByRole("radio", { name: "여유" }));
    await waitFor(() => expect(table.style.getPropertyValue("--row-height")).toBe("40px"));

    await user.click(screen.getByRole("radio", { name: "조밀" }));
    await waitFor(() => expect(table.style.getPropertyValue("--row-height")).toBe("34px"));
  });
});

describe("OperationsTable bulk selection", () => {
  it("AC: checking a row's checkbox selects it and shows the bulk action bar only while a selection exists", async () => {
    const user = userEvent.setup();
    renderTable();

    await screen.findByRole("table", { name: "에이전트 운영 테이블" });
    expect(screen.queryByRole("region", { name: "선택한 에이전트 일괄 작업" })).not.toBeInTheDocument();

    const rowCheckbox = screen.getByRole("checkbox", { name: "Codex Session Monitor 마이그레이션 선택" });
    await user.click(rowCheckbox);

    expect(screen.getByRole("region", { name: "선택한 에이전트 일괄 작업" })).toBeInTheDocument();
    expect(screen.getByText("1개 선택됨")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "선택 해제" }));
    expect(screen.queryByRole("region", { name: "선택한 에이전트 일괄 작업" })).not.toBeInTheDocument();
  });

  it("AC: a bulk action reports the success/failed/skipped breakdown from the response", async () => {
    const user = userEvent.setup();
    const monitorId = agentIdByDisplayName("Codex Session Monitor 마이그레이션");
    vi.mocked(postBulkAgentAction).mockResolvedValue({
      results: [{ agentId: monitorId, action: "pause", status: "success", message: "모의: 일시정지 완료" }],
    });

    renderTable();
    await screen.findByRole("table", { name: "에이전트 운영 테이블" });

    await user.click(screen.getByRole("checkbox", { name: "Codex Session Monitor 마이그레이션 선택" }));
    // Scoped to the bulk action bar: a running row's own quick-action cell also renders a
    // same-labelled "일시정지" button, so an unscoped query would be ambiguous.
    const bulkBar = screen.getByRole("region", { name: "선택한 에이전트 일괄 작업" });
    await user.click(within(bulkBar).getByRole("button", { name: "일시정지" }));

    expect(await screen.findByText("1건 성공 · 0건 실패 · 0건 건너뜀")).toBeInTheDocument();
    // react-query's mutationFn also receives a context object as a 2nd arg — only the request body is ours to assert.
    expect(vi.mocked(postBulkAgentAction).mock.calls[0]?.[0]).toEqual({ agentIds: [monitorId], action: "pause" });
  });
});

describe("OperationsTable keyboard navigation", () => {
  it("AC: ArrowDown moves roving focus to the next row, and Enter on the focused row opens its detail panel", async () => {
    const user = userEvent.setup();
    const onOpenDetail = vi.fn();
    // Narrow to exactly two rows (실패 + 차단됨) so ArrowDown from row 0 deterministically lands on row 1
    // regardless of the default sort order, without hard-coding which status sorts first.
    const failedId = agentIdByDisplayName("다이제스트 렌더러");
    const blockedId = agentIdByDisplayName("리베이스 충돌 해결");

    const { container } = renderTable(onOpenDetail);
    await screen.findByRole("table", { name: "에이전트 운영 테이블" });

    const statusTrigger = screen.getByRole("combobox", { name: "상태" });
    await user.click(statusTrigger);
    const listbox = document.getElementById(statusTrigger.getAttribute("aria-controls") ?? "");
    if (!listbox) {
      throw new Error("상태 listbox not found");
    }
    await user.click(within(listbox).getByRole("option", { name: "실패", hidden: true }));
    await user.click(within(listbox).getByRole("option", { name: "차단됨", hidden: true }));
    await user.keyboard("{Escape}");

    const rows = await waitFor(() => {
      const found = container.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-index]");
      if (found.length !== 2) {
        throw new Error(`expected 2 filtered rows, found ${found.length}`);
      }
      return [...found];
    });
    const [firstRow, secondRow] = rows;
    if (!firstRow || !secondRow) {
      throw new Error("expected two rows");
    }

    firstRow.focus();
    expect(firstRow).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(secondRow).toHaveFocus());

    await user.keyboard("{Enter}");

    const secondRowId = within(secondRow).getByRole("button", { name: /상세 보기$/ }).getAttribute("aria-label") ===
      "다이제스트 렌더러 상세 보기"
      ? failedId
      : blockedId;
    expect(onOpenDetail).toHaveBeenCalledExactlyOnceWith(secondRowId);
  });
});
