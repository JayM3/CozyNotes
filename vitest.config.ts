import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { preserveSymlinks: true },
  test: {
    pool: "threads",
    maxWorkers: 1,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    restoreMocks: true,
  },
});
