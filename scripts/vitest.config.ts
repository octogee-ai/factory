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
  },
});
