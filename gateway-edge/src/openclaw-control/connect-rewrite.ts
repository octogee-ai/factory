import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import { signConnectDevice, type DeviceIdentity } from "@octogee/shared/types/device-identity";
import {
  OPENCLAW_CONTROL_UI_CLIENT_ID,
  OPENCLAW_CONTROL_UI_CLIENT_MODE,
} from "@octogee/shared/types/openclaw-proxy-identity";

const OPERATOR_BUILDER_DASHBOARD_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
] as const;

export type OpenClawConnectIdentity =
  | { mode: "shared-operator"; gatewayToken: string }
  | { mode: "per-user"; device: DeviceIdentity; scopes: string[] };

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

function connectAuthority(
  identity: OpenClawConnectIdentity,
  nonce: string,
  platform: string,
): Record<string, unknown> {
  const shared = { displayName: "octogee-control-ui", version: "1.0.0", platform };
  if (identity.mode === "shared-operator") {
    return {
      client: { id: "gateway-client", mode: "backend", ...shared },
      scopes: [...OPERATOR_BUILDER_DASHBOARD_SCOPES],
      auth: { token: identity.gatewayToken },
    };
  }
  const client = { id: OPENCLAW_CONTROL_UI_CLIENT_ID, mode: OPENCLAW_CONTROL_UI_CLIENT_MODE, ...shared };
  return {
    client,
    scopes: [...identity.scopes],
    device: signConnectDevice({
      identity: identity.device,
      clientId: client.id,
      clientMode: client.mode,
      role: "operator",
      scopes: identity.scopes,
      nonce,
      token: null,
      platform,
    }),
  };
}

export function rewriteTrustedOpenClawConnect(args: {
  frame: unknown;
  nonce: string;
  identity: OpenClawConnectIdentity;
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
      role: "operator",
      ...connectAuthority(args.identity, args.nonce, args.platform ?? process.platform),
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
  if (payload?.type === "hello-ok") {
    const auth = record(payload.auth);
    const scopes = Array.isArray(auth?.scopes) && auth.scopes.every((scope) =>
      typeof scope === "string" && scope.length > 0 && scope.length <= 128
    )
      ? auth.scopes
      : null;
    if (auth?.role === "operator" && scopes) {
      payload.auth = { role: "operator", scopes };
    } else {
      delete payload.auth;
    }
  }
  return JSON.stringify(cleaned);
}
