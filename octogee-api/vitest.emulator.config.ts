import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.emulator.spec.ts"],
    setupFiles: ["./src/test-setup/deployment-targets.ts", "./src/test-setup/octogee-entitlements.ts", "./src/test-setup/loopback-listen.ts", "./src/test-setup/runtime-env.ts", "./src/test-setup/platform-state-reset.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
