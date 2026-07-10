import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.join(projectRoot, "src"),
    },
  },
  // @astryxdesign/core lazy-loads some components (e.g. Timestamp -> Tooltip) via extensionless
  // dynamic import()s. Left externalized, Node's native ESM resolver rejects those at test time
  // ("Cannot find module"); routing the package through Vite's own resolver instead (which tolerates
  // extensionless specifiers) fixes it.
  ssr: {
    noExternal: ["@astryxdesign/core"],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    css: false,
  },
});
