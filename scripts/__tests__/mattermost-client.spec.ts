import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logMock = vi.fn();
vi.mock("../lib/config.js", () => ({ log: logMock }));

beforeEach(async () => {
  process.env.MM_URL = "http://mm.test";
  process.env.MM_ADMIN_TOKEN = "test-token";
  logMock.mockClear();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.MM_URL;
  delete process.env.MM_ADMIN_TOKEN;
  vi.restoreAllMocks();
});

describe("mmApiCall — error log routing", () => {
  it("logs an explicit warning on an unknown 5xx error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('{"id":"unknown.error","message":"oops"}'),
    } as Response);

    const { mmApiCall } = await import("../lib/mattermost/client.js");
    const result = await mmApiCall("POST", "/channels", { name: "test" });

    expect(result).toBeNull();
    expect(logMock).toHaveBeenCalledTimes(1);
    const line = logMock.mock.calls[0][0] as string;
    expect(line.startsWith("⚠ ")).toBe(true);
    expect(line).toContain("API 500");
  });

  it("demotes channel-already-exists to an info-level idempotent log (no ⚠)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          '{"id":"store.sql_channel.save_channel.exists.app_error","message":"A channel with that name already exists on the same team."}',
        ),
    } as Response);

    const { mmApiCall } = await import("../lib/mattermost/client.js");
    const result = await mmApiCall("POST", "/channels", { name: "general" });

    expect(result).toBeNull();
    expect(logMock).toHaveBeenCalledTimes(1);
    const line = logMock.mock.calls[0][0] as string;
    expect(line.startsWith("⚠ ")).toBe(false);
    expect(line).toContain("API 400");
    expect(line).toContain("idempotent");
  });

  it("still logs ⚠ for a 4xx that is not a known idempotent error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          '{"id":"api.channel.create_direct_channel.permissions.app_error","message":"You do not have permission"}',
        ),
    } as Response);

    const { mmApiCall } = await import("../lib/mattermost/client.js");
    const result = await mmApiCall("POST", "/channels", { name: "x" });

    expect(result).toBeNull();
    expect(logMock).toHaveBeenCalledTimes(1);
    const line = logMock.mock.calls[0][0] as string;
    expect(line.startsWith("⚠ ")).toBe(true);
  });

  it("returns parsed JSON without logging on 2xx success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "ch-1" }),
    } as Response);

    const { mmApiCall } = await import("../lib/mattermost/client.js");
    const result = await mmApiCall("POST", "/channels", { name: "ok" });

    expect(result).toEqual({ id: "ch-1" });
    expect(logMock).not.toHaveBeenCalled();
  });
});
