import { defineConfig, configDefaults } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  test: {
    include: ["__tests__/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.emulator.spec.ts"],
    setupFiles: ["./test-setup/loopback-listen.ts"],
    // Operator-tooling specs spawn real subprocesses (kubectl shims, tsx
    // children); 5s fits only an idle machine, and the full parallel suite
    // on a loaded Mac starves them into timeouts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
