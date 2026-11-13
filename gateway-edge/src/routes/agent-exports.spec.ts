import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createAgentExportsRouter } from "./agent-exports.js";
vi.mock("../lib/agent-export-runtime.js", () => ({ createAgentExportRuntime: vi.fn() }));
function harness(error: Error, route = "apply") {
  const apply = vi.fn().mockRejectedValue(error);
  const runtime = { service: { preview: vi.fn(), apply }, agents: vi.fn(), repos: vi.fn().mockRejectedValue(error), latest: vi.fn() };
  const app = express(); app.use(express.json());
  app.use("/api/g/:gatewayId/agent-exports", createAgentExportsRouter({ createRuntime: () => runtime, localGatewayId: () => "shared-a" }));
  if (route === "repos") return request(app).get("/api/g/shared-a/agent-exports/repos").set("Authorization", "Bearer synthetic");
  return request(app).post("/api/g/shared-a/agent-exports/export-one/apply").set("Authorization", "Bearer synthetic").send({ approvalHash: "a".repeat(64) });
}
describe("authored export errors", () => {
  it("preserves disconnected GitHub status and safe guidance for the actual repo route", async () => {
    const result = await harness(Object.assign(new Error("private broker details"), { status: 422, code: "github_not_connected" }), "repos");
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: "github_not_connected", message: "Connect GitHub in Connections, then choose your repository." });
  });
  it("does not treat arbitrary upstream422 responses as disconnected GitHub", async () => {
    const result = await harness(Object.assign(new Error("private broker details"), { status: 422, code: "unrecognized" }), "repos");
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain("private broker details");
  });
  it.each(["authored export source content changed; preview again", "destination changed; preview again"])("returns actionable JSON for %s", async message => {
    const result = await harness(new Error(message));
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "export_preview_changed", message: expect.stringContaining("preview") });
  });
  it("keeps a timed-out publication explicitly unconfirmed and retryable", async () => {
    const result = await harness(Object.assign(new Error("private timeout details"), { code: "export_unconfirmed" }));
    expect(result.status).toBe(504);
    expect(result.body).toEqual({ error: "export_unconfirmed", message: "Export is not confirmed. Check or retry this export to read its publication receipt." });
  });
  it("never exposes an upstream response or credential", async () => {
    const result = await harness(new Error("GitHub API 500 synthetic-secret"));
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain("synthetic-secret");
    expect(result.body.message).toContain("retry");
  });
});
