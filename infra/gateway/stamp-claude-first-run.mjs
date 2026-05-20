#!/usr/bin/env node
// Operator-profile gateways stamp Claude Code's first-run completion
// flags into ~/.claude.json when valid OAuth credentials are already on
// disk. Bender's PVC needed this stamped manually after the first
// `claude auth login` — Claude's TUI otherwise drops into the setup
// wizard even though `claude auth status` reports max-tier auth.
//
// Hard rules (pinned by tests/specs/stamp-claude-first-run.spec.ts):
//   - NEVER fake completion when .credentials.json is absent.
//   - NEVER touch workspace-trust prompts (that's an operator gesture).
//   - NEVER create or copy auth tokens — the OAuth blob is operator-owned.
//   - Preserve every other key in ~/.claude.json.
//   - Atomic write (temp+rename, mode-from-open) — no umask window,
//     no truncated-config aftermath if the process dies mid-write.
//   - On malformed pre-existing ~/.claude.json: back up the broken
//     file with a timestamped suffix and proceed with an empty config.
//     Wedging boot is worse than losing one corrupt config.
//
// Credentials-path precedence: CLAUDE_CONFIG_DIR/.credentials.json if the
// env is set (matches Claude Code's documented relocation knob), else
// $HOME/.claude/.credentials.json. The stamped config itself stays at
// $HOME/.claude.json — that's what Claude's TUI reads, and it does not
// move with CLAUDE_CONFIG_DIR today.
//
// Wired into infra/gateway/entrypoint.sh under
// `if [ "${GATEWAY_PROFILE:-}" = "operator" ]`.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function readClaudeVersion({ claudeBin = "claude" } = {}) {
  const result = spawnSync(claudeBin, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const first = (result.stdout || "").trim().split(/\s+/)[0];
  return first || null;
}

function resolveCredentialsPath(home, claudeConfigDir) {
  const explicit = claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (explicit) return path.join(explicit, ".credentials.json");
  return path.join(home, ".claude", ".credentials.json");
}

function loadExistingConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${configPath}.broken.${stamp}`;
    fs.renameSync(configPath, backup);
    return {};
  }
}

function atomicWriteJson(configPath, config) {
  const tmpPath = `${configPath}.tmp`;
  // O_WRONLY|O_CREAT|O_TRUNC + mode 0600 → no umask window. fs.writeFileSync
  // with options.mode does the same under the hood, but we use the fd path
  // explicitly so the close-then-rename order is unambiguous.
  const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, configPath);
}

function isAlreadyStamped(config, claudeVersion) {
  if (config.hasCompletedOnboarding !== true) return false;
  if (config._hasCompletedAuthFlow !== true) return false;
  // No version requested → flags-present is enough. Version requested →
  // it must match (operator may have upgraded claude; refresh the marker).
  if (claudeVersion && config.lastOnboardingVersion !== claudeVersion) return false;
  // No version requested AND marker absent → still treat as stamped
  // (we never wrote a version, can't claim drift). When a version IS
  // requested but absent, that's a partial half-write — re-stamp.
  if (claudeVersion && !config.lastOnboardingVersion) return false;
  return true;
}

export function stampFirstRun({ home, claudeVersion, claudeConfigDir } = {}) {
  const resolvedHome = home ?? process.env.HOME ?? "/home/node";
  const credentialsPath = resolveCredentialsPath(resolvedHome, claudeConfigDir);
  if (!fs.existsSync(credentialsPath)) {
    return { stamped: false, reason: "no-credentials" };
  }
  const configPath = path.join(resolvedHome, ".claude.json");
  const config = loadExistingConfig(configPath);
  if (isAlreadyStamped(config, claudeVersion)) {
    return { stamped: false, reason: "already-stamped" };
  }
  config.hasCompletedOnboarding = true;
  config._hasCompletedAuthFlow = true;
  if (claudeVersion) {
    config.lastOnboardingVersion = claudeVersion;
  }
  atomicWriteJson(configPath, config);
  return { stamped: true, configPath };
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const version = readClaudeVersion();
  const result = stampFirstRun({ claudeVersion: version });
  if (result.stamped) {
    console.log(
      `[stamp-claude-first-run] stamped ${result.configPath} (version=${version ?? "unknown"})`,
    );
  } else {
    console.log(`[stamp-claude-first-run] skipped: ${result.reason}`);
  }
}
