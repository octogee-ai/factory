import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["src/**/*.emulator.spec.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
