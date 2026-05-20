import { defineConfig } from "vitest/config";
import path from "node:path";

// Emulator-only run (firebase emulators:exec). Mirrors vitest.config.ts
// but includes ONLY *.emulator.spec.ts (which the default config
// excludes). Keeps the two run modes unambiguous.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  test: {
    include: ["__tests__/**/*.emulator.spec.ts"],
    // Single shared Firestore emulator instance; one spec's
    // recursiveClear must not race another spec's writes.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
