import { expect, test } from "@playwright/test";
import { DashboardPage } from "./pages/dashboard-page";

const VIEWPORT_WIDTHS = [1280, 1440, 1920];

test.describe("Responsive layout", () => {
  for (const width of VIEWPORT_WIDTHS) {
    test(`AC: the dashboard renders without horizontal overflow at ${width}px wide`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const dashboard = new DashboardPage(page);
      await dashboard.goto();

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
      });

      // A few px of tolerance for scrollbar gutters/sub-pixel rounding across engines.
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 4);
      await expect(dashboard.table).toBeVisible();
    });
  }
});

test.describe("Light/Dark rendering", () => {
  /**
   * No persisted-settings/theme-control UI has landed yet (that work is in-flight in a parallel
   * task) — `ThemeProvider` defaults to `mode="system"`, so `prefers-color-scheme` is the only
   * lever available today. Verified directly against the real computed style (not assumed) below.
   */
  test("AC: dark color-scheme emulation actually renders a dark surface, light renders a light one", async ({
    page,
  }) => {
    const dashboard = new DashboardPage(page);

    await page.emulateMedia({ colorScheme: "dark" });
    await dashboard.goto();
    const darkBg = await page.evaluate(
      () => getComputedStyle(document.querySelector(".astryx-app-shell") as Element).backgroundColor,
    );

    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(200);
    const lightBg = await page.evaluate(
      () => getComputedStyle(document.querySelector(".astryx-app-shell") as Element).backgroundColor,
    );

    expect(darkBg).not.toBe(lightBg);
    // Sanity bound: dark should be a low-luminance color, light a high-luminance one.
    const [, dr, dg, db] = darkBg.match(/rgba?\((\d+), (\d+), (\d+)/) ?? [];
    const [, lr, lg, lb] = lightBg.match(/rgba?\((\d+), (\d+), (\d+)/) ?? [];
    if (dr && dg && db && lr && lg && lb) {
      expect(Number(dr) + Number(dg) + Number(db)).toBeLessThan(Number(lr) + Number(lg) + Number(lb));
    }
  });
});
