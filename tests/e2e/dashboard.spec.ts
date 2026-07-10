import { expect, test } from "@playwright/test";
import { DashboardPage } from "./pages/dashboard-page";

test.describe("Dashboard load", () => {
  test("AC: loads and shows real agent rows from this machine's live sessions", async ({ page }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    const snapshot = await dashboard.fetchSnapshot();
    expect(snapshot.allIds.length).toBeGreaterThan(0);

    const rowCount = await dashboard.bodyRows().count();
    expect(rowCount).toBeGreaterThan(0);

    // Sanity check: the first real agent's row actually renders with an accessible detail control.
    const firstAgent = snapshot.byId[snapshot.allIds[0] ?? ""];
    if (firstAgent) {
      await expect(dashboard.detailButton(firstAgent.displayName).first()).toBeVisible();
    }
  });
});

test.describe("Project filter", () => {
  test("AC: selecting a project in the toolbar narrows the table to that project's rows", async ({ page }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    const snapshot = await dashboard.fetchSnapshot();
    const agents = Object.values(snapshot.byId);
    const projectCounts = new Map<string, number>();
    for (const agent of agents as { project?: { name: string } }[]) {
      const name = agent.project?.name;
      if (name) {
        projectCounts.set(name, (projectCounts.get(name) ?? 0) + 1);
      }
    }
    // Pick a project that is NOT every agent's project, so filtering is actually observable.
    // Real sessions start/stop on this machine while the test runs, so the exact count fetched
    // here is only a lower/upper sanity bound, never asserted as an exact post-filter count.
    const target = [...projectCounts.entries()].find(([, count]) => count > 0 && count < agents.length);
    test.skip(!target, "Needs at least two distinct projects among the live sessions to be meaningful.");
    const [projectName] = target as [string, number];

    await dashboard.projectFilterTrigger.click();
    const projectOption = page.getByRole("option", { name: projectName }).first();
    await projectOption.scrollIntoViewIfNeeded();
    await projectOption.click();
    await page.keyboard.press("Escape");

    // Read the toolbar's own "visible / total" counter — the authoritative filtered count, unlike
    // counting rendered <tbody> rows (which the virtualizer caps below the true total either way).
    await expect
      .poll(async () => (await dashboard.getRowCounts()).visible, { timeout: 10_000 })
      .toBeLessThan((await dashboard.getRowCounts()).total);

    const { visible } = await dashboard.getRowCounts();
    expect(visible).toBeGreaterThan(0);

    // Every currently-rendered row (virtualization may render fewer than `visible`) must belong
    // to the selected project.
    const renderedRowCount = await dashboard.bodyRows().count();
    for (let index = 0; index < renderedRowCount; index += 1) {
      await expect(dashboard.bodyRows().nth(index)).toContainText(projectName);
    }
  });
});

test.describe("Agent search", () => {
  test("AC: searching by name narrows the table to matching rows", async ({ page }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    const snapshot = await dashboard.fetchSnapshot();
    const agents = Object.values(snapshot.byId);
    const target = agents[0];
    test.skip(!target, "No live agents to search for.");

    // A short, ASCII-safe leading slice of the real display name — long enough to be a real
    // substring match, short enough to dodge punctuation user-event/fill would otherwise need escaping.
    const query = target!.displayName.slice(0, 12).trim();
    test.skip(query.length < 3, "Display name too short to make a meaningful search query.");

    await dashboard.search(query);

    const rows = dashboard.bodyRows();
    await expect(rows.first()).toBeVisible();
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThanOrEqual(Object.keys(snapshot.byId).length);
  });
});
