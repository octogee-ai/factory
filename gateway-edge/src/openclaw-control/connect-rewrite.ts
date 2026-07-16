import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function challengeNonce(frame: unknown): string | null {
  const item = record(frame);
  const payload = record(item?.payload);
  return item?.type === "event" && item.event === "connect.challenge" &&
    typeof payload?.nonce === "string" && payload.nonce.length > 0
    ? payload.nonce
    : null;
}

export function rewriteTrustedOpenClawConnect(args: {
  frame: unknown;
  nonce: string;
  gatewayToken: string;
  platform?: string;
}): string | null {
  const request = record(args.frame);
  if (request?.type !== "req" || request.method !== "connect" ||
    typeof request.id !== "string" || request.id.length === 0 || !args.nonce) return null;
  return JSON.stringify({
    type: "req",
    id: request.id,
    method: "connect",
    params: {
      minProtocol: OPENCLAW_PROTOCOL_VERSION,
      maxProtocol: OPENCLAW_PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "octogee-control-ui",
        version: "1.0.0",
        platform: args.platform ?? process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin"],
      auth: { token: args.gatewayToken },
    },
  });
}

function scrub(value: unknown, credentials: readonly string[]): unknown {
  if (typeof value === "string") {
    return credentials.reduce(
      (text, credential) => credential ? text.replaceAll(credential, "[redacted]") : text,
      value,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, credentials));
  const item = record(value);
  if (!item) return value;
  return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, scrub(entry, credentials)]));
}

export function sanitizeOpenClawControlServerFrame(
  frame: unknown,
  credentials: readonly string[] = [],
): string {
  const cleaned = scrub(structuredClone(frame), credentials);
  const item = record(cleaned);
  const payload = record(item?.payload);
  if (payload?.type === "hello-ok") delete payload.auth;
  return JSON.stringify(cleaned);
}
