import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceLogger, withLogContext } from "./service-logger.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function capture() {
  const lines: string[] = [];
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(line => { lines.push(String(line)); });
  return lines;
}

describe("service logging contract", () => {
  it("emits one JSON record with identity, UTC time, severity and no terminal decoration", () => {
    const lines = capture();
    vi.stubEnv("GATEWAY_ID", "shared-a");
    createServiceLogger("provisioner").info("Target ready", { builderSlug: "alice", category: "migration", status: "done" });
    expect(JSON.parse(lines[0])).toMatchObject({ severity: "INFO", service: "provisioner", gatewayId: "shared-a", message: "Target ready", builderSlug: "alice", category: "migration", status: "done" });
    expect(JSON.parse(lines[0]).timestamp).toMatch(/^\d{4}-.*Z$/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\u001b");
  });
  it("keeps concurrent Builder contexts isolated and carries them across async work", async () => {
    const lines = capture();
    const log = createServiceLogger("api");
    await Promise.all(["alice", "bob"].map(builderSlug => withLogContext({ builderSlug }, async () => {
      await Promise.resolve();
      log.info(`work for ${builderSlug}`);
    })));
    expect(lines.map(line => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({ builderSlug: "alice", message: "work for alice" }),
      expect.objectContaining({ builderSlug: "bob", message: "work for bob" }),
    ]));
    log.info("shared work");
    expect(JSON.parse(lines[2]).builderSlug).toBeUndefined();
  });
  it("serializes nested errors and redacts credentials without losing the cause", () => {
    const lines = capture();
    const err = Object.assign(new Error("Authorization: Bearer topsecret1234567890"), { credential: "topsecret1234567890", code: "UNAVAILABLE" });
    createServiceLogger("api").error("Request failed", { context: { err } });
    const row = JSON.parse(lines[0]);
    expect(row.context.err).toMatchObject({ name: "Error", message: "Authorization: Bearer [redacted]", credential: "[redacted]", code: "UNAVAILABLE" });
    expect(row.context.err.stack).toBeTypeOf("string");
  });
  it("prevents metadata from overriding the service, message, timestamp, and severity", () => {
    const lines = capture();
    createServiceLogger("api").error("real failure", { service: "fake", severity: "INFO", timestamp: "fake", message: "fake" });
    expect(JSON.parse(lines[0])).toMatchObject({ service: "api", severity: "ERROR", message: "real failure" });
    expect(JSON.parse(lines[0]).timestamp).not.toBe("fake");
  });
  it("preserves long operational identities while redacting credentials", () => {
    const lines = capture();
    const operationId = "mig-placement-9c0d0bb72a5b3330e28eb4c448c0e0d8";
    createServiceLogger("provisioner").info("Migration started", { operationId, token: "secret" });
    expect(JSON.parse(lines[0])).toMatchObject({ operationId, token: "[redacted]" });
  });
  it("preserves critical severity for fatal disruption events", () => {
    const lines = capture();
    createServiceLogger("cowboy").fatal("Gateway disruption observed");
    expect(JSON.parse(lines[0])).toMatchObject({ severity: "CRITICAL", service: "cowboy" });
  });
  it("honors LOG_LEVEL and preserves actual warning severity", () => {
    const lines = capture();
    vi.stubEnv("LOG_LEVEL", "warn");
    const log = createServiceLogger("cowboy");
    log.debug("debug"); log.info("info"); log.warn("warning"); log.error("error");
    expect(lines.map(line => JSON.parse(line).severity)).toEqual(["WARNING", "ERROR"]);
  });
});

