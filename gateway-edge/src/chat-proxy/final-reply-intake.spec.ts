import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createFinalReplyIntakeHandler } from "./final-reply-intake.js";
import { ReplyBindingDeniedError } from "@octogee/core/native-final-reply";

const body = { schemaVersion: 1, accountId: "alice-coach",
  sessionKey: `agent:octogee-alice-coach:mattermost:channel:${"c".repeat(26)}`,
  to: `channel:${"c".repeat(26)}`, messageId: "m".repeat(26) };

async function request(options: {
  token?: string; remoteAddress?: string; method?: string; body?: unknown; raw?: string;
  notify?: (input: any) => Promise<void>;
} = {}) {
  const notify = vi.fn(options.notify ?? (async () => undefined));
  const log = vi.fn();
  const req = Readable.from([options.raw ?? JSON.stringify(options.body ?? body)]) as IncomingMessage;
  Object.assign(req, { method: options.method ?? "POST", headers: { authorization: options.token ?? "Bearer relay-token" },
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" } });
  let status = 0;
  let response = "";
  const res = { writeHead: (code: number) => { status = code; }, end: (value: string) => { response = value; } };
  await createFinalReplyIntakeHandler({ gatewayToken: "relay-token", notify, log })(req, res as ServerResponse);
  return { status, body: JSON.parse(response), notify, log };
}

describe("native final reply local intake", () => {
  it("acknowledges only after the authenticated final reply reaches notification fanout", async () => {
    const r = await request();
    expect(r.status).toBe(202);
    expect(r.notify).toHaveBeenCalledExactlyOnceWith(body);
  });

  it.each([{ token: "Bearer wrong" }, { token: "" }, { remoteAddress: "10.0.0.3" }])(
    "rejects untrusted callers %j before notification", async options => {
      const r = await request(options);
      expect(r.status).toBe(401);
      expect(r.notify).not.toHaveBeenCalled();
    },
  );

  it("rejects non-POST requests", async () => {
    const r = await request({ method: "GET" });
    expect(r.status).toBe(405);
    expect(r.notify).not.toHaveBeenCalled();
  });

  it.each([{ ...body, messageId: "bad/id" }, { ...body, content: "untrusted text" },
    { ...body, schemaVersion: 2 }, { ...body, accountId: "" }, { ...body, sessionKey: "x".repeat(513) }])(
    "rejects malformed or expanded contracts %j", async input => {
      const r = await request({ body: input });
      expect(r.status).toBe(422);
      expect(r.notify).not.toHaveBeenCalled();
    },
  );

  it("bounds request size and rejects invalid JSON", async () => {
    expect((await request({ raw: "x".repeat(16_385) })).status).toBe(413);
    expect((await request({ raw: "{" })).status).toBe(422);
  });

  it("returns an explicit denial for a foreign agent or recipient binding", async () => {
    const r = await request({ notify: async () => { throw new ReplyBindingDeniedError(); } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("reply_binding_denied");
  });

  it("logs upstream failures and returns a retryable status without echoing provider text", async () => {
    const r = await request({ notify: async () => { throw new Error("provider unavailable"); } });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("reply_notification_unavailable");
    expect(r.log).toHaveBeenCalledWith("notification failed", expect.objectContaining({ error: "provider unavailable" }));
  });
});
