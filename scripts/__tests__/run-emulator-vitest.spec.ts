import { describe, expect, it } from "vitest";
import * as path from "node:path";

import {
  buildFirebaseEmulatorsExecArgs,
  buildInnerVitestCommand,
  parseRunEmulatorVitestArgs,
  resolvePackageToolPaths,
  shellQuote,
} from "../ops/run-emulator-vitest.mjs";

describe("run-emulator-vitest", () => {
  it("builds an inner command that uses the current Node executable and forwards a single spec", () => {
    const command = buildInnerVitestCommand({
      nodePath: "/opt/homebrew/bin/node",
      vitestPath: "/repo/gateway-edge/node_modules/vitest/vitest.mjs",
      config: "vitest.emulator.config.ts",
      env: { GCLOUD_PROJECT: "firebase-test" },
      vitestArgs: ["src/__tests__/preview-discovery.emulator.spec.ts"],
    });

    expect(command).toBe(
      "GCLOUD_PROJECT='firebase-test' '/opt/homebrew/bin/node' '/repo/gateway-edge/node_modules/vitest/vitest.mjs' run --config 'vitest.emulator.config.ts' 'src/__tests__/preview-discovery.emulator.spec.ts'",
    );
  });

  it("parses wrapper flags and leaves remaining arguments for Vitest", () => {
    const parsed = parseRunEmulatorVitestArgs([
      "--only",
      "firestore,auth",
      "--project",
      "firebase-test",
      "--firebase-config",
      "../firebase.json",
      "--config",
      "vitest.emulator.config.ts",
      "--env",
      "GCLOUD_PROJECT=firebase-test",
      "--",
      "src/__tests__/one.emulator.spec.ts",
      "-t",
      "returns preview",
    ]);

    expect(parsed).toEqual({
      only: "firestore,auth",
      project: "firebase-test",
      firebaseConfig: "../firebase.json",
      config: "vitest.emulator.config.ts",
      env: { GCLOUD_PROJECT: "firebase-test" },
      vitestArgs: ["src/__tests__/one.emulator.spec.ts", "-t", "returns preview"],
    });
  });

  it("builds Firebase emulator args with optional Firebase config", () => {
    const args = buildFirebaseEmulatorsExecArgs({
      firebaseCliPath: "/repo/functions/node_modules/firebase-tools/lib/bin/firebase.js",
      only: "firestore,auth,functions",
      project: "firebase-test",
      firebaseConfig: "../firebase.json",
      innerCommand: "node vitest.mjs run",
    });

    expect(args).toEqual([
      "/repo/functions/node_modules/firebase-tools/lib/bin/firebase.js",
      "emulators:exec",
      "--only",
      "firestore,auth,functions",
      "--project",
      "firebase-test",
      "--config",
      "../firebase.json",
      "node vitest.mjs run",
    ]);
  });

  it("quotes shell arguments without losing embedded single quotes", () => {
    expect(shellQuote("a'b c")).toBe("'a'\"'\"'b c'");
  });

  it("resolves package-local firebase and vitest entrypoints", () => {
    const cwd = path.resolve("..", "gateway-edge");
    const paths = resolvePackageToolPaths(cwd);

    expect(paths.firebaseCliPath).toBe(path.join(cwd, "node_modules/firebase-tools/lib/bin/firebase.js"));
    expect(paths.vitestPath).toBe(path.join(cwd, "node_modules/vitest/vitest.mjs"));
  });
});
