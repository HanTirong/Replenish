import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@replenish/domain": path.resolve(__dirname, "packages/domain/src/index.ts"),
      "@replenish/store": path.resolve(__dirname, "packages/store/src/index.ts"),
      "@replenish/agent": path.resolve(__dirname, "packages/agent/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx"],
    testTimeout: 20000,
  },
});
