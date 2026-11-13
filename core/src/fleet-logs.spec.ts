import { describe, expect, it } from "vitest";
import {
  buildFleetLogsFilter,
  FleetLogsQueryError,
  normalizeFleetLog,
  parseFleetLogsQuery,
  streamFleetLogs,
  type FleetLogEntry,
  type LogEntriesRequest,
  type LogEntriesSource,
} from "./fleet-logs.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");

function containerEntry(overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    insertId: "i-1",
    timestamp: "2026-11-10T11:59:58.000Z",
    receiveTimestamp: "2026-11-10T11:59:59.000Z",
    severity: "WARNING",
    resource: { type: "k8s_container", labels: { container_name: "octogee-api", pod_name: "octogee-api-7d9-abcde" } },
    jsonPayload: { message: "slow request", ...payload },
    ...overrides,
  };
}

function recordingSource(pages: Array<{ entries: unknown[]; nextPageToken?: string }>) {
  const requests: LogEntriesRequest[] = [];
  const source: LogEntriesSource = {
    async list(request) {
      requests.push(request);
      return pages.shift() ?? { entries: [] };
    },
  };
  return { source, requests };
}

async function collect(input: {
  source: LogEntriesSource;
  query: Record<string, unknown>;
  polls?: number;
}): Promise<{ entries: FleetLogEntry[]; started: boolean }> {
  const entries: FleetLogEntry[] = [];
  const controller = new AbortController();
  let started = false;
  let polls = 0;
  await streamFleetLogs({
    source: input.source,
    namespace: "octogee-test",
    query: parseFleetLogsQuery(input.query),
    signal: controller.signal,
    now: () => NOW,
    sleep: async () => {
      polls += 1;
      if (polls >= (input.polls ?? 1)) controller.abort();
    },
    onStart: () => { started = true; },
    write: async (entry) => { entries.push(entry); },
  });
  return { entries, started };
}

describe("fleet logs query", () => {
  it("defaults to following info and above", () => {
    expect(parseFleetLogsQuery({})).toEqual({ level: "INFO", follow: true, sinceMs: 600_000 });
  });

  it("reads every filter the fleet command line sends", () => {
    expect(parseFleetLogsQuery({
      level: "warn", service: "api,glm-controller", user: "ada", migration: "m-1", gateway: "shared-a", since: "2h", follow: "false",
    })).toEqual({
      level: "WARNING", services: ["api", "cowboy"], users: ["ada"], migrationId: "m-1", gatewayId: "shared-a", sinceMs: 7_200_000, follow: false,
    });
  });

  it.each([
    [{ level: "loud" }, "log level"],
    [{ since: "2h" }, "since"],
    [{ follow: "false", since: "yesterday" }, "since"],
    [{ gateway: "shared a" }, "gateway"],
    [{ user: "ada\" OR true" }, "user"],
    [{ follow: "maybe" }, "follow"],
    [{ service: ["api", "gitea"] }, "service"],
    [{ container: "gateway" }, "container"],
  ])("refuses %j", (query, message) => {
    expect(() => parseFleetLogsQuery(query)).toThrow(FleetLogsQueryError);
    expect(() => parseFleetLogsQuery(query)).toThrow(message);
  });
});

describe("fleet logs filter", () => {
  it("scopes cluster and VM logs to the namespace, gateway and migration", () => {
    const filter = buildFleetLogsFilter({ namespace: "octogee-test", gatewayId: "shared-a", migrationId: "m-1" });
    expect(filter).toContain('resource.labels.namespace_name="octogee-test"');
    expect(filter).toContain('jsonPayload.container.metadata."ai.octogee.namespace"="octogee-test"');
    expect(filter).toContain('jsonPayload.gatewayId="shared-a"');
    expect(filter).toContain('"m-1"');
  });
});

describe("fleet log entries", () => {
  it("names the service, user and severity carried by the application payload", () => {
    expect(normalizeFleetLog(containerEntry({}, { level: 50, builderSlug: "ada", gatewayId: "shared-a", durationMs: 12 }))).toEqual({
      timestamp: "2026-11-10T11:59:58.000Z",
      severity: "ERROR",
      service: "api",
      instance: "octogee-api-7d9-abcde",
      gatewayId: "shared-a",
      user: "ada",
      message: "slow request",
      details: { durationMs: 12 },
    });
  });

  it("decodes a VM gateway's JSON line and its labels", () => {
    expect(normalizeFleetLog({
      insertId: "i-2",
      timestamp: "2026-11-10T11:59:58.000Z",
      resource: { type: "gce_instance", labels: { instance_id: "123" } },
      jsonPayload: {
        message: JSON.stringify({ msg: "gateway ready", level: 30 }),
        container: { metadata: { "ai.octogee.container": "octogee-gateway", "ai.octogee.gateway-id": "iso-ada", "ai.octogee.builder-slug": "ada" } },
      },
    })).toMatchObject({ severity: "INFO", service: "gateway", gatewayId: "iso-ada", user: "ada", message: "gateway ready" });
  });
});

describe("streaming fleet logs", () => {
  it("returns history oldest first within the window, keeping only matching entries", async () => {
    const { source, requests } = recordingSource([{ entries: [
      containerEntry({ insertId: "new", timestamp: "2026-11-10T11:59:59.000Z" }),
      containerEntry({ insertId: "quiet", severity: "DEBUG" }),
      containerEntry({ insertId: "old", timestamp: "2026-11-10T11:58:00.000Z" }),
    ] }]);
    const { entries, started } = await collect({ source, query: { follow: "false", level: "warn", since: "5m" } });
    expect(started).toBe(true);
    expect(entries.map((entry) => entry.timestamp)).toEqual(["2026-11-10T11:58:00.000Z", "2026-11-10T11:59:59.000Z"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ orderBy: "timestamp desc", pageSize: 1000 });
    expect(requests[0].filter).toContain('timestamp>="2026-11-10T11:55:00.000Z"');
  });

  it("reads every page of the window before writing, oldest first", async () => {
    const { source, requests } = recordingSource([
      { entries: [containerEntry({ insertId: "c", timestamp: "2026-11-10T11:59:50.000Z" }), containerEntry({ insertId: "quiet", severity: "DEBUG" })], nextPageToken: "p2" },
      { entries: [containerEntry({ insertId: "a", timestamp: "2026-11-10T11:59:10.000Z" })] },
    ]);
    const { entries } = await collect({ source, query: { follow: "false" } });
    expect(entries.map((entry) => entry.timestamp)).toEqual(["2026-11-10T11:59:10.000Z", "2026-11-10T11:59:50.000Z"]);
    expect(requests.map((request) => request.pageToken)).toEqual([undefined, "p2"]);
  });

  it("keeps the newest thousand matches and says older entries were not read", async () => {
    const page = Array.from({ length: 1_000 }, (_, index) => containerEntry({ insertId: `n-${index}` }, { index }));
    const { source, requests } = recordingSource([{ entries: page, nextPageToken: "p2" }]);
    const { entries } = await collect({ source, query: { follow: "false" } });
    expect(requests).toHaveLength(1);
    expect(entries).toHaveLength(1_001);
    expect(entries[0].details).toEqual({ index: 999 });
    expect(entries[1_000]).toMatchObject({ severity: "WARNING", service: "fleet", details: { truncated: true } });
  });

  it("stops reading a quiet window at its page limit and says so", async () => {
    const requests: LogEntriesRequest[] = [];
    const source: LogEntriesSource = {
      list: async (request) => {
        requests.push(request);
        return { entries: [containerEntry({ severity: "DEBUG" })], nextPageToken: "more" };
      },
    };
    const { entries } = await collect({ source, query: { follow: "false", level: "error" } });
    expect(requests).toHaveLength(20);
    expect(entries.map((entry) => entry.service)).toEqual(["fleet"]);
  });

  it("answers with an error when a later history page fails, before any output", async () => {
    let calls = 0;
    const source: LogEntriesSource = {
      list: async () => {
        calls += 1;
        if (calls === 2) throw new Error("permission denied");
        return { entries: [containerEntry()], nextPageToken: "p2" };
      },
    };
    let started = false;
    const written: FleetLogEntry[] = [];
    await expect(streamFleetLogs({
      source, namespace: "octogee-test", query: parseFleetLogsQuery({ follow: "false" }), signal: new AbortController().signal,
      now: () => NOW, sleep: async () => undefined, onStart: () => { started = true; }, write: async (entry) => { written.push(entry); },
    })).rejects.toThrow("permission denied");
    expect(started).toBe(false);
    expect(written).toEqual([]);
  });

  it("follows newly received entries once each, across overlapping polls", async () => {
    const first = containerEntry({ insertId: "a", receiveTimestamp: "2026-11-10T12:00:01.000Z" });
    const second = containerEntry({ insertId: "b", receiveTimestamp: "2026-11-10T12:00:02.000Z" });
    const { source, requests } = recordingSource([
      { entries: [first] },
      { entries: [first, second] },
    ]);
    const { entries } = await collect({ source, query: {}, polls: 2 });
    expect(entries.map((entry) => entry.message)).toEqual(["slow request", "slow request"]);
    expect(requests.map((request) => request.orderBy)).toEqual(["timestamp asc", "timestamp asc"]);
    expect(requests[0].filter).toContain('receiveTimestamp>="2026-11-10T11:59:50.000Z"');
    expect(requests[1].filter).toContain('receiveTimestamp>="2026-11-10T11:59:51.000Z"');
  });

  it("pages through a burst before waiting", async () => {
    const { source, requests } = recordingSource([
      { entries: [containerEntry({ insertId: "a" })], nextPageToken: "p2" },
      { entries: [containerEntry({ insertId: "b" })] },
    ]);
    const { entries } = await collect({ source, query: {}, polls: 1 });
    expect(entries).toHaveLength(2);
    expect(requests[1].pageToken).toBe("p2");
  });

  it("starts the response only after the first read succeeds", async () => {
    const source: LogEntriesSource = { list: async () => { throw new Error("permission denied"); } };
    let started = false;
    await expect(streamFleetLogs({
      source, namespace: "octogee-test", query: parseFleetLogsQuery({}), signal: new AbortController().signal,
      now: () => NOW, sleep: async () => undefined, onStart: () => { started = true; }, write: async () => undefined,
    })).rejects.toThrow("permission denied");
    expect(started).toBe(false);
  });
});
