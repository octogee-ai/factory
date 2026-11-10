import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { addAdminLogsRoutes } from "./admin-logs-router.js";
import type { LogEntriesSource } from "./fleet-logs.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");

function entry(insertId: string, message: string) {
  return {
    insertId,
    timestamp: "2026-11-10T11:59:58.000Z",
    receiveTimestamp: "2026-11-10T11:59:59.000Z",
    severity: "WARNING",
    resource: { type: "k8s_container", labels: { container_name: "octogee-api", pod_name: "octogee-api-1" } },
    jsonPayload: { message },
  };
}

function logsApp(source: LogEntriesSource | null) {
  const warn = vi.fn();
  const app = express();
  const router = express.Router();
  addAdminLogsRoutes(router, {
    source,
    namespace: "octogee-test",
    logger: { warn },
    now: () => NOW,
    sleep: async () => undefined,
  });
  app.use(router);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return { app, warn };
}

describe("admin logs route", () => {
  it("streams matching history as newline-delimited JSON", async () => {
    const source: LogEntriesSource = { list: async () => ({ entries: [entry("b", "second"), entry("a", "first")] }) };
    const res = await request(logsApp(source).app).get("/logs?follow=false").expect(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const lines = res.text.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.message)).toEqual(["first", "second"]);
    expect(lines[0]).toMatchObject({ severity: "WARNING", service: "api" });
  });

  it("refuses a malformed query before reading any logs", async () => {
    const list = vi.fn();
    const res = await request(logsApp({ list }).app).get("/logs?since=2h").expect(400);
    expect(res.body.error).toContain("since");
    expect(list).not.toHaveBeenCalled();
  });

  it("says so when the environment has no log source", async () => {
    const res = await request(logsApp(null).app).get("/logs").expect(503);
    expect(res.body.error).toContain("not configured");
  });

  it("returns an error status when the first read fails", async () => {
    const source: LogEntriesSource = { list: async () => { throw new Error("permission denied"); } };
    const res = await request(logsApp(source).app).get("/logs").expect(500);
    expect(res.body.error).toBe("permission denied");
  });

  it("logs and cuts the stream when a later read fails", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ entries: [entry("a", "first")] })
      .mockRejectedValueOnce(new Error("quota exceeded"));
    const { app, warn } = logsApp({ list });
    await expect(request(app).get("/logs")).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith("fleet log stream failed", { error: "quota exceeded" });
  });
});
