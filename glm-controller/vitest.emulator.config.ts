import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  resolve: { dedupe: ["firebase-admin", "@google-cloud/firestore"] },
  test: {
    env: { K8S_NAMESPACE: "octogee-test" },
    setupFiles: ["./src/test-setup/public-app-origins.ts"],
    server: { deps: { inline: [/@octogee\/core/] } },
    include: ["src/__tests__/**/*.emulator.spec.ts", "integration-tests/**/*.emulator.spec.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
