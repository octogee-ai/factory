#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOST_EXEC_SCHEDULES = new Set(["stream", "on-exit"]);
const HOST_EXEC_PAYLOADS = new Set(["script", "command"]);
const SAFE_MODELS = new Set([
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "platform-openrouter/z-ai/glm-5.2",
  "platform-openrouter/minimax/minimax-m3",
  "platform-openrouter/deepseek/deepseek-v4-pro",
  "platform-openrouter/openai/gpt-5.6-luna",
  "platform-openai/gpt-5.4-mini",
]);
const SAFE_SCHEDULED_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "web_search",
  "web_fetch",
  "brave_search",
  "tavily_search",
  "tavily_extract",
]);
const SAFE_SESSION_TARGETS = new Set(["main", "isolated", "current"]);
const CUSTOMER_AGENT_ID = /^octogee-[a-z0-9-]+(?:-proj-[a-z0-9-]+)?-coach$/;

function gatewayClass(env) {
  if (env.GATEWAY_CLASS === "builder" || env.GATEWAY_CLASS === "operator") {
    return env.GATEWAY_CLASS;
  }
  return env.GATEWAY_PROFILE === "operator" ? "operator" : "shared";
}

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function tableExists(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function accountIdForAgent(agentId) {
  if (typeof agentId !== "string" || !CUSTOMER_AGENT_ID.test(agentId)) return null;
  const body = agentId.slice("octogee-".length, -"-coach".length);
  return body.includes("-proj-") ? body : `${body}-coach`;
}

function configuredAgentAccounts(config) {
  const accountIds = new Set(Object.keys(objectValue(config.channels?.mattermost?.accounts) ?? {}));
  const bindings = new Map();
  const add = (agentId) => {
    const accountId = accountIdForAgent(agentId);
    if (accountId && accountIds.has(accountId)) bindings.set(agentId, accountId);
  };
  if (Array.isArray(config.agents?.list)) {
    for (const entry of config.agents.list) add(objectValue(entry)?.id);
  }
  const entries = objectValue(config.agents?.entries);
  if (entries) {
    for (const agentId of Object.keys(entries)) add(agentId);
  }
  return bindings;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseMattermostSession(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  const match = /^agent:([^:]+):mattermost:(direct|group|channel):([^:]+)(?::thread:[^:]+)?$/i.exec(sessionKey);
  return match ? { agentId: match[1].toLowerCase(), kind: match[2].toLowerCase(), peerId: match[3] } : null;
}

function sessionOwnedBy(sessionKey, agentId) {
  return typeof sessionKey === "string" && sessionKey.startsWith(`agent:${agentId}:`);
}

function destinationMatchesSession(value, route) {
  return value == null || value === route.peerId || value === `mattermost:${route.kind}:${route.peerId}`;
}

function safeModelList(raw) {
  if (raw == null) return true;
  const parsed = parseJson(raw);
  return Array.isArray(parsed) && parsed.every((model) => typeof model === "string" && SAFE_MODELS.has(model));
}

function safeToolList(raw) {
  if (raw == null) return true;
  const parsed = parseJson(raw);
  return Array.isArray(parsed) &&
    new Set(parsed).size === parsed.length &&
    parsed.every((tool) => typeof tool === "string" && SAFE_SCHEDULED_TOOLS.has(tool));
}

function rowQuarantineReason(row, bindings) {
  if (HOST_EXEC_SCHEDULES.has(row.schedule_kind)) return "host-exec-schedule";
  if (HOST_EXEC_PAYLOADS.has(row.payload_kind)) return "host-exec-payload";
  if (row.trigger_script != null) return "trigger-script";
  if (row.payload_allow_unsafe_external_content === 1) return "unsafe-external-content";
  if (row.payload_model != null && !SAFE_MODELS.has(row.payload_model)) return "unsafe-model";
  if (!safeModelList(row.payload_fallbacks_json)) return "unsafe-fallbacks";
  if (!safeToolList(row.payload_tools_allow_json)) return "unsafe-tools";
  if (!SAFE_SESSION_TARGETS.has(row.session_target)) return "unsafe-session-target";

  const job = objectValue(parseJson(row.job_json));
  if (!job) return "invalid-job-json";
  const effectiveAgentId = row.agent_id;
  const accountId = bindings.get(effectiveAgentId);
  if (!accountId) return "unconfigured-agent";
  if (row.owner_agent_id !== effectiveAgentId) return "owner-agent-mismatch";
  if (!sessionOwnedBy(row.owner_session_key, effectiveAgentId)) return "owner-session-mismatch";
  if (row.session_key != null && !sessionOwnedBy(row.session_key, effectiveAgentId)) return "session-mismatch";
  const route = parseMattermostSession(row.owner_session_key);
  if (!route || route.agentId !== effectiveAgentId) return "non-mattermost-owner-session";

  const owner = objectValue(job.owner);
  if (owner?.agentId !== effectiveAgentId || owner.sessionKey !== row.owner_session_key || owner.accountId !== accountId) {
    return "job-owner-mismatch";
  }
  if (job.agentId !== effectiveAgentId || job.sessionKey !== row.session_key) return "job-routing-mismatch";
  const scheduledPolicy = objectValue(job.scheduledToolPolicy);
  if (row.payload_tools_allow_json != null &&
      (scheduledPolicy?.mode !== "account" || scheduledPolicy.ownerSessionKey !== row.owner_session_key ||
       scheduledPolicy.ownerAccountId !== accountId)) {
    return "scheduled-authority-mismatch";
  }

  for (const field of ["delivery_account_id", "failure_delivery_account_id", "failure_alert_account_id"]) {
    if (row[field] != null && row[field] !== accountId) return `${field.replaceAll("_", "-")}-mismatch`;
  }
  for (const field of ["delivery_channel", "failure_delivery_channel", "failure_alert_channel"]) {
    if (row[field] != null && row[field] !== "mattermost") return `${field.replaceAll("_", "-")}-mismatch`;
  }
  if (!destinationMatchesSession(row.delivery_to, route)) return "delivery-destination-mismatch";
  if (!destinationMatchesSession(row.failure_delivery_to, route)) return "failure-delivery-destination-mismatch";
  if (!destinationMatchesSession(row.failure_alert_to, route)) return "failure-alert-destination-mismatch";
  if (row.delivery_mode === "webhook" || row.failure_delivery_mode === "webhook" ||
      row.failure_alert_mode === "webhook" || row.delivery_completion_mode != null ||
      row.delivery_completion_to != null) {
    return "webhook-destination";
  }
  return null;
}

function readQuarantine(file) {
  if (!fs.existsSync(file)) return { version: 1, jobs: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.jobs)) {
    throw new Error(`invalid customer cron quarantine file: ${file}`);
  }
  return parsed;
}

function writeQuarantine(file, rows) {
  const current = readQuarantine(file);
  const jobs = new Map(current.jobs.map((job) => [`${job.storeKey}\u0000${job.jobId}`, job]));
  const quarantinedAt = new Date().toISOString();
  for (const row of rows) {
    jobs.set(`${row.store_key}\u0000${row.job_id}`, {
      storeKey: row.store_key,
      jobId: row.job_id,
      reason: row.quarantine_reason,
      scheduleKind: row.schedule_kind,
      payloadKind: row.payload_kind,
      triggerScript: row.trigger_script,
      jobJson: row.job_json,
      updatedAt: row.updated_at,
      quarantinedAt,
    });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, jobs: [...jobs.values()] }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function quarantineCustomerCronJobs(env = process.env, log = console.log) {
  if (gatewayClass(env) === "operator") {
    log("customer cron quarantine skipped for operator gateway");
    return { removed: 0, skipped: "operator" };
  }
  const openclawDir = env.OPENCLAW_DIR ?? "/home/node/.openclaw";
  const stateRoot = env.OPENCLAW_STATE_DIR?.trim() || openclawDir;
  const databasePath = path.join(stateRoot, "state", "openclaw.sqlite");
  if (!fs.existsSync(databasePath)) return { removed: 0, skipped: "missing-database" };

  const db = new DatabaseSync(databasePath);
  try {
    if (!tableExists(db, "cron_jobs")) return { removed: 0, skipped: "missing-table" };
    const required = [
      "store_key", "job_id", "owner_agent_id", "owner_session_key", "agent_id", "session_key",
      "session_target", "schedule_kind", "payload_kind", "trigger_script", "payload_model",
      "payload_fallbacks_json", "payload_allow_unsafe_external_content", "payload_tools_allow_json",
      "delivery_mode", "delivery_channel", "delivery_to", "delivery_account_id",
      "delivery_completion_mode", "delivery_completion_to", "failure_delivery_mode",
      "failure_delivery_channel", "failure_delivery_to", "failure_delivery_account_id",
      "failure_alert_channel", "failure_alert_to", "failure_alert_mode", "failure_alert_account_id",
      "job_json", "updated_at",
    ];
    const columns = new Set(db.prepare("PRAGMA table_info(cron_jobs)").all().map((row) => row.name));
    for (const column of required) {
      if (!columns.has(column)) throw new Error(`cron_jobs is missing required safety column ${column}`);
    }

    const configPath = env.OPENCLAW_CONFIG_PATH?.trim() || path.join(openclawDir, "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const bindings = configuredAgentAccounts(config);
    const rows = db.prepare(`SELECT ${required.join(", ")} FROM cron_jobs`).all();
    const quarantined = rows.flatMap((row) => {
      const reason = rowQuarantineReason(row, bindings);
      return reason ? [{ ...row, quarantine_reason: reason }] : [];
    });
    if (quarantined.length === 0) return { removed: 0 };

    const quarantinePath = path.join(openclawDir, "cron", "octogee-customer-cron-quarantine.json");
    writeQuarantine(quarantinePath, quarantined);
    const removeJob = db.prepare("DELETE FROM cron_jobs WHERE store_key = ? AND job_id = ?");
    const removeScratch = tableExists(db, "cron_job_scratch")
      ? db.prepare("DELETE FROM cron_job_scratch WHERE store_key = ? AND job_id = ?")
      : null;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of quarantined) {
        removeScratch?.run(row.store_key, row.job_id);
        removeJob.run(row.store_key, row.job_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    log(`quarantined ${quarantined.length} unsafe customer cron job(s)`);
    return { removed: quarantined.length, quarantinePath };
  } finally {
    db.close();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  quarantineCustomerCronJobs();
}
