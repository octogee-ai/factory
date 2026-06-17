#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXEC_TOOLS = new Set(["exec", "process"]);

function removeExecDenies(value) {
  if (!Array.isArray(value)) return value;
  return value.filter((tool) => !EXEC_TOOLS.has(tool));
}

function addDeny(list, tool) {
  if (!Array.isArray(list)) return [tool];
  return list.includes(tool) ? list : [...list, tool];
}

function disableCodex(config) {
  config.plugins ??= {};
  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter((id) => id !== "codex");
  }
  config.plugins.entries ??= {};
  config.plugins.entries.codex ??= {};
  config.plugins.entries.codex.enabled = false;
}

function applySharedPolicy(config) {
  config.tools ??= {};
  config.tools.deny = addDeny(addDeny(config.tools.deny, "exec"), "process");
  config.tools.exec = { mode: "deny" };
  config.tools.subagents ??= {};
  config.tools.subagents.tools ??= {};
  config.tools.subagents.tools.deny = addDeny(
    addDeny(config.tools.subagents.tools.deny, "exec"),
    "process",
  );
  disableCodex(config);
}

function applyBuilderPolicy(config) {
  config.tools ??= {};
  config.tools.deny = removeExecDenies(config.tools.deny);
  delete config.tools.exec;
  config.tools.subagents ??= {};
  config.tools.subagents.tools ??= {};
  config.tools.subagents.tools.deny = removeExecDenies(config.tools.subagents.tools.deny);
  disableCodex(config);
}

function resolveGatewayClass(env) {
  if (env.GATEWAY_CLASS === "builder" || env.GATEWAY_CLASS === "operator") {
    return env.GATEWAY_CLASS;
  }
  if (env.GATEWAY_PROFILE === "operator") return "operator";
  return "shared";
}

function resolveOpenclawJsonPath() {
  const dir =
    process.env.OPENCLAW_DIR ?? path.join(process.env.HOME ?? "/home/node", ".openclaw");
  return path.join(dir, "openclaw.json");
}

function atomicWriteJson(configPath, config) {
  const tmpPath = `${configPath}.tmp`;
  const fd = fs.openSync(
    tmpPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600,
  );
  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, configPath);
}

export function applyGatewayClassPolicy({ openclawJsonPath, env = process.env } = {}) {
  const configPath = openclawJsonPath ?? resolveOpenclawJsonPath();
  if (!fs.existsSync(configPath)) return { applied: false, reason: "no-openclaw-json" };
  const raw = fs.readFileSync(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `apply-gateway-class-policy: ${configPath} is not valid JSON — refusing to overwrite (${err.message})`,
    );
  }
  const gatewayClass = resolveGatewayClass(env);
  const before = JSON.stringify(config);
  if (gatewayClass === "builder") {
    applyBuilderPolicy(config);
  } else if (gatewayClass === "shared") {
    applySharedPolicy(config);
  } else {
    return { applied: false, reason: "operator-handled-separately", gatewayClass };
  }
  if (JSON.stringify(config) === before) {
    return { applied: false, reason: "already-set", gatewayClass };
  }
  atomicWriteJson(configPath, config);
  return { applied: true, path: configPath, gatewayClass };
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = applyGatewayClassPolicy();
  if (result.applied) {
    console.log(`[apply-gateway-class-policy] applied class=${result.gatewayClass} in ${result.path}`);
  } else {
    console.log(`[apply-gateway-class-policy] skipped: ${result.reason}`);
  }
}
