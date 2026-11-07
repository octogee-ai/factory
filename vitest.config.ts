import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/__tests__/**/*.spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
