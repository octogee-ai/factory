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
  describe("long identifiers", () => {
    const hexId = "c".repeat(20) + "0".repeat(20);
    const mixedId = "mig-placement-9c0d0bb72a5b3330e28eb4c448c0e0d8-attempt-1";

    afterEach(() => { delete process.env.LOG_KEEP_LONG_IDENTIFIERS; });

    it("redacts long unlabeled values by default", () => {
      const lines = capture();
      createServiceLogger("provisioner").info(`commit ${hexId}`, { revision: hexId, attempt: mixedId });
      const row = JSON.parse(lines[0]);
      expect(row.message).toBe("commit [redacted]");
      expect(row).toMatchObject({ revision: "[redacted]", attempt: "[redacted]" });
    });

    it("keeps them when the operator opts in", () => {
      process.env.LOG_KEEP_LONG_IDENTIFIERS = "true";
      const lines = capture();
      createServiceLogger("provisioner").info(`commit ${hexId}`, { revision: hexId, nested: [{ attempt: mixedId }] });
      const row = JSON.parse(lines[0]);
      expect(row.message).toBe(`commit ${hexId}`);
      expect(row).toMatchObject({ revision: hexId, nested: [{ attempt: mixedId }] });
    });

    it("still redacts recognizable credentials when the operator opts in", () => {
      process.env.LOG_KEEP_LONG_IDENTIFIERS = "true";
      const lines = capture();
      createServiceLogger("provisioner").info("Authorization: Bearer abcdefghijklmnop", {
        token: hexId, detail: "sk-ant-abcdefghijklmnop1234", header: "password=hunter2-hunter2",
      });
      const row = JSON.parse(lines[0]);
      expect(row.message).toBe("Authorization: Bearer [redacted]");
      expect(row).toMatchObject({ token: "[redacted]", detail: "[redacted]", header: "password=[redacted]" });
    });

    it.each([
      [`token=${hexId}`, "token=[redacted]"],
      [`Token: ${hexId}`, "Token: [redacted]"],
      [`{"token":"${hexId}"}`, '{"token":"[redacted]"}'],
      [`{\\"gitea_token\\":\\"${hexId}\\"}`, '{\\"gitea_token\\":\\"[redacted]\\"}'],
      [`Authorization: token ${hexId}`, "Authorization: token [redacted]"],
      [`https://oauth2:${hexId}@git.example/x.git`, "https://oauth2:[redacted]@git.example/x.git"],
      [`postgres://app:${hexId}@db:5432/x`, "postgres://app:[redacted]@db:5432/x"],
      [`/hook?secret=${hexId}&a=1`, "/hook?secret=[redacted]&a=1"],
      [`X-Goog-Signature=${hexId}`, "X-Goog-Signature=[redacted]"],
      [`{"Cookie":"session=${hexId}"}`, '{"Cookie":"[redacted]"}'],
      [`{\\"Set-Cookie\\":\\"session=${hexId}; Path=/\\"}`, '{\\"Set-Cookie\\":\\"[redacted]\\"}'],
      [`{"set-cookie":["a=${hexId}","b=${hexId}"]}`, '{"set-cookie":[redacted]}'],
      [`{"set-cookie":["a=${hexId}","b=${hexId}`, '{"set-cookie":[redacted]'],
      [`{"credential":"${hexId}"}`, '{"credential":"[redacted]"}'],
      [`{"private_key":"${hexId}"}`, '{"private_key":"[redacted]"}'],
    ])("redacts the credential in %s when the operator opts in", (message, expected) => {
      process.env.LOG_KEEP_LONG_IDENTIFIERS = "true";
      const lines = capture();
      createServiceLogger("provisioner").error(message, { nested: { cause: message } });
      const row = JSON.parse(lines[0]);
      expect(row.message).toBe(expected);
      expect(row.nested.cause).toBe(expected);
    });

    it.each([
      `sourceSha=${hexId}`,
      `operationId=${mixedId}`,
      "token: expired",
      `tokenCount=${"1".repeat(24)}`,
    ])("keeps %s when the operator opts in", (message) => {
      process.env.LOG_KEEP_LONG_IDENTIFIERS = "true";
      const lines = capture();
      createServiceLogger("provisioner").info(message);
      expect(JSON.parse(lines[0]).message).toBe(message);
    });

    it("only accepts the exact opt-in value", () => {
      process.env.LOG_KEEP_LONG_IDENTIFIERS = "1";
      const lines = capture();
      createServiceLogger("provisioner").info(`commit ${hexId}`);
      expect(JSON.parse(lines[0]).message).toBe("commit [redacted]");
    });
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

