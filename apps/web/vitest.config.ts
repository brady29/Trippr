import { defineConfig } from "vitest/config";

// Unit tests only; Playwright specs live in e2e/ and run with `pnpm test:e2e`.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
