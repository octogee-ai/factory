import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  log: vi.fn(),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.doMock("./config.js", () => ({ log: h.log }));
  fetchMock.mockReset();
  h.log.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.DISCORD_OPS_WEBHOOK_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("./config.js");
  delete process.env.DISCORD_OPS_WEBHOOK_URL;
});

async function importNotifications() {
  return import("./notifications.js");
}

describe("ops notifications", () => {
  it("logs and skips Discord delivery when no webhook is configured", async () => {
    const { notifyNewSignup } = await importNotifications();

    await notifyNewSignup({ name: "Ada", email: "ada@example.test", tier: "trial", slug: "ada", uid: "uid-1" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("DISCORD_OPS_WEBHOOK_URL not set"));
  });

  it("posts signup notifications to the configured Discord webhook", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.test/webhook";
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { notifyNewSignup } = await importNotifications();

    await notifyNewSignup({ name: "", email: "", tier: "free", slug: "acme", uid: "uid-123456" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.test/webhook",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { content: string; username: string };
    expect(body.username).toBe("Octogee Ops");
    expect(body.content).toContain("**New Signup!**");
    expect(body.content).toContain("**Name:** (no name)");
    expect(body.content).toContain("**Email:** (no email)");
    expect(body.content).toContain("**UID:** `uid-123456`");
  });

  it("logs Discord webhook non-2xx responses and fetch errors", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.test/webhook";
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 500, statusText: "Server Error" }));
    const { notifyProvisioningError } = await importNotifications();

    await notifyProvisioningError("acme", "workspace failed");
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Discord webhook failed: 500 Server Error"));

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await notifyProvisioningError("acme", "workspace failed");
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Discord webhook error: network down"));
  });
});
