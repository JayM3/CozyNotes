import { resolve } from "node:path";
import { startVitest } from "vitest/node";

// A non-root drive path and preserved mappings avoid Vite's Windows UNC resolution.
const context = await startVitest("test", process.argv.slice(2), {
  root: resolve(process.cwd(), "src"),
  watch: false,
  include: ["**/*.test.ts", "**/*.test.tsx"],
  pool: "threads",
  maxWorkers: 1,
}, { configFile: false, resolve: { preserveSymlinks: true } });
await context?.close();
