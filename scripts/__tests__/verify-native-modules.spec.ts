import { describe, expect, it } from "vitest";

import {
  REQUIRED_NATIVE_MODULES,
  describeBindingLayout,
  discoverNativeModules,
  nativeModulesToVerify,
  verifyNativeModules,
} from "../ops/verify-native-modules.mjs";

const packageRoot = "/octogee/scripts";
const bindingGyp = (name: string) => `${packageRoot}/node_modules/${name}/binding.gyp`;

// node-pty@1.1.0 publishes prebuilds for darwin and win32 only, so on linux the
// binding exists exclusively as node-gyp output. A lockfile entry that declares
// `hasInstallScript` AND ships a binding.gyp is exactly the shape that cannot
// survive a skipped install script.
const lockfile = {
  packages: {
    "": { name: "scripts" },
    "node_modules/node-pty": { version: "1.1.0", hasInstallScript: true },
    "node_modules/esbuild": { version: "0.28.1", hasInstallScript: true },
    "node_modules/protobufjs": { version: "7.6.5", hasInstallScript: true },
    "node_modules/@firebase/util": { version: "1.15.1", hasInstallScript: true },
    "node_modules/ws": { version: "8.21.1" },
  },
};

describe("discoverNativeModules", () => {
  it("finds install-script packages that ship a binding.gyp", () => {
    const found = discoverNativeModules({
      lockfile,
      packageRoot,
      exists: (candidate: string) => candidate === bindingGyp("node-pty"),
    });

    expect(found).toEqual(["node-pty"]);
  });

  it("ignores install-script packages that carry no native binding", () => {
    const found = discoverNativeModules({
      lockfile,
      packageRoot,
      exists: () => false,
    });

    expect(found).toEqual([]);
  });

  it("finds scoped packages under their full name", () => {
    const found = discoverNativeModules({
      lockfile,
      packageRoot,
      exists: (candidate: string) => candidate === bindingGyp("@firebase/util"),
    });

    expect(found).toEqual(["@firebase/util"]);
  });

  it("ignores nested node_modules entries, which no bare-name require resolves", () => {
    const found = discoverNativeModules({
      lockfile: {
        packages: {
          "node_modules/firebase-tools/node_modules/re2": { version: "1.24.1", hasInstallScript: true },
        },
      },
      packageRoot,
      exists: () => true,
    });

    expect(found).toEqual([]);
  });

  // A module the policy denies is never expected to have a binding, so an
  // unbuilt one is the declared outcome rather than a regression. re2 is the
  // live case: a firebase-tools devDependency whose native build the gateway
  // image deliberately skips.
  it("ignores modules whose install script the policy explicitly denies", () => {
    const found = discoverNativeModules({
      lockfile: { packages: { "node_modules/re2": { hasInstallScript: true } } },
      packageRoot,
      exists: () => true,
      policy: { re2: false },
    });

    expect(found).toEqual([]);
  });

  it("keeps modules the policy allows", () => {
    const found = discoverNativeModules({
      lockfile: { packages: { "node_modules/re2": { hasInstallScript: true } } },
      packageRoot,
      exists: () => true,
      policy: { re2: true },
    });

    expect(found).toEqual(["re2"]);
  });

  it("ignores packages absent from disk — pruned devDeps and platform-skipped optionals", () => {
    const found = discoverNativeModules({
      lockfile: {
        packages: {
          "node_modules/fsevents": { version: "2.3.3", hasInstallScript: true, optional: true },
        },
      },
      packageRoot,
      exists: () => false,
    });

    expect(found).toEqual([]);
  });
});

describe("nativeModulesToVerify", () => {
  it("always includes node-pty so a vanished dependency cannot make the check pass vacuously", () => {
    expect(REQUIRED_NATIVE_MODULES).toContain("node-pty");
    expect(
      nativeModulesToVerify({ lockfile: { packages: {} }, packageRoot, exists: () => false }),
    ).toEqual(["node-pty"]);
  });

  it("merges discovered modules with the required floor without duplicating", () => {
    const names = nativeModulesToVerify({
      lockfile: {
        packages: {
          "node_modules/node-pty": { hasInstallScript: true },
          "node_modules/re2": { hasInstallScript: true },
        },
      },
      packageRoot,
      exists: () => true,
    });

    expect(names).toEqual(["node-pty", "re2"]);
  });

  it("still verifies node-pty even if the policy ever denied it", () => {
    const names = nativeModulesToVerify({
      lockfile: { packages: { "node_modules/node-pty": { hasInstallScript: true } } },
      packageRoot,
      exists: () => true,
      policy: { "node-pty": false },
    });

    expect(names).toEqual(["node-pty"]);
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
