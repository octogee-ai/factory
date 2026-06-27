#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function resolvePackageToolPaths(cwd = process.cwd()) {
  return {
    firebaseCliPath: path.join(cwd, "node_modules/firebase-tools/lib/bin/firebase.js"),
    vitestPath: path.join(cwd, "node_modules/vitest/vitest.mjs"),
  };
}

export function buildInnerVitestCommand({
  nodePath,
  vitestPath,
  config,
  env,
  vitestArgs,
}) {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const commandParts = [
    shellQuote(nodePath),
    shellQuote(vitestPath),
    "run",
    "--config",
    shellQuote(config),
    ...vitestArgs.map(shellQuote),
  ];
  return [envPrefix, commandParts.join(" ")].filter(Boolean).join(" ");
}

export function parseRunEmulatorVitestArgs(argv) {
  const parsed = {
    only: "",
    project: "",
    firebaseConfig: "",
    config: "vitest.emulator.config.ts",
    env: {},
    vitestArgs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      parsed.vitestArgs.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--only") {
      i += 1;
      parsed.only = requiredValue(argv[i], "--only");
    } else if (arg === "--project") {
      i += 1;
      parsed.project = requiredValue(argv[i], "--project");
    } else if (arg === "--firebase-config") {
      i += 1;
      parsed.firebaseConfig = requiredValue(argv[i], "--firebase-config");
    } else if (arg === "--config") {
      i += 1;
      parsed.config = requiredValue(argv[i], "--config");
    } else if (arg === "--env") {
      i += 1;
      const [key, ...valueParts] = requiredValue(argv[i], "--env").split("=");
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || valueParts.length === 0) {
        throw new Error("--env must use NAME=value with an uppercase shell-safe NAME");
      }
      parsed.env[key] = valueParts.join("=");
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      parsed.vitestArgs.push(arg);
    }
  }

  if (!parsed.only) throw new Error("--only is required");
  if (!parsed.project) throw new Error("--project is required");

  return parsed;
}

export function buildFirebaseEmulatorsExecArgs({
  firebaseCliPath,
  only,
  project,
  firebaseConfig,
  innerCommand,
}) {
  const args = [
    firebaseCliPath,
    "emulators:exec",
    "--only",
    only,
    "--project",
    project,
  ];

  if (firebaseConfig) {
    args.push("--config", firebaseConfig);
  }

  args.push(innerCommand);
  return args;
}

export function runEmulatorVitest({
  cwd = process.cwd(),
  nodePath = process.execPath,
  only,
  project,
  firebaseConfig,
  config,
  env,
  vitestArgs,
  stdio = "inherit",
}) {
  const { firebaseCliPath, vitestPath } = resolvePackageToolPaths(cwd);
  assertFile(firebaseCliPath, "firebase-tools CLI");
  assertFile(vitestPath, "Vitest entrypoint");

  const innerCommand = buildInnerVitestCommand({
    nodePath,
    vitestPath,
    config,
    env,
    vitestArgs,
  });

  execFileSync(process.execPath, buildFirebaseEmulatorsExecArgs({
    firebaseCliPath,
    only,
    project,
    firebaseConfig,
    innerCommand,
  }), { cwd, stdio });
}

function requiredValue(value, flag) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}. Run npm ci in this package.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runEmulatorVitest(parseRunEmulatorVitestArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`[emulator-vitest] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
