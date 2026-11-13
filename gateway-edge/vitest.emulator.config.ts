import { defineConfig } from "vitest/config";
import path from "node:path";

// Emulator-only run (firebase emulators:exec). Mirrors vitest.config.ts
// but includes ONLY *.emulator.spec.ts (which the default config
// excludes). Keeps the two run modes unambiguous — same pattern scripts/
// uses.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  test: {
    include: ["src/**/__tests__/**/*.emulator.spec.ts"],
    setupFiles: ["./src/test-setup/deployment-targets.ts", "./src/test-setup/octogee-entitlements.ts", "./src/test-setup/loopback-listen.ts", "./src/test-setup/public-app-origins.ts", "./src/test-setup/firestore-platform-state.ts", "./src/test-setup/firebase-user-identity.ts"],
    // Each emulator spec calls resetEmulator() in beforeEach, so running
    // them in parallel within one file is fine — but across files we
    // share one emulator, so sequential file execution avoids interference.
    fileParallelism: false,
    // The emulator REST round-trips (delete users / collection sweeps)
    // are a few hundred ms each; bump the per-test budget so realistic
    // setups don't flake.
    testTimeout: 15_000,
  },
});
