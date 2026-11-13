import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  discoverLocalFileDeps,
  fileDepInstallArgs,
  fileDepLockOnlyArgs,
  inspectLocalFileDep,
  stageOverlayDependencies,
  syncLocalFileDeps,
} from "../ops/sync-local-file-deps.mjs";

const fixtures: string[] = [];
const NPM_BIN = "npm";

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-directory-deps-"));
  fixtures.push(root);
  return root;
}

function writePackage(
  root: string,
  dirname: string,
  packageName: string,
  dist = "export const value = 1;\n",
): string {
  const packageDir = path.join(root, dirname);
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
      type: "module",
      files: ["dist"],
      exports: "./dist/index.js",
    }, null, 2),
  );
  fs.writeFileSync(path.join(packageDir, "dist", "index.js"), dist);
  return packageDir;
}

function writeConsumer(root: string, spec = "file:../source"): string {
  const consumerDir = path.join(root, "consumer");
  fs.mkdirSync(consumerDir);
  fs.writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({
      name: "consumer",
      version: "1.0.0",
      private: true,
      dependencies: { "@octogee/source": spec },
    }, null, 2),
  );
  fs.writeFileSync(path.join(consumerDir, ".npmrc"), "install-links=true\n");
  fs.writeFileSync(
    path.join(consumerDir, "package-lock.json"),
    JSON.stringify({
      name: "consumer",
      lockfileVersion: 3,
      packages: {
        "": { name: "consumer", dependencies: { "@octogee/source": spec } },
        "node_modules/@octogee/source": {
          version: "1.0.0",
          resolved: spec,
        },
      },
    }, null, 2),
  );
  return consumerDir;
}

function copySourceToInstalled(sourceDir: string, consumerDir: string): void {
  const destination = path.join(consumerDir, "node_modules", "@octogee", "source");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(sourceDir, destination, { recursive: true });
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("directory local file dependencies", () => {
  it("discovers consumers at the repository root and under platform/ when none are named", () => {
    const root = fixture();
    const sourceDir = writePackage(root, "source", "@octogee/source");
    writeConsumer(root);
    const platformConsumer = path.join(root, "platform", "controller");
    fs.mkdirSync(platformConsumer, { recursive: true });
    writeJson(path.join(platformConsumer, "package.json"), {
      name: "controller", version: "1.0.0", private: true, dependencies: { "@octogee/source": "file:../../source" },
    });

    expect(discoverLocalFileDeps({ rootDir: root }).map(({ consumerDir, sourceDir: from }) => [path.relative(root, consumerDir), from]).sort())
      .toEqual([["consumer", sourceDir], ["platform/controller", sourceDir]]);
  });

  it("discovers a directory spec once and detects stale installed package output", () => {
    const root = fixture();
    const sourceDir = writePackage(root, "source", "@octogee/source");
    const consumerDir = writeConsumer(root);
    copySourceToInstalled(sourceDir, consumerDir);
    fs.writeFileSync(
      path.join(consumerDir, "node_modules", "@octogee", "source", "dist", "index.js"),
      "export const value = 0;\n",
    );

    const [dep] = discoverLocalFileDeps({ rootDir: root, consumerDirs: [consumerDir] });

    expect(dep).toMatchObject({
      consumerDir,
      packageName: "@octogee/source",
      spec: "file:../source",
      sourceDir,
    });
    expect(inspectLocalFileDep(dep).staleReasons).toEqual(["installed-dist"]);
  });

  it("refreshes a stale directory dependency without changing its lockfile", () => {
    const root = fixture();
    const sourceDir = writePackage(root, "source", "@octogee/source");
    const consumerDir = writeConsumer(root);
    const lockBefore = fs.readFileSync(path.join(consumerDir, "package-lock.json"), "utf8");
    const installs: Array<{ specs: string[]; preserveLock: boolean }> = [];

    const result = syncLocalFileDeps({
      rootDir: root,
      consumerDirs: [consumerDir],
      installConsumerDepsFn: (dir, specs, preserveLock) => {
        installs.push({ specs, preserveLock });
        copySourceToInstalled(sourceDir, dir);
      },
      stdio: "ignore",
    });

    expect(result).toEqual({ staleCount: 1, syncedConsumers: [consumerDir] });
    expect(installs).toEqual([{
      specs: ["@octogee/source@file:../source"],
      preserveLock: true,
    }]);
    expect(fs.readFileSync(path.join(consumerDir, "package-lock.json"), "utf8")).toBe(lockBefore);
  });

  it("detects producer package metadata drift in the consumer lock", () => {
    const root = fixture();
    const sourceDir = writePackage(root, "source", "@octogee/source");
    const consumerDir = writeConsumer(root);
    copySourceToInstalled(sourceDir, consumerDir);
    const sourcePackagePath = path.join(sourceDir, "package.json");
    const sourcePackage = readJson(sourcePackagePath);
    sourcePackage.dependencies = { "@fixture/runtime": "file:../runtime" };
    writeJson(sourcePackagePath, sourcePackage);
    writeJson(
      path.join(consumerDir, "node_modules", "@octogee", "source", "package.json"),
      sourcePackage,
    );
    const [dep] = discoverLocalFileDeps({ rootDir: root, consumerDirs: [consumerDir] });

    expect(inspectLocalFileDep(dep).staleReasons).toEqual([
      "package-lock.json:dependencies",
    ]);
  });

  it("installs transitive runtime directory dependencies in the producer refresh transaction", () => {
    const root = fixture();
    const sourceDir = writePackage(root, "source", "@octogee/source");
    writePackage(root, "runtime", "@fixture/runtime");
    const sourcePackagePath = path.join(sourceDir, "package.json");
    const sourcePackage = readJson(sourcePackagePath);
    sourcePackage.dependencies = { "@fixture/runtime": "file:../runtime" };
    writeJson(sourcePackagePath, sourcePackage);
    const consumerDir = writeConsumer(root);
    const installs: Array<{ specs: string[]; preserveLock: boolean }> = [];

    syncLocalFileDeps({
      rootDir: root,
      consumerDirs: [consumerDir],
      installConsumerDepsFn: (_dir, specs, preserveLock) => {
        installs.push({ specs, preserveLock });
        copySourceToInstalled(sourceDir, consumerDir);
        writeJson(path.join(consumerDir, "package-lock.json"), {
          name: "consumer",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "consumer",
              dependencies: { "@octogee/source": "file:../source" },
            },
            "node_modules/@octogee/source": {
              version: "1.0.0",
              resolved: "file:../source",
              dependencies: { "@fixture/runtime": "file:../runtime" },
            },
          },
        });
      },
      stdio: "ignore",
    });

    expect(installs).toEqual([{
      specs: [
        "@fixture/runtime@file:../runtime",
        "@octogee/source@file:../source",
      ],
      preserveLock: false,
    }]);
  });

  it("accepts a current installed directory dependency", () => {
    const root = fixture();
    const sourceDir = writePackage(root, "source", "@octogee/source");
    const consumerDir = writeConsumer(root);
    copySourceToInstalled(sourceDir, consumerDir);
    const [dep] = discoverLocalFileDeps({ rootDir: root, consumerDirs: [consumerDir] });

    expect(inspectLocalFileDep(dep).staleReasons).toEqual([]);
    expect(syncLocalFileDeps({ rootDir: root, consumerDirs: [consumerDir] })).toEqual({
      staleCount: 0,
      syncedConsumers: [],
    });
  });

  it("preserves the lock when npm refresh fails", () => {
    const root = fixture();
    writePackage(root, "source", "@octogee/source");
    const consumerDir = writeConsumer(root);
    const lockBefore = fs.readFileSync(path.join(consumerDir, "package-lock.json"), "utf8");

    expect(() => syncLocalFileDeps({
      rootDir: root,
      consumerDirs: [consumerDir],
      installConsumerDepsFn: () => {
        throw new Error("npm refresh failed");
      },
      stdio: "ignore",
    })).toThrow("npm refresh failed");
    expect(fs.readFileSync(path.join(consumerDir, "package-lock.json"), "utf8")).toBe(lockBefore);
  });

  it("rejects a directory refresh that mutates the lockfile", () => {
    const root = fixture();
    writePackage(root, "source", "@octogee/source");
    const consumerDir = writeConsumer(root);

    expect(() => syncLocalFileDeps({
      rootDir: root,
      consumerDirs: [consumerDir],
      installConsumerDepsFn: (dir) => {
        fs.appendFileSync(path.join(dir, "package-lock.json"), "\n");
      },
      stdio: "ignore",
    })).toThrow("directory refresh changed consumer/package-lock.json");
  });

  it("npm ci installs a packed directory instead of a symlink and keeps the lock stable across dist output", () => {
    const root = fixture();
    const sourceDir = writePackage(root, "source", "@octogee/source");
    const consumerDir = writeConsumer(root);

    execFileSync(NPM_BIN, [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ], {
      cwd: consumerDir,
      stdio: "pipe",
    });
    const lockBefore = fs.readFileSync(path.join(consumerDir, "package-lock.json"), "utf8");
    execFileSync(NPM_BIN, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: consumerDir,
      stdio: "pipe",
    });

    const installed = path.join(consumerDir, "node_modules", "@octogee", "source");
    expect(fs.lstatSync(installed).isSymbolicLink()).toBe(false);
    fs.writeFileSync(path.join(sourceDir, "dist", "index.js"), "export const value = 2;\n");
    execFileSync(NPM_BIN, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: consumerDir,
      stdio: "pipe",
    });

    expect(fs.readFileSync(path.join(installed, "dist", "index.js"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    expect(fs.readFileSync(path.join(consumerDir, "package-lock.json"), "utf8")).toBe(lockBefore);
  }, 30_000);

  it("refreshes producer metadata while preserving every consumer dependency section pin", () => {
    const root = fixture();
    const sourceDir = writePackage(root, "source", "@octogee/source");
    const consumerDir = path.join(root, "consumer");
    fs.mkdirSync(consumerDir);
    writeJson(path.join(consumerDir, "package.json"), {
      name: "consumer",
      version: "1.0.0",
      private: true,
      devDependencies: { "@octogee/source": "file:../source" },
      peerDependencies: { "@octogee/source": "^1.0.0" },
    });
    fs.writeFileSync(path.join(consumerDir, ".npmrc"), "install-links=true\n");
    execFileSync(NPM_BIN, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: consumerDir,
      stdio: "pipe",
    });
    const sourcePackagePath = path.join(sourceDir, "package.json");
    const sourcePackage = readJson(sourcePackagePath);
    sourcePackage.version = "1.0.1";
    writeJson(sourcePackagePath, sourcePackage);

    syncLocalFileDeps({ rootDir: root, consumerDirs: [consumerDir], stdio: "ignore" });

    const consumerPackage = readJson(path.join(consumerDir, "package.json"));
    expect(consumerPackage.devDependencies).toEqual({
      "@octogee/source": "file:../source",
    });
    expect(consumerPackage.peerDependencies).toEqual({
      "@octogee/source": "^1.0.0",
    });
    const lock = readJson(path.join(consumerDir, "package-lock.json")) as {
      packages: Record<string, { version: string }>;
    };
    expect(lock.packages["node_modules/@octogee/source"].version).toBe("1.0.1");
  }, 30_000);

  it("repairs a producer runtime graph before npm 10 performs the next clean install", () => {
    const root = fixture();
    const sourceDir = writePackage(root, "source", "@octogee/source");
    const runtimeDir = path.join(root, "runtime");
    fs.mkdirSync(runtimeDir);
    writeJson(path.join(runtimeDir, "package.json"), {
      name: "@fixture/runtime",
      version: "1.0.0",
      type: "module",
      files: ["index.js"],
      exports: { ".": "./index.js" },
    });
    fs.writeFileSync(path.join(runtimeDir, "index.js"), "export const value = 2;\n");
    const consumerDir = writeConsumer(root);
    execFileSync(NPM_BIN, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: consumerDir,
      stdio: "pipe",
    });
    const sourcePackagePath = path.join(sourceDir, "package.json");
    const sourcePackage = readJson(sourcePackagePath);
    sourcePackage.dependencies = { "@fixture/runtime": "file:../runtime" };
    writeJson(sourcePackagePath, sourcePackage);
    fs.writeFileSync(
      path.join(sourceDir, "dist", "index.js"),
      'import { value } from "@fixture/runtime";\nexport { value };\n',
    );

    fs.rmSync(path.join(consumerDir, "node_modules"), { recursive: true, force: true });
    execFileSync(NPM_BIN, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: consumerDir,
      stdio: "pipe",
    });
    expect(fs.existsSync(path.join(consumerDir, "node_modules", "@fixture", "runtime")))
      .toBe(false);

    syncLocalFileDeps({ rootDir: root, consumerDirs: [consumerDir], stdio: "ignore" });

    const repairedLock = readJson(path.join(consumerDir, "package-lock.json")) as {
      packages: Record<string, { dependencies?: Record<string, string> }>;
    };
    expect(repairedLock.packages["node_modules/@octogee/source"].dependencies).toEqual({
      "@fixture/runtime": "file:../runtime",
    });
    fs.rmSync(path.join(consumerDir, "node_modules"), { recursive: true, force: true });
    execFileSync(NPM_BIN, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: consumerDir,
      stdio: "pipe",
    });
    expect(fs.existsSync(path.join(consumerDir, "node_modules", "@fixture", "runtime")))
      .toBe(true);
    expect(execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", 'console.log((await import("@octogee/source")).value)'],
      { cwd: consumerDir, encoding: "utf8" },
    ).trim()).toBe("2");
  }, 30_000);
});

describe("file-dependency refresh disables the registry release-age cooldown", () => {
  it("neutralizes min-release-age on the preserve-lock refresh install", () => {
    const args = fileDepInstallArgs(["@octogee/source@file:../source"], true);
    expect(args).toContain("--min-release-age=0");
    expect(args).toContain("--install-links=true");
    expect(args).toContain("--no-save");
    expect(args).toContain("--package-lock=false");
    expect(args.at(-1)).toBe("@octogee/source@file:../source");
  });

  it("neutralizes min-release-age on the lock-rewriting refresh install", () => {
    expect(fileDepInstallArgs(["@octogee/source@file:../source"], false)).toContain(
      "--min-release-age=0",
    );
    expect(fileDepLockOnlyArgs()).toContain("--min-release-age=0");
    expect(fileDepLockOnlyArgs()).toContain("--package-lock-only");
  });
});

function writeLibrary(root: string): string {
  const libraryDir = writePackage(root, "library", "@octogee/library");
  const manifest = readJson(path.join(libraryDir, "package.json"));
  writeJson(path.join(libraryDir, "package.json"), {
    ...manifest,
    dependencies: { express: "^5.0.0" },
    peerDependencies: { "@octogee/source": "^1.0.0" },
  });
  fs.mkdirSync(path.join(libraryDir, "src"));
  fs.writeFileSync(path.join(libraryDir, "src", "index.ts"), "export const value = 1;\n");
  return libraryDir;
}

function writeOverlayConsumer(root: string, installed: string[]): string {
  const consumerDir = path.join(root, "overlay", "controller");
  fs.mkdirSync(consumerDir, { recursive: true });
  writeJson(path.join(consumerDir, "package.json"), { name: "controller", version: "1.0.0", private: true });
  writeJson(path.join(consumerDir, "overlay-dependencies.json"), { dependencies: { "@octogee/library": "file:../../library" } });
  for (const name of installed) writeJson(path.join(consumerDir, "node_modules", ...name.split("/"), "package.json"), { name, version: "1.0.0" });
  return consumerDir;
}

describe("overlay library dependencies", () => {
  it("installs an overlay package's library as a packed copy that resolves the consumer's packages", () => {
    const root = fixture();
    const libraryDir = writeLibrary(root);
    const consumerDir = writeOverlayConsumer(root, ["express", "@octogee/source"]);

    const result = syncLocalFileDeps({
      rootDir: root,
      consumerDirs: [consumerDir],
      installConsumerDepsFn: () => { throw new Error("an overlay library is not an npm dependency"); },
      stdio: "ignore",
    });

    const installedDir = path.join(consumerDir, "node_modules", "@octogee", "library");
    expect(result).toEqual({ staleCount: 1, syncedConsumers: [consumerDir] });
    expect(fs.readFileSync(path.join(installedDir, "package.json"), "utf8")).toBe(fs.readFileSync(path.join(libraryDir, "package.json"), "utf8"));
    expect(fs.readFileSync(path.join(installedDir, "dist", "index.js"), "utf8")).toBe("export const value = 1;\n");
    expect(fs.existsSync(path.join(installedDir, "src"))).toBe(false);
    const [dep] = discoverLocalFileDeps({ rootDir: root, consumerDirs: [consumerDir] });
    expect(inspectLocalFileDep(dep).staleReasons).toEqual([]);
  });

  it("refuses an overlay library whose dependency the consumer does not install", () => {
    const root = fixture();
    writeLibrary(root);
    const consumerDir = writeOverlayConsumer(root, ["@octogee/source"]);

    expect(() => syncLocalFileDeps({ rootDir: root, consumerDirs: [consumerDir], stdio: "ignore" }))
      .toThrow(/@octogee\/library needs express, which .*controller does not install/);
  });

  it("reinstalls an overlay library after a directory refresh replaces the consumer's packages", () => {
    const root = fixture();
    const sourceDir = writePackage(root, "source", "@octogee/source");
    writeLibrary(root);
    const consumerDir = writeOverlayConsumer(root, ["express"]);
    const consumer = readJson(path.join(consumerDir, "package.json"));
    writeJson(path.join(consumerDir, "package.json"), { ...consumer, dependencies: { "@octogee/source": "file:../../source" } });
    writeJson(path.join(consumerDir, "package-lock.json"), {
      name: "controller",
      lockfileVersion: 3,
      packages: {
        "": { name: "controller", dependencies: { "@octogee/source": "file:../../source" } },
        "node_modules/@octogee/source": { version: "1.0.0", resolved: "file:../../source" },
      },
    });

    const result = syncLocalFileDeps({
      rootDir: root,
      consumerDirs: [consumerDir],
      installConsumerDepsFn: (dir) => {
        fs.rmSync(path.join(dir, "node_modules", "@octogee"), { recursive: true, force: true });
        fs.cpSync(sourceDir, path.join(dir, "node_modules", "@octogee", "source"), { recursive: true });
      },
      stdio: "ignore",
    });

    expect(result.staleCount).toBe(2);
    expect(discoverLocalFileDeps({ rootDir: root, consumerDirs: [consumerDir] }).map((dep) => inspectLocalFileDep(dep).staleReasons))
      .toEqual([[], []]);
  });

  it("keeps a library the overlay copy brought in packed when the build has no library source", () => {
    const root = fixture();
    const consumerDir = writeOverlayConsumer(root, ["express", "@octogee/source"]);
    const installedDir = path.join(consumerDir, "node_modules", "@octogee", "library");
    writeJson(path.join(installedDir, "package.json"), { name: "@octogee/library", version: "1.0.0", files: ["dist"] });
    fs.mkdirSync(path.join(installedDir, "dist"));
    fs.writeFileSync(path.join(installedDir, "dist", "index.js"), "export const value = 1;\n");

    const result = syncLocalFileDeps({
      rootDir: root,
      consumerDirs: [consumerDir],
      installConsumerDepsFn: () => { throw new Error("an overlay library is not an npm dependency"); },
      stdio: "ignore",
    });

    expect(result).toEqual({ staleCount: 0, syncedConsumers: [] });
    expect(fs.readFileSync(path.join(installedDir, "dist", "index.js"), "utf8")).toBe("export const value = 1;\n");
  });

  it("refuses an overlay library with neither a source nor a packed copy", () => {
    const root = fixture();
    const consumerDir = writeOverlayConsumer(root, ["express", "@octogee/source"]);

    expect(() => syncLocalFileDeps({ rootDir: root, consumerDirs: [consumerDir], stdio: "ignore" }))
      .toThrow(/@octogee\/library has no source at .*library and no packed copy in .*controller/);
  });

  it("stages each overlay package's libraries under the package for an image build context", () => {
    const root = fixture();
    writeLibrary(root);
    const productRoot = path.join(root, "product");
    writeJson(path.join(productRoot, "controller", "overlay-dependencies.json"), { dependencies: { "@octogee/library": "file:../../library" } });
    fs.mkdirSync(path.join(productRoot, "edge", "src"), { recursive: true });
    writeJson(path.join(productRoot, "core", "package.json"), { name: "@octogee/product-core", version: "1.0.0" });

    stageOverlayDependencies(productRoot);

    expect(fs.readFileSync(path.join(productRoot, "controller", "node_modules", "@octogee", "library", "dist", "index.js"), "utf8"))
      .toBe("export const value = 1;\n");
    expect(fs.existsSync(path.join(productRoot, "edge", "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(productRoot, "core", "node_modules"))).toBe(false);
  });
});
