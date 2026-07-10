import { defineConfig, devices } from "@playwright/test";

/** Dedicated port so the e2e run never collides with a developer's own `pnpm dev` on 3000. */
const PORT = 4198;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Points at the project's own `dev` script rather than duplicating its flags; PORT overrides
  // the script's default (3000) without needing a second script just for e2e.
  webServer: {
    command: "pnpm dev",
    url: BASE_URL,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
