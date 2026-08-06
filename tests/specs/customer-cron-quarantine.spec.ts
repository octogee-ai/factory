import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(repoRoot, "infra/gateway/quarantine-customer-cron-jobs.mjs");
const storeKey = "/home/node/.openclaw/cron/jobs.json";
const ceckertAgent = "octogee-ceckert-coach";
const mikeAgent = "octogee-mike-coach";
const ceckertAccount = "ceckert-coach";
const mikeAccount = "mike-coach";
const ceckertSession = `agent:${ceckertAgent}:mattermost:channel:ceckert-channel`;
const mikeSession = `agent:${mikeAgent}:mattermost:channel:mike-channel`;

type CronRow = Record<string, string | number | null>;

function row(jobId: string, overrides: Partial<CronRow> = {}): CronRow {
  const values: CronRow = {
    store_key: storeKey,
    job_id: jobId,
    owner_agent_id: ceckertAgent,
    owner_session_key: ceckertSession,
    agent_id: ceckertAgent,
    session_key: ceckertSession,
    session_target: "main",
    schedule_kind: "cron",
    payload_kind: "systemEvent",
    trigger_script: null,
    payload_model: null,
    payload_fallbacks_json: null,
    payload_allow_unsafe_external_content: null,
    payload_tools_allow_json: null,
    delivery_mode: "announce",
    delivery_channel: "mattermost",
    delivery_to: "ceckert-channel",
    delivery_account_id: ceckertAccount,
    delivery_completion_mode: null,
    delivery_completion_to: null,
    failure_delivery_mode: null,
    failure_delivery_channel: null,
    failure_delivery_to: null,
    failure_delivery_account_id: null,
    failure_alert_channel: null,
    failure_alert_to: null,
    failure_alert_mode: null,
    failure_alert_account_id: null,
    job_json: "",
    updated_at: 1,
    ...overrides,
  };
  if (!overrides.job_json) {
    values.job_json = JSON.stringify({
      id: jobId,
      owner: {
        agentId: values.owner_agent_id,
        sessionKey: values.owner_session_key,
        accountId: values.owner_agent_id === mikeAgent ? mikeAccount : ceckertAccount,
      },
      agentId: values.agent_id,
      sessionKey: values.session_key,
      sessionTarget: values.session_target,
    });
  }
  return values;
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "octogee-cron-quarantine-"));
  const state = path.join(root, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({
    agents: { list: [{ id: ceckertAgent }, { id: mikeAgent }] },
    channels: { mattermost: { accounts: { [ceckertAccount]: {}, [mikeAccount]: {} } } },
  }));
  const db = new DatabaseSync(path.join(state, "openclaw.sqlite"));
  db.exec(`
    CREATE TABLE cron_jobs (
      store_key TEXT NOT NULL,
      job_id TEXT NOT NULL,
      owner_agent_id TEXT,
      owner_session_key TEXT,
      agent_id TEXT,
      session_key TEXT,
      session_target TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      payload_kind TEXT NOT NULL,
      trigger_script TEXT,
      payload_model TEXT,
      payload_fallbacks_json TEXT,
      payload_allow_unsafe_external_content INTEGER,
      payload_tools_allow_json TEXT,
      delivery_mode TEXT,
      delivery_channel TEXT,
      delivery_to TEXT,
      delivery_account_id TEXT,
      delivery_completion_mode TEXT,
      delivery_completion_to TEXT,
      failure_delivery_mode TEXT,
      failure_delivery_channel TEXT,
      failure_delivery_to TEXT,
      failure_delivery_account_id TEXT,
      failure_alert_channel TEXT,
      failure_alert_to TEXT,
      failure_alert_mode TEXT,
      failure_alert_account_id TEXT,
      job_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (store_key, job_id)
    );
    CREATE TABLE cron_job_scratch (
      store_key TEXT NOT NULL,
      job_id TEXT NOT NULL,
      content TEXT,
      PRIMARY KEY (store_key, job_id)
    );
  `);
  const rows = [
    row("safe"),
    row("script", { payload_kind: "script" }),
    row("command", { payload_kind: "command" }),
    row("stream", { schedule_kind: "stream" }),
    row("exit", { schedule_kind: "on-exit" }),
    row("trigger", { trigger_script: "json({ fire: true })" }),
    row("mike-job-naming-ceckert", {
      owner_agent_id: mikeAgent,
      owner_session_key: mikeSession,
      agent_id: ceckertAgent,
      session_key: ceckertSession,
      delivery_account_id: ceckertAccount,
    }),
    row("foreign-delivery-account", { delivery_account_id: mikeAccount }),
    row("foreign-session", { session_key: mikeSession }),
    row("webhook", { delivery_mode: "webhook", delivery_to: "https://attacker.example/hook" }),
    row("unsafe-model", { payload_kind: "agentTurn", payload_model: "openai/gpt-attacker" }),
    row("unsafe-fallback", { payload_kind: "agentTurn", payload_fallbacks_json: JSON.stringify(["openai/gpt-attacker"]) }),
    row("unsafe-tools", { payload_kind: "agentTurn", payload_tools_allow_json: JSON.stringify(["exec"]) }),
    row("wildcard-tools", { payload_kind: "agentTurn", payload_tools_allow_json: JSON.stringify(["*"]) }),
    row("group-tools", { payload_kind: "agentTurn", payload_tools_allow_json: JSON.stringify(["group:web"]) }),
    row("pattern-tools", { payload_kind: "agentTurn", payload_tools_allow_json: JSON.stringify(["octogee_*"]) }),
    row("duplicate-tools", { payload_kind: "agentTurn", payload_tools_allow_json: JSON.stringify(["read", "read"]) }),
    row("malformed-tools", { payload_kind: "agentTurn", payload_tools_allow_json: "[" }),
    row("safe-tools", {
      payload_kind: "agentTurn",
      payload_tools_allow_json: JSON.stringify(["read", "web_search"]),
      job_json: JSON.stringify({
        id: "safe-tools",
        owner: { agentId: ceckertAgent, sessionKey: ceckertSession, accountId: ceckertAccount },
        agentId: ceckertAgent,
        sessionKey: ceckertSession,
        sessionTarget: "main",
        scheduledToolPolicy: {
          mode: "account",
          ownerSessionKey: ceckertSession,
          ownerAccountId: ceckertAccount,
        },
      }),
    }),
    row("wildcard-session-target", { session_target: "session:*" }),
    row("owned-session-target", { session_target: `session:${ceckertSession}` }),
    row("malformed-session-target", { session_target: "MAIN" }),
  ];
  const columns = Object.keys(rows[0]);
  const insert = db.prepare(
    `INSERT INTO cron_jobs (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`,
  );
  for (const cronRow of rows) {
    insert.run(cronRow);
    db.prepare("INSERT INTO cron_job_scratch VALUES (?, ?, ?)").run(storeKey, cronRow.job_id, "scratch");
  }
  db.close();
  return { root, jobCount: rows.length };
}

function run(root: string, gatewayClass: "shared" | "builder") {
  return spawnSync("node", [script], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_DIR: root, GATEWAY_CLASS: gatewayClass },
  });
}

describe("customer cron routing quarantine", () => {
  it.each(["shared", "builder"] as const)(
    "removes cross-tenant and unsafe persisted jobs before %s startup while preserving a fully attributed reminder",
    (gatewayClass) => {
      const { root } = fixture();
      const result = run(root, gatewayClass);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("quarantined 20 unsafe customer cron job(s)");

      const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
      expect(db.prepare("SELECT job_id FROM cron_jobs ORDER BY job_id").all()).toEqual([
        { job_id: "safe" },
        { job_id: "safe-tools" },
      ]);
      expect(db.prepare("SELECT job_id FROM cron_job_scratch ORDER BY job_id").all()).toEqual([
        { job_id: "safe" },
        { job_id: "safe-tools" },
      ]);
      db.close();
      const quarantine = JSON.parse(readFileSync(
        path.join(root, "cron", "octogee-customer-cron-quarantine.json"),
        "utf8",
      ));
      expect(quarantine.jobs.map((job: { jobId: string }) => job.jobId).sort()).toEqual([
        "command",
        "duplicate-tools",
        "exit",
        "foreign-delivery-account",
        "foreign-session",
        "group-tools",
        "malformed-session-target",
        "malformed-tools",
        "mike-job-naming-ceckert",
        "owned-session-target",
        "pattern-tools",
        "script",
        "stream",
        "trigger",
        "unsafe-fallback",
        "unsafe-model",
        "unsafe-tools",
        "webhook",
        "wildcard-session-target",
        "wildcard-tools",
      ]);
      expect(quarantine.jobs.find((job: { jobId: string }) => job.jobId === "mike-job-naming-ceckert").reason)
        .toBe("owner-agent-mismatch");
    },
  );

  it("does not exempt the retired operator class from quarantine", () => {
    const { root } = fixture();
    const result = run(root, "operator" as never);
    expect(result.status, result.stderr).toBe(0);
    const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
    expect(db.prepare("SELECT count(*) AS count FROM cron_jobs").get()).toEqual({ count: 2 });
    db.close();
  });
});
