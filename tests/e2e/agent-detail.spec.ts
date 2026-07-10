import { expect, test } from "@playwright/test";
import { DashboardPage } from "./pages/dashboard-page";

test.describe("Detail panel", () => {
  test("AC: opens on clicking a row's detail button and shows the overview/logs/changes tabs", async ({ page }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    const snapshot = await dashboard.fetchSnapshot();
    const target = Object.values(snapshot.byId)[0];
    test.skip(!target, "No live agents to open a detail panel for.");

    await dashboard.openDetailFor(target!.displayName);

    await expect(dashboard.detailPanel).toContainText(target!.displayName);
    const tabs = dashboard.detailPanel.getByRole("navigation", { name: "에이전트 상세 탭" });
    await expect(tabs.getByRole("button", { name: "개요" })).toBeVisible();
    await expect(tabs.getByRole("button", { name: "로그" })).toBeVisible();
    await expect(tabs.getByRole("button", { name: "변경 사항" })).toBeVisible();

    await tabs.getByRole("button", { name: "로그" }).click();
    await expect(dashboard.detailPanel.getByRole("log", { name: "에이전트 활동 로그" })).toBeVisible();
  });
});

test.describe("Pause/Resume availability", () => {
  test("AC: an agent with a real observed runtime pid gets enabled pause/resume", async ({ page }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    const snapshot = await dashboard.fetchSnapshot();
    const withPid = Object.values(snapshot.byId).find((agent) => agent.runtimePids.length > 0);
    test.skip(!withPid, "No live agent with an observed runtime pid right now.");

    await dashboard.openDetailFor(withPid!.displayName);

    await expect(dashboard.detailPanel.getByRole("button", { name: "정지(SIGSTOP)" })).toBeEnabled();
    await expect(dashboard.detailPanel.getByRole("button", { name: "재개(SIGCONT)" })).toBeEnabled();
  });

  test("AC: a Claude-Code-sourced agent (never a runtime pid) renders pause/resume disabled with a reason", async ({
    page,
  }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    const snapshot = await dashboard.fetchSnapshot();
    const claudeCodeAgent = Object.values(snapshot.byId).find((agent) => agent.source === "claude_code");
    test.skip(!claudeCodeAgent, "No live Claude-Code-sourced agent right now.");

    await dashboard.openDetailFor(claudeCodeAgent!.displayName);

    const pauseButton = dashboard.detailPanel.getByRole("button", { name: "정지(SIGSTOP)" });
    await expect(pauseButton).toBeDisabled();
    await expect(dashboard.detailPanel.getByRole("button", { name: "재개(SIGCONT)" })).toBeDisabled();
    await expect(
      dashboard.detailPanel.getByText("작업 디렉터리에서 실행 중인 Codex 프로세스를 찾지 못했습니다.").first(),
    ).toBeAttached();
  });
});

test.describe("Stop confirmation", () => {
  test("AC: 중지 opens a confirmation dialog, and Cancel closes it without sending SIGTERM to a real process", async ({
    page,
  }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    const snapshot = await dashboard.fetchSnapshot();
    const withPid = Object.values(snapshot.byId).find((agent) => agent.runtimePids.length > 0);
    test.skip(!withPid, "No live agent with an observed runtime pid right now.");

    await dashboard.openDetailFor(withPid!.displayName);
    await dashboard.detailPanel.getByRole("button", { name: "중지" }).click();

    // Scoped to the currently-open <dialog> — other alertdialog instances may exist elsewhere in
    // the tree (e.g. an unrelated feature's own confirmation) but only one has the native `open` attribute.
    const openDialog = page.locator('dialog[role="alertdialog"][open]');
    await expect(openDialog).toBeVisible();
    await expect(openDialog).toContainText(`${withPid!.displayName} 중지`);

    // Deliberately never click the action button here — confirming would send a real SIGTERM to a
    // real running process on this machine, which is destructive and out of scope for a test.
    await openDialog.getByRole("button", { name: "취소" }).click();
    await expect(page.locator('dialog[role="alertdialog"][open]')).toHaveCount(0);
  });
});
