import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: projectRoot,
  },
  // React Compiler is enabled once baseline typecheck/lint/test/build pass clean (see task tracker).
  // experimental: { reactCompiler: true },
};

export default nextConfig;
