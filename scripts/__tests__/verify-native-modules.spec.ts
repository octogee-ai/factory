import { describe, expect, it } from "vitest";

import {
  NATIVE_MODULES,
  describeBindingLayout,
  verifyNativeModules,
} from "../ops/verify-native-modules.mjs";

const packageRoot = "/octogee/scripts";

// The list is explicit rather than derived. Every cheap heuristic for "is this
// package native" is wrong in both directions in this very tree: fsevents is
// native but ships neither binding.gyp nor prebuilds/ (just a loose
// fsevents.node), while bare-fs/bare-os/bare-url do ship prebuilds/ and each
// throws when required under Node ("Bare is not defined" for bare-fs and
// bare-url, "require.addon is not a function" for bare-os) — auto-requiring
// those would fail the image build for packages never meant to load here.
// Detecting a NEW native dependency is npm's job, and npm already does it
// properly (lockfile hasInstallScript plus its own isNodeGypPackage probe)
// behind strict-allow-scripts.
describe("NATIVE_MODULES", () => {
  it("names node-pty, the only native module in the runtime tree", () => {
    expect(NATIVE_MODULES).toEqual(["node-pty"]);
  });
});

describe("verifyNativeModules", () => {
  it("reports no failures when every module loads", () => {
    const loaded: string[] = [];
    const failures = verifyNativeModules({
      names: ["node-pty"],
      load: (name: string) => {
        loaded.push(name);
        return {};
      },
    });

    expect(loaded).toEqual(["node-pty"]);
    expect(failures).toEqual([]);
  });

  it("names the failing module and keeps the loader error message", () => {
    const failures = verifyNativeModules({
      names: ["node-pty"],
      load: () => {
        throw new Error("Failed to load native module: pty.node");
      },
    });

    expect(failures).toEqual([
      { name: "node-pty", message: "Failed to load native module: pty.node" },
    ]);
  });

  it("checks every module even after one fails", () => {
    const failures = verifyNativeModules({
      names: ["node-pty", "re2"],
      load: (name: string) => {
        throw new Error(`broken ${name}`);
      },
    });

    expect(failures.map((failure) => failure.name)).toEqual(["node-pty", "re2"]);
  });

  it("treats a module that resolves to nothing as a failure", () => {
    const failures = verifyNativeModules({ names: ["node-pty"], load: () => undefined });

    expect(failures).toEqual([{ name: "node-pty", message: "module resolved to nothing" }]);
  });
});

describe("describeBindingLayout", () => {
  it("reports the missing platform prebuild and the absent node-gyp output", () => {
    const layout = describeBindingLayout({
      packageRoot,
      name: "node-pty",
      platform: "linux",
      arch: "x64",
      exists: (candidate: string) => candidate === `${packageRoot}/node_modules/node-pty/prebuilds`,
      readdir: () => ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"],
    });

    expect(layout).toContain("prebuilds/linux-x64 missing");
    expect(layout).toContain("darwin-arm64");
    expect(layout).toContain("build/Release missing");
  });

  it("reports a present node-gyp build", () => {
    const layout = describeBindingLayout({
      packageRoot,
      name: "node-pty",
      platform: "linux",
      arch: "x64",
      exists: (candidate: string) =>
        candidate === `${packageRoot}/node_modules/node-pty/build/Release`,
      readdir: () => [],
    });

    expect(layout).toContain("build/Release present");
  });
});
