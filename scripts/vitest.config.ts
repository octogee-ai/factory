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
    // *.emulator.spec.ts needs a live Firestore emulator — excluded from
    // the default fast run; executed via `npm run test:emulator`
    // (firebase emulators:exec) in its own CI job.
    exclude: [...configDefaults.exclude, "**/*.emulator.spec.ts"],
  },
});
