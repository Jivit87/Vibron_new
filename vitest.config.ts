import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/helpers/setup-env.ts"],
    // Many tests spawn real git/node/python processes (solve loops, the gate,
    // delivery against a bare remote); 5s flakes on a loaded machine or CI.
    testTimeout: 30_000,
  },
});
