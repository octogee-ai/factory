import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test-setup/loopback-listen.ts"],
    include: ["src/**/*.spec.ts"],
    exclude: ["src/__tests__/**/*.emulator.spec.ts"],
  },
});
