import { expect, test } from "@playwright/test";
import { DashboardPage } from "./pages/dashboard-page";

test.describe("Table keyboard navigation", () => {
  test("AC: ArrowDown moves roving focus to the next row, and Enter on the focused row opens its detail panel", async ({
    page,
  }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    const rows = dashboard.bodyRows();
    const rowCount = await rows.count();
    test.skip(rowCount < 2, "Needs at least two live rows to exercise ArrowDown.");

    const firstRow = rows.nth(0);
    await firstRow.focus();
    await expect(firstRow).toBeFocused();

    await page.keyboard.press("ArrowDown");

    const secondRow = rows.nth(1);
    await expect(secondRow).toBeFocused();

    const detailButton = secondRow.getByRole("button", { name: /상세 보기$/ });
    const expectedName = (await detailButton.getAttribute("aria-label"))?.replace(/ 상세 보기$/, "");

    await page.keyboard.press("Enter");

    await expect(dashboard.detailPanel).toBeVisible();
    if (expectedName) {
      await expect(dashboard.detailPanel).toContainText(expectedName);
    }
  });

  test("AC: ArrowUp moves focus back to the previous row", async ({ page }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    const rows = dashboard.bodyRows();
    const rowCount = await rows.count();
    test.skip(rowCount < 2, "Needs at least two live rows to exercise ArrowUp.");

    const firstRow = rows.nth(0);
    const secondRow = rows.nth(1);
    await firstRow.focus();
    await page.keyboard.press("ArrowDown");
    await expect(secondRow).toBeFocused();

    await page.keyboard.press("ArrowUp");
    await expect(firstRow).toBeFocused();
  });
});
