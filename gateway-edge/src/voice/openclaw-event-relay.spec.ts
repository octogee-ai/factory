import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrainEvent } from "./brain.js";
import { VOICE_EVENT_RELAY_PATH, createOpenClawVoiceEventRelay } from "./openclaw-event-relay.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function relayServer(token = "gateway-token") {
  const relay = createOpenClawVoiceEventRelay({ gatewayToken: token });
  const server = http.createServer((req, res) => {
    if (req.url === VOICE_EVENT_RELAY_PATH) {
      void relay.handle(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    relay,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}${VOICE_EVENT_RELAY_PATH}`,
  };
}

function agent(runId: string, sessionKey: string): BrainEvent {
  return {
    kind: "agent",
    runId,
    stream: "lifecycle",
    ts: 1,
    sessionKey,
    data: { phase: "start" },
  };
}

async function publish(url: string, token: string, agentId: string, event: BrainEvent): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ schemaVersion: 1, agentId, event }),
  });
}

describe("OpenClaw voice event relay", () => {
  it("tracks an authenticated plugin heartbeat per agent", async () => {
    const { relay, url } = await relayServer();

    expect(relay.readiness("mom-coach")).toEqual({ ready: false });
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer gateway-token", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, agentId: "mom-coach", kind: "ready", ts: 1 }),
    });

    expect(response.status).toBe(202);
    expect(relay.readiness("mom-coach")).toEqual({ ready: true });
    expect(relay.readiness("dad-coach")).toEqual({ ready: false });
  });

  it("relays both group and direct-message session identity only to the owning agent", async () => {
    const { relay, url } = await relayServer();
    const mom: BrainEvent[] = [];
    const dad: BrainEvent[] = [];
    relay.source("mom-coach").subscribe((event) => mom.push(event));
    relay.source("dad-coach").subscribe((event) => dad.push(event));

    expect((await publish(url, "gateway-token", "mom-coach", agent("run-group", "agent:mom-coach:mattermost:channel:group-1"))).status).toBe(202);
    expect((await publish(url, "gateway-token", "mom-coach", agent("run-dm", "agent:mom-coach:mattermost:user:builder-1"))).status).toBe(202);

    expect(mom).toEqual([
      agent("run-group", "agent:mom-coach:mattermost:channel:group-1"),
      agent("run-dm", "agent:mom-coach:mattermost:user:builder-1"),
    ]);
    expect(dad).toEqual([]);
  });

  it("rejects non-loopback credentials and malformed events without fanout", async () => {
    const { relay, url } = await relayServer();
    const events: BrainEvent[] = [];
    relay.source("mom-coach").subscribe((event) => events.push(event));

    expect((await publish(url, "wrong", "mom-coach", agent("run-1", "agent:mom-coach:mattermost:channel:group-1"))).status).toBe(401);
    const malformed = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer gateway-token", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, agentId: "mom-coach", event: { kind: "agent" } }),
    });
    expect(malformed.status).toBe(422);
    expect(events).toEqual([]);
  });

  it("drops a disconnected subscriber without affecting another Talk session for the same agent", () => {
    const relay = createOpenClawVoiceEventRelay({ gatewayToken: "gateway-token" });
    const first: BrainEvent[] = [];
    const second: BrainEvent[] = [];
    const stopFirst = relay.source("mom-coach").subscribe((event) => first.push(event));
    relay.source("mom-coach").subscribe((event) => second.push(event));

    stopFirst();
    relay.publish({ schemaVersion: 1, agentId: "mom-coach", event: agent("run-1", "agent:mom-coach:mattermost:channel:group-1") });

    expect(first).toEqual([]);
    expect(second).toEqual([agent("run-1", "agent:mom-coach:mattermost:channel:group-1")]);
  });

  it("isolates a failing Talk subscriber and accepts a finite event timestamp", () => {
    const log = vi.fn();
    const relay = createOpenClawVoiceEventRelay({ gatewayToken: "gateway-token", log });
    const delivered: BrainEvent[] = [];
    relay.source("mom-coach").subscribe(() => { throw new Error("session closed"); });
    relay.source("mom-coach").subscribe((event) => delivered.push(event));

    relay.publish({ schemaVersion: 1, agentId: "mom-coach", event: agent("run-1", "agent:mom-coach:mattermost:channel:group-1") });

    expect(delivered).toEqual([agent("run-1", "agent:mom-coach:mattermost:channel:group-1")]);
    expect(log).toHaveBeenCalledWith("voice relay subscriber failed", { agentId: "mom-coach", error: "session closed" });
  });
});
