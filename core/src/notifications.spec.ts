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
    const { sendOpsAlert } = await importNotifications();

    await sendOpsAlert("gateway shared-1 is degraded");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("DISCORD_OPS_WEBHOOK_URL not set"));
  });

  it("posts an alert's content unchanged to the configured Discord webhook", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.test/webhook";
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { sendOpsAlert } = await importNotifications();

    await sendOpsAlert("gateway shared-1 is degraded");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.test/webhook",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { content: string; username: string };
    expect(body).toEqual({ content: "gateway shared-1 is degraded", username: "Octogee Ops" });
  });

  it("names the user and the error in a provisioning alert", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.test/webhook";
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { notifyProvisioningError } = await importNotifications();

    await notifyProvisioningError("acme", "workspace failed");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { content: string };
    expect(body.content).toBe("⚠️ **Provisioning Error**\n**Slug:** acme\n**Error:** workspace failed");
  });

  it("logs an alert the webhook refused or never received as failed, so it is written at error", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.test/webhook";
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 500, statusText: "Server Error" }));
    const { notifyProvisioningError } = await importNotifications();

    await notifyProvisioningError("acme", "workspace failed");
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining("Discord webhook failed: 500 Server Error"),
      { status: "failed" },
    );

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await notifyProvisioningError("acme", "workspace failed");
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining("Discord webhook error: network down"),
      { status: "failed" },
    );
  });

  it("does not log a delivered alert or an unconfigured webhook as failed", async () => {
    const { sendOpsAlert } = await importNotifications();
    await sendOpsAlert("gateway shared-1 is degraded");

    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.test/webhook";
    vi.resetModules();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const configured = await importNotifications();
    await configured.sendOpsAlert("gateway shared-1 is degraded");

    expect(h.log.mock.calls.filter(([, fields]) => fields?.status === "failed")).toEqual([]);
  });
});
