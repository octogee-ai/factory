#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const SKIP_DIRS = new Set([
  ".git",
  ".claude",
  ".codex",
  "node_modules",
  "dist",
  "infra",
  "helm",
  "docs",
]);

export function discoverLocalFileDeps({ rootDir, consumerDirs = [] }) {
  const dirs = consumerDirs.length > 0 ? consumerDirs : topLevelPackageDirs(rootDir);

  return dirs.flatMap((consumerDir) => {
    const packageJsonPath = path.join(consumerDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) return [];
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const deps = new Map();

    for (const section of DEP_SECTIONS) {
      const values = packageJson[section];
      if (!values || typeof values !== "object") continue;
      for (const [packageName, spec] of Object.entries(values)) {
        if (typeof spec !== "string" || !isLocalDirectorySpec(spec)) continue;
        deps.set(`${packageName}\0${spec}`, {
          consumerDir,
          packageName,
          spec,
          sourceDir: path.resolve(consumerDir, spec.slice("file:".length)),
        });
      }
    }

    return Array.from(deps.values());
  });
}

export function inspectLocalFileDep({ consumerDir, packageName, spec, sourceDir }) {
  const installedDir = path.join(consumerDir, "node_modules", ...packageName.split("/"));
  const staleReasons = [];

  if (!fs.existsSync(installedDir)) {
    staleReasons.push("installed-package");
  } else {
    const sourcePackageJson = readJson(path.join(sourceDir, "package.json"));
    const installedPackageJson = readJson(path.join(installedDir, "package.json"));
    if (normalizeJson(sourcePackageJson) !== normalizeJson(installedPackageJson)) {
      staleReasons.push("installed-package");
    }
    if (diffDirectories(path.join(sourceDir, "dist"), path.join(installedDir, "dist")).length > 0) {
      staleReasons.push("installed-dist");
    }
  }

  return {
    consumerDir,
    packageName,
    spec,
    sourceDir,
    installedDir,
    installed: fs.existsSync(installedDir),
    staleReasons,
  };
}

export function syncLocalFileDeps({
  rootDir = DEFAULT_ROOT,
  consumerDirs = [],
  check = false,
  stdio = "inherit",
  installConsumerDepsFn = installConsumerDeps,
} = {}) {
  const stale = discoverLocalFileDeps({ rootDir, consumerDirs })
    .map((dep) => ({ dep, state: inspectLocalFileDep(dep) }))
    .filter(({ state }) => state.staleReasons.length > 0);

  for (const { dep, state } of stale) {
    const label = `${path.relative(rootDir, dep.consumerDir) || "."}:${dep.packageName}`;
    console.error(`[file-deps] ${label} stale (${state.staleReasons.join(", ")})`);
  }

  if (stale.length === 0 || check) {
    return { staleCount: stale.length, syncedConsumers: [] };
  }

  const byConsumer = new Map();
  for (const item of stale) {
    const existing = byConsumer.get(item.dep.consumerDir) ?? [];
    existing.push(item.dep);
    byConsumer.set(item.dep.consumerDir, existing);
  }

  const syncedConsumers = [];
  for (const [consumerDir, consumerDeps] of byConsumer) {
    const lockBefore = readFileIfPresent(path.join(consumerDir, "package-lock.json"));
    for (const dep of consumerDeps) {
      fs.rmSync(path.join(consumerDir, "node_modules", ...dep.packageName.split("/")), {
        recursive: true,
        force: true,
      });
    }
    const specs = consumerDeps.map((dep) => `${dep.packageName}@${dep.spec}`);
    console.error(`[file-deps] refreshing ${path.relative(rootDir, consumerDir) || "."}: ${specs.join(" ")}`);
    installConsumerDepsFn(consumerDir, specs, stdio);
    const lockAfter = readFileIfPresent(path.join(consumerDir, "package-lock.json"));
    if (lockBefore !== lockAfter) {
      throw new Error(`directory refresh changed ${path.relative(rootDir, consumerDir) || "."}/package-lock.json`);
    }
    for (const dep of consumerDeps) {
      const state = inspectLocalFileDep(dep);
      if (state.staleReasons.length > 0) {
        throw new Error(`${dep.packageName} remains stale (${state.staleReasons.join(", ")})`);
      }
    }
    syncedConsumers.push(consumerDir);
  }

  return { staleCount: stale.length, syncedConsumers };
}

function isLocalDirectorySpec(spec) {
  return spec.startsWith("file:") && !spec.endsWith(".tgz");
}

function topLevelPackageDirs(rootDir) {
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !SKIP_DIRS.has(entry.name))
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => path.join(rootDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "package.json")));
}

function installConsumerDeps(consumerDir, specs, stdio) {
  execFileSync(process.execPath, [
    npmCliPath(),
    "install",
    "--no-save",
    "--package-lock=false",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    ...specs,
  ], { cwd: consumerDir, stdio });
}

function npmCliPath() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  throw new Error("npm_execpath is not set; run this through an npm script");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readFileIfPresent(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function diffDirectories(sourceDir, installedDir) {
  const source = fingerprintDirectory(sourceDir);
  const installed = fingerprintDirectory(installedDir);
  const allPaths = new Set([...source.keys(), ...installed.keys()]);
  return Array.from(allPaths)
    .filter((filePath) => source.get(filePath) !== installed.get(filePath))
    .sort();
}

function fingerprintDirectory(directory) {
  const fingerprints = new Map();
  if (!fs.existsSync(directory)) return fingerprints;
  for (const filePath of walkFiles(directory)) {
    const relativePath = path.relative(directory, filePath).split(path.sep).join("/");
    fingerprints.set(relativePath, createHash("sha512").update(fs.readFileSync(filePath)).digest("base64"));
  }
  return fingerprints;
}

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function normalizeJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function parseArgs(argv) {
  const args = { rootDir: DEFAULT_ROOT, consumerDirs: [], check: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--root") {
      index += 1;
      args.rootDir = path.resolve(argv[index]);
    } else if (arg === "--consumer") {
      index += 1;
      args.consumerDirs.push(path.resolve(process.cwd(), argv[index]));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = syncLocalFileDeps(parseArgs(process.argv.slice(2)));
    if (result.staleCount > 0 && result.syncedConsumers.length === 0) process.exitCode = 1;
  } catch (error) {
    console.error(`[file-deps] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
