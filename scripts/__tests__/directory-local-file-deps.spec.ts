import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  discoverLocalFileDeps,
  inspectLocalFileDep,
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

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("directory local file dependencies", () => {
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
    const installs: string[][] = [];

    const result = syncLocalFileDeps({
      rootDir: root,
      consumerDirs: [consumerDir],
      installConsumerDepsFn: (dir, specs) => {
        installs.push(specs);
        copySourceToInstalled(sourceDir, dir);
      },
      stdio: "ignore",
    });

    expect(result).toEqual({ staleCount: 1, syncedConsumers: [consumerDir] });
    expect(installs).toEqual([["@octogee/source@file:../source"]]);
    expect(fs.readFileSync(path.join(consumerDir, "package-lock.json"), "utf8")).toBe(lockBefore);
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

    execFileSync(NPM_BIN, ["install", "--package-lock-only", "--ignore-scripts"], {
      cwd: consumerDir,
      stdio: "pipe",
    });
    const lockBefore = fs.readFileSync(path.join(consumerDir, "package-lock.json"), "utf8");
    execFileSync(NPM_BIN, ["ci", "--ignore-scripts"], {
      cwd: consumerDir,
      stdio: "pipe",
    });

    const installed = path.join(consumerDir, "node_modules", "@octogee", "source");
    expect(fs.lstatSync(installed).isSymbolicLink()).toBe(false);
    fs.writeFileSync(path.join(sourceDir, "dist", "index.js"), "export const value = 2;\n");
    execFileSync(NPM_BIN, ["ci", "--ignore-scripts"], {
      cwd: consumerDir,
      stdio: "pipe",
    });

    expect(fs.readFileSync(path.join(installed, "dist", "index.js"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    expect(fs.readFileSync(path.join(consumerDir, "package-lock.json"), "utf8")).toBe(lockBefore);
  });
});
