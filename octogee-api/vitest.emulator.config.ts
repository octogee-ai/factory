import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.emulator.spec.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
