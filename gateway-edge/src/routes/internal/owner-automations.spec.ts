import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { OwnerAutomationAuthorizationOutcome } from "../../lib/owner-automation-authorization-broker.js";
import { MAX_OWNER_AUTOMATIONS, type OwnerAutomationTenant } from "../owner-automation-jobs.js";
import { createOwnerAutomationRouter } from "./owner-automations.js";

const ALICE: OwnerAutomationTenant = {
  slug: "alice",
  agentId: "octogee-alice-coach",
  ownerMattermostUserId: "a".repeat(26),
  coachChannelId: "c".repeat(26),
};
const BOB: OwnerAutomationTenant = {
  slug: "bob",
  agentId: "octogee-bob-coach",
  ownerMattermostUserId: "b".repeat(26),
  coachChannelId: "d".repeat(26),
};
const BRIEF = {
  key: "weekday-brief",
  name: "Weekday morning brief",
  schedule: { expr: "0 7 * * 1-5", tz: "America/Los_Angeles" },
  prompt: "Brief me on today's calendar, important unread email and open tasks.",
};

type Job = Record<string, unknown>;

function cronStore(initial: Job[] = []) {
  const jobs = initial.map((job) => structuredClone(job));
  let sequence = 0;
  const invoke = vi.fn(async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (method === "cron.list") {
      const offset = Number(params.offset ?? 0), limit = Number(params.limit ?? 200);
      const rows = jobs.slice(offset, offset + limit), next = offset + rows.length;
      return { jobs: rows, snapshotRevision: `rev-${sequence}`, total: jobs.length, offset, limit, hasMore: next < jobs.length, nextOffset: next < jobs.length ? next : null };
    }
    if (method === "cron.add") {
      sequence += 1;
      const existing = jobs.find((job) => job.declarationKey === params.declarationKey);
      const { scheduledToolPolicy, toolsAllowProvenance: _provenance, ...definition } = params;
      const stored = existing
        ? Object.assign(existing, { schedule: params.schedule, payload: params.payload, delivery: params.delivery, displayName: params.displayName, configRevision: `config-${sequence}` })
        : { id: `job-${sequence}`, ...definition, scheduledToolPolicy, effectiveAgentId: params.agentId, configRevision: `config-${sequence}`, state: {} };
      if (!existing) jobs.push(stored);
      return { created: !existing, job: structuredClone(stored) };
    }
    if (method === "cron.remove") {
      const index = jobs.findIndex((job) => job.id === params.id && job.configRevision === params.expectedConfigRevision);
      if (index < 0 && params.expectedConfigRevision !== undefined) throw new Error("revision mismatch");
      jobs.splice(index < 0 ? jobs.findIndex((job) => job.id === params.id) : index, 1);
      return { ok: true, removed: true };
    }
    throw new Error(`unexpected ${method}`);
  });
  return { jobs, invoke };
}

function appForTest(options: {
  store?: ReturnType<typeof cronStore>;
  authorize?: (agentId: string) => OwnerAutomationAuthorizationOutcome;
} = {}) {
  const store = options.store ?? cronStore();
  const authorize = vi.fn(async (_req: express.Request, agentId: string): Promise<OwnerAutomationAuthorizationOutcome> =>
    options.authorize?.(agentId) ?? (agentId === ALICE.agentId ? { kind: "authorized", tenant: ALICE }
      : agentId === BOB.agentId ? { kind: "authorized", tenant: BOB } : { kind: "forbidden" }));
  const app = express();
  app.use(express.json());
  app.use("/internal/owner-automations", createOwnerAutomationRouter({ authorize, invoke: store.invoke }));
  return { app, store, authorize };
}

function call(app: express.Express, action: string, params: Record<string, unknown> = {}, agentId = ALICE.agentId) {
  return request(app).post("/internal/owner-automations").send({
    agentId,
    requestContext: { channel: "mattermost" },
    action,
    params,
  });
}

function managedJob(tenant: OwnerAutomationTenant, key: string, extra: Job = {}): Job {
  const sessionKey = `agent:${tenant.agentId}:mattermost:group:${tenant.coachChannelId}`;
  return {
    id: `${tenant.slug}-${key}`,
    name: key,
    displayName: key,
    declarationKey: `octogee:owner-automation:${tenant.agentId}:${key}`,
    owner: { agentId: tenant.agentId, sessionKey, accountId: `${tenant.slug}-coach` },
    agentId: tenant.agentId,
    effectiveAgentId: tenant.agentId,
    enabled: true,
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Brief.", toolsAllow: ["octogee_google_calendar_events", "octogee_google_gmail_search", "octogee_google_gmail_get", "octogee_google_tasks_lists", "octogee_google_tasks_list"] },
    delivery: { mode: "announce", channel: "mattermost", accountId: `${tenant.slug}-coach`, to: `channel:${tenant.coachChannelId}` },
    scheduledToolPolicy: { version: 1, mode: "account", ownerSessionKey: sessionKey, ownerAccountId: `${tenant.slug}-coach` },
    configRevision: `config-${tenant.slug}-${key}`,
    state: {},
    ...extra,
  };
}

describe("owner automations deputy", () => {
  it("creates the server-owned definition for the authorized tenant", async () => {
    const { app, store } = appForTest();

    const res = await call(app, "save", BRIEF);

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ created: true, automation: { key: "weekday-brief", name: "Weekday morning brief", enabled: true } });
    const sessionKey = `agent:${ALICE.agentId}:mattermost:group:${ALICE.coachChannelId}`;
    expect(store.invoke).toHaveBeenCalledWith("cron.add", {
      name: "weekday-brief",
      displayName: "Weekday morning brief",
      declarationKey: `octogee:owner-automation:${ALICE.agentId}:weekday-brief`,
      owner: { agentId: ALICE.agentId, sessionKey, accountId: "alice-coach" },
      agentId: ALICE.agentId,
      enabled: true,
      schedule: { kind: "cron", expr: "0 7 * * 1-5", tz: "America/Los_Angeles" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: BRIEF.prompt,
        toolsAllow: ["octogee_google_calendar_events", "octogee_google_gmail_search", "octogee_google_gmail_get", "octogee_google_tasks_lists", "octogee_google_tasks_list"],
      },
      delivery: { mode: "announce", channel: "mattermost", accountId: "alice-coach", to: `channel:${ALICE.coachChannelId}` },
      scheduledToolPolicy: { version: 1, mode: "account", ownerSessionKey: sessionKey, ownerAccountId: "alice-coach" },
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        callerOrigin: { kind: "external", channel: "mattermost" },
        channelRequester: { version: 1, channel: "mattermost", accountId: "alice-coach", senderId: ALICE.ownerMattermostUserId },
      },
    });
  });

  it("converges an existing key and lists only the tenant's managed automations", async () => {
    const store = cronStore([
      managedJob(ALICE, "weekday-brief", { nextRunAtMs: 1_793_631_600_000, lastRunStatus: "ok" }),
      managedJob(BOB, "weekday-brief"),
      { ...managedJob(ALICE, "rogue"), delivery: { mode: "announce", channel: "mattermost", accountId: "alice-coach", to: `channel:${BOB.coachChannelId}` } },
      { id: "proactive", name: "Proactive check", enabled: true, agentId: ALICE.agentId, payload: { kind: "agentTurn" }, schedule: { kind: "every" }, state: {}, configRevision: "x" },
    ]);
    const { app } = appForTest({ store });

    const saved = await call(app, "save", BRIEF);
    expect(saved.body.result.created).toBe(false);
    const listed = await call(app, "list");

    expect(listed.status).toBe(200);
    expect(listed.body.result.automations).toEqual([{
      key: "weekday-brief",
      name: "Weekday morning brief",
      schedule: BRIEF.schedule,
      enabled: true,
      nextRunAtMs: 1_793_631_600_000,
      lastRunStatus: "ok",
    }]);
    expect(store.jobs.find((job) => job.id === "bob-weekday-brief")?.schedule).toEqual({ kind: "cron", expr: "0 8 * * *", tz: "UTC" });
  });

  it("refuses to take over a key held by a job outside the managed shape", async () => {
    const store = cronStore([{ ...managedJob(ALICE, "weekday-brief"), payload: { kind: "agentTurn", message: "x", toolsAllow: ["*"] } }]);
    const { app } = appForTest({ store });

    const res = await call(app, "save", BRIEF);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "owner_automation_key_unavailable" });
    expect(store.invoke.mock.calls.map(([method]) => method)).not.toContain("cron.add");
  });

  it("caps each tenant's managed automations, counting writes one at a time", async () => {
    const existing = Array.from({ length: MAX_OWNER_AUTOMATIONS - 1 }, (_, index) => managedJob(ALICE, `job-${index}`));
    const store = cronStore([...existing, ...Array.from({ length: 3 }, (_, index) => managedJob(BOB, `job-${index}`))]);
    const { app } = appForTest({ store });

    const [first, second] = await Promise.all([
      call(app, "save", { ...BRIEF, key: "one" }),
      call(app, "save", { ...BRIEF, key: "two" }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect([first.body, second.body]).toContainEqual({ error: "owner_automation_limit" });
    expect((await call(app, "save", BRIEF, BOB.agentId)).status).toBe(200);
  });

  it("removes only the tenant's managed automation, guarded by its revision", async () => {
    const store = cronStore([managedJob(ALICE, "weekday-brief"), managedJob(BOB, "weekly")]);
    const { app } = appForTest({ store });

    expect((await call(app, "remove", { key: "weekly" })).status).toBe(404);
    const removed = await call(app, "remove", { key: "weekday-brief" });

    expect(removed.status).toBe(200);
    expect(store.invoke).toHaveBeenCalledWith("cron.remove", { id: "alice-weekday-brief", expectedConfigRevision: "config-alice-weekday-brief" });
    expect(store.jobs.map((job) => job.id)).toEqual(["bob-weekly"]);
  });

  it("removes and rejects a stored job that came back outside the managed shape", async () => {
    const store = cronStore();
    const invoke = store.invoke.getMockImplementation()!;
    store.invoke.mockImplementation(async (method, params) => {
      const result = await invoke(method, params) as Record<string, unknown>;
      if (method === "cron.add") (result.job as Record<string, unknown>).sessionKey = `agent:${ALICE.agentId}:main`;
      return result;
    });
    const { app } = appForTest({ store });

    const res = await call(app, "save", BRIEF);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "owner_automation_shape_rejected" });
    expect(store.jobs).toEqual([]);
  });

  it.each([
    ["forbidden", { kind: "forbidden" } as const, 403],
    ["rate limited", { kind: "rate_limited", retryAfterSeconds: 30 } as const, 429],
  ])("makes no native call when authorization is %s", async (_label, outcome, status) => {
    const { app, store } = appForTest({ authorize: () => outcome });

    expect((await call(app, "list")).status).toBe(status);
    expect(store.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["an every-minute schedule", { ...BRIEF, schedule: { expr: "* * * * *", tz: "UTC" } }, "owner_automation_schedule_unsupported"],
    ["a stepped minute", { ...BRIEF, schedule: { expr: "*/5 * * * *", tz: "UTC" } }, "owner_automation_schedule_unsupported"],
    ["an unknown time zone", { ...BRIEF, schedule: { expr: "0 7 * * *", tz: "Mars/Olympus" } }, "owner_automation_time_zone_invalid"],
    ["a long prompt", { ...BRIEF, prompt: "x".repeat(4_001) }, "invalid_owner_automation"],
    ["a bad key", { ...BRIEF, key: "../victim" }, "invalid_owner_automation"],
    ["a caller-chosen delivery", { ...BRIEF, delivery: { to: "channel:elsewhere" } }, "invalid_owner_automation"],
    ["a caller-chosen agent", { ...BRIEF, agentId: BOB.agentId }, "invalid_owner_automation"],
    ["caller-chosen tools", { ...BRIEF, schedule: { ...BRIEF.schedule, toolsAllow: ["*"] } }, "invalid_owner_automation"],
  ])("rejects %s before authorization", async (_label, params, code) => {
    const { app, authorize, store } = appForTest();

    const res = await call(app, "save", params);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: code });
    expect(authorize).not.toHaveBeenCalled();
    expect(store.invoke).not.toHaveBeenCalled();
  });

  it("rejects unknown actions and extra request fields before authorization", async () => {
    const { app, authorize } = appForTest();

    expect((await call(app, "run", {})).status).toBe(400);
    const extra = await request(app).post("/internal/owner-automations")
      .send({ agentId: ALICE.agentId, requestContext: {}, action: "list", params: {}, tenant: BOB });
    expect(extra.status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });
});
