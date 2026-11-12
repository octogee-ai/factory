import { beforeEach, describe, expect, it, vi } from "vitest";

import { internalFetch } from "../lib/internal-fetch.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));
vi.mock("@octogee/core/internal-fetch", () => ({
  gatewayCredentialHeaders: vi.fn(async () => ({
    "x-octogee-gateway-credential-token": "credential-token",
  })),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CURRENT_SNAPSHOT = {
  uid: "uid-alice",
  slug: "alice",
  contextTemplateKey: "default",
  planInputs: { subscription: { tier: "personal", status: "active" } },
  gatewayId: "walter",
  status: "complete",
  channels: [],
  projects: [],
};

const { contextTemplateKey: _contextTemplateKey, planInputs: _planInputs, ...withoutPlanFields } = CURRENT_SNAPSHOT;
const PREVIOUS_API_SNAPSHOT = {
  ...withoutPlanFields,
  tier: "personal",
  selectedTier: "personal",
  subscription: { tier: "personal", status: "active" },
};

describe("fleet broker user snapshot shape", () => {
  const client = () => createFleetBrokerClient("walter", "walter-r9");

  beforeEach(() => {
    vi.mocked(internalFetch).mockReset();
    delete process.env.FLEET_BROKER_URL;
    process.env.OCTOGEE_API_URL = "http://broker";
  });

  it("returns a snapshot that carries its plan inputs and context template key", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(jsonResponse({ user: CURRENT_SNAPSHOT }));

    await expect(client().userSnapshot("uid-alice")).resolves.toEqual(CURRENT_SNAPSHOT);
  });

  it("refuses a snapshot from an API that predates the plan input bag instead of treating the user as having no plan", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(jsonResponse({ user: PREVIOUS_API_SNAPSHOT }));

    await expect(client().userSnapshot("uid-alice")).rejects.toThrow(/planInputs/);
  });

  it("refuses the whole assigned-user roster when one snapshot predates the plan input bag", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(jsonResponse({ users: [CURRENT_SNAPSHOT, PREVIOUS_API_SNAPSHOT] }));

    await expect(client().assignedUsers()).rejects.toThrow(/planInputs/);
  });

  it.each([
    ["planInputs is not an object", { ...CURRENT_SNAPSHOT, planInputs: "personal" }],
    ["planInputs is an array", { ...CURRENT_SNAPSHOT, planInputs: [] }],
    ["planInputs is null", { ...CURRENT_SNAPSHOT, planInputs: null }],
    ["contextTemplateKey is empty", { ...CURRENT_SNAPSHOT, contextTemplateKey: "" }],
    ["contextTemplateKey is missing", { ...withoutPlanFields, planInputs: {} }],
  ])("refuses a snapshot whose %s", async (_label, snapshot) => {
    vi.mocked(internalFetch).mockResolvedValueOnce(jsonResponse({ user: snapshot }));

    await expect(client().userSnapshot("uid-alice")).rejects.toThrow(/planInputs|contextTemplateKey/);
  });

  it("returns every snapshot of a current roster unchanged", async () => {
    const roster = [CURRENT_SNAPSHOT, { ...CURRENT_SNAPSHOT, uid: "uid-bob", slug: "bob", planInputs: {} }];
    vi.mocked(internalFetch).mockResolvedValueOnce(jsonResponse({ users: roster }));

    await expect(client().assignedUsers()).resolves.toEqual(roster);
  });

  it("still reports an unassigned user as absent", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));

    await expect(client().userSnapshot("uid-gone")).resolves.toBeNull();
  });
});
