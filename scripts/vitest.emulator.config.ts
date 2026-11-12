import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  test: {
    include: ["__tests__/**/*.emulator.spec.ts"],
    setupFiles: ["./test-setup/octogee-entitlements.ts", "./test-setup/loopback-listen.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
    server: { deps: { inline: [/@octogee\/core/] } },
  },
});
