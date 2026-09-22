import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    env: { K8S_NAMESPACE: "octogee-test" },
    include: ["src/__tests__/**/*.emulator.spec.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
