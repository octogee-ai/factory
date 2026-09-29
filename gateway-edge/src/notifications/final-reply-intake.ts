import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ReplyBindingDeniedError, type NativeFinalReply } from "./native-final-reply.js";

const MAX_BODY_BYTES = 16 * 1024;
const FIELDS = new Set(["schemaVersion", "accountId", "sessionKey", "to", "messageId"]);

function parseFinalReply(value: unknown): NativeFinalReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !FIELDS.has(key)) || body.schemaVersion !== 1
    || typeof body.accountId !== "string" || !/^[a-z0-9-]{1,128}$/u.test(body.accountId)
    || typeof body.sessionKey !== "string" || body.sessionKey.length > 512 || !body.sessionKey
    || typeof body.to !== "string" || !/^(?:channel|user):[a-z0-9]{26}$/u.test(body.to)
    || typeof body.messageId !== "string" || !/^[a-z0-9]{26}$/u.test(body.messageId)) return null;
  return { schemaVersion: 1, accountId: body.accountId, sessionKey: body.sessionKey,
    to: body.to, messageId: body.messageId };
}

function authorized(req: IncomingMessage, token: string): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/u, "");
  if (address !== "127.0.0.1" && address !== "::1") return false;
  const header = req.headers.authorization;
  const actual = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createFinalReplyIntakeHandler(params: {
  gatewayToken: string;
  notify(input: NativeFinalReply): Promise<void>;
  log(message: string, fields: Record<string, unknown>): void;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const token = params.gatewayToken.trim();
  if (!token) throw new Error("final reply relay token is required");
  return async (req, res) => {
    if (req.method !== "POST") {
      req.resume();
      respond(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!authorized(req, token)) {
      req.resume();
      respond(res, 401, { error: "unauthorized" });
      return;
    }
    let input: NativeFinalReply | null;
    try {
      input = parseFinalReply(await readJson(req));
    } catch (error) {
      const oversized = error instanceof Error && error.message === "body_too_large";
      respond(res, oversized ? 413 : 422, { error: oversized ? "body_too_large" : "invalid_json" });
      return;
    }
    if (!input) {
      respond(res, 422, { error: "invalid_final_reply" });
      return;
    }
    try {
      await params.notify(input);
      respond(res, 202, { accepted: true });
    } catch (error) {
      if (error instanceof ReplyBindingDeniedError) {
        respond(res, 403, { error: "reply_binding_denied" });
        return;
      }
      params.log("notification failed", { messageId: input.messageId,
        error: error instanceof Error ? error.message : String(error) });
      respond(res, 503, { error: "reply_notification_unavailable", retryable: true });
    }
  };
}
