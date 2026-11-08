import { describe, expect, it } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import { recordRevisionSystemConfigStatus } from "./revision-system-config-status.js";

const runtime = {
  docKind: "runtime",
  gatewayId: "bender",
  release: 7,
  lifecycle: "serving",
  heartbeat: { status: "ready", mountedCustomers: ["bender"], lastHeartbeatAt: 1_000 },
};

describe("gateway system config status telemetry", () => {
  it("updates the matching stable runtime heartbeat", async () => {
    const documents = new Map<string, Record<string, unknown>>([["glmGateways/bender", runtime]]);

    await expect(recordRevisionSystemConfigStatus(createDocumentFixtureStore(documents), {
      gatewayId: "bender",
      revisionId: "bender",
      status: { state: "clean", acceptedCommit: "a".repeat(40) },
    })).resolves.toBe(true);
    expect(documents.get("glmGateways/bender")?.heartbeat).toEqual({
      status: "ready",
      mountedCustomers: ["bender"],
      lastHeartbeatAt: 1_000,
      configStatus: { state: "clean", acceptedCommit: "a".repeat(40), observedAt: { serverNow: true } },
    });
  });

  it("refuses a revision that is not the gateway or a document that is not its runtime record", async () => {
    const legacy = { docKind: "revision", gateway: "other", revisionId: "bender-r7" };
    const documents = new Map<string, Record<string, unknown>>([["glmGateways/bender", legacy]]);
    const store = createDocumentFixtureStore(documents);

    await expect(recordRevisionSystemConfigStatus(store, {
      gatewayId: "bender",
      revisionId: "bender",
      status: { state: "error" },
    })).resolves.toBe(false);
    await expect(recordRevisionSystemConfigStatus(createDocumentFixtureStore({ "glmGateways/bender": runtime }), {
      gatewayId: "bender",
      revisionId: "bender-r7",
      status: { state: "error" },
    })).resolves.toBe(false);
    expect(documents.get("glmGateways/bender")).toEqual(legacy);
  });

  it("fails closed on a runtime record stored under another gateway", async () => {
    const store = createDocumentFixtureStore({ "glmGateways/bender": { ...runtime, gatewayId: "other" } });

    await expect(recordRevisionSystemConfigStatus(store, {
      gatewayId: "bender",
      revisionId: "bender",
      status: { state: "error" },
    })).rejects.toBeInstanceOf(MalformedRecordError);
  });
});
