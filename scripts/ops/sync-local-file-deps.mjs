#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const TAR_BIN = "/usr/bin/tar";
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

export function computeTarballIntegrity(tarballPath) {
  const digest = createHash("sha512")
    .update(fs.readFileSync(tarballPath))
    .digest("base64");
  return `sha512-${digest}`;
}

export function inspectLocalFileDep({ consumerDir, packageName, tarballPath }) {
  const tarballIntegrity = computeTarballIntegrity(tarballPath);
  const lockIntegrity = readLockIntegrity(consumerDir, packageName);
  const tarballPackageJson = readTarballPackageJson(tarballPath);
  const installedPackageJson = readInstalledPackageJson(consumerDir, packageName);
  const staleReasons = [];

  if (lockIntegrity !== tarballIntegrity) {
    staleReasons.push("lock-integrity");
  }
  if (!installedPackageJson || normalizeJson(installedPackageJson) !== normalizeJson(tarballPackageJson)) {
    staleReasons.push("installed-package");
  }

  return {
    consumerDir,
    packageName,
    tarballPath,
    tarballIntegrity,
    lockIntegrity,
    installed: installedPackageJson !== null,
    staleReasons,
  };
}

export function discoverLocalFileDeps({ rootDir, consumerDirs = [] }) {
  const dirs = consumerDirs.length > 0
    ? consumerDirs
    : topLevelPackageDirs(rootDir);

  return dirs.flatMap((consumerDir) => {
    const packageJsonPath = path.join(consumerDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) return [];
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const deps = new Map();

    for (const section of DEP_SECTIONS) {
      const values = packageJson[section];
      if (!values || typeof values !== "object") continue;
      for (const [packageName, spec] of Object.entries(values)) {
        if (typeof spec !== "string" || !isLocalTarballSpec(spec)) continue;
        deps.set(`${packageName}\0${spec}`, {
          consumerDir,
          packageName,
          spec,
          tarballPath: path.resolve(consumerDir, spec.slice("file:".length)),
        });
      }
    }

    return Array.from(deps.values());
  });
}

export function syncLocalFileDeps({
  rootDir = DEFAULT_ROOT,
  consumerDirs = [],
  check = false,
  stdio = "inherit",
} = {}) {
  const deps = discoverLocalFileDeps({ rootDir, consumerDirs });
  const stale = deps
    .map((dep) => ({ dep, state: inspectLocalFileDep(dep) }))
    .filter(({ state }) => state.staleReasons.length > 0);

  if (stale.length === 0) {
    return { staleCount: 0, syncedConsumers: [] };
  }

  for (const { dep, state } of stale) {
    const label = `${path.relative(rootDir, dep.consumerDir) || "."}:${dep.packageName}`;
    console.error(
      `[file-deps] ${label} stale (${state.staleReasons.join(", ")})`,
    );
  }

  if (check) {
    return {
      staleCount: stale.length,
      syncedConsumers: [],
    };
  }

  const byConsumer = new Map();
  for (const item of stale) {
    const key = item.dep.consumerDir;
    const existing = byConsumer.get(key) ?? [];
    existing.push(item.dep);
    byConsumer.set(key, existing);
  }

  const syncedConsumers = [];
  for (const [consumerDir, consumerDeps] of byConsumer) {
    for (const dep of consumerDeps) {
      fs.rmSync(path.join(consumerDir, "node_modules", ...dep.packageName.split("/")), {
        recursive: true,
        force: true,
      });
    }
    const specs = consumerDeps.map((dep) => `${dep.packageName}@${dep.spec}`);
    console.error(`[file-deps] refreshing ${path.relative(rootDir, consumerDir) || "."}: ${specs.join(" ")}`);
    execFileSync(process.execPath, [
      npmCliPath(),
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      ...specs,
    ], { cwd: consumerDir, stdio });
    syncedConsumers.push(consumerDir);
  }

  return {
    staleCount: stale.length,
    syncedConsumers,
  };
}

function isLocalTarballSpec(spec) {
  return spec.startsWith("file:") && spec.endsWith(".tgz");
}

function topLevelPackageDirs(rootDir) {
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !SKIP_DIRS.has(entry.name))
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => path.join(rootDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "package.json")));
}

function readLockIntegrity(consumerDir, packageName) {
  const lockPath = path.join(consumerDir, "package-lock.json");
  if (!fs.existsSync(lockPath)) return null;
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const entry = lock.packages?.[`node_modules/${packageName}`];
  return typeof entry?.integrity === "string" ? entry.integrity : null;
}

function readTarballPackageJson(tarballPath) {
  const raw = execFileSync(TAR_BIN, ["-xOf", tarballPath, "package/package.json"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

function npmCliPath() {
  if (process.env.npm_execpath) {
    return process.env.npm_execpath;
  }
  throw new Error("npm_execpath is not set; run this through npm run sync:file-deps");
}

function readInstalledPackageJson(consumerDir, packageName) {
  const packageJsonPath = path.join(
    consumerDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  if (!fs.existsSync(packageJsonPath)) return null;
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function normalizeJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson(value[key]);
  }
  return sorted;
}

function parseArgs(argv) {
  const args = {
    rootDir: DEFAULT_ROOT,
    consumerDirs: [],
    check: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--root") {
      i += 1;
      args.rootDir = path.resolve(argv[i]);
    } else if (arg === "--consumer") {
      i += 1;
      args.consumerDirs.push(path.resolve(process.cwd(), argv[i]));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = syncLocalFileDeps(parseArgs(process.argv.slice(2)));
    if (result.staleCount > 0 && result.syncedConsumers.length === 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[file-deps] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
