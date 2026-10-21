import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["shared/**/*.test.ts", "apps/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: "node",
  },
});
