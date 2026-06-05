import { coachAgentId } from "../../../scripts/lib/byosub-onboarding.js";
import { isValidGatewayId } from "../../../shared/types/glm.js";
import { internalFetch } from "./internal-fetch.js";

export { coachAgentId };

export function byosubSecretName(uid: string, provider: string): string {
  return `byosub-${uid}-${provider}`;
}

export function isSafeGatewayId(id: unknown): id is string {
  return isValidGatewayId(id);
}

const MAX_CREDENTIAL_BYTES = 32_768;

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

export function validateCodexCredential(
  raw: string,
): { ok: true } | { ok: false; reason: string } {
  if (!raw || !raw.trim()) return { ok: false, reason: "empty payload" };
  if (raw.length > MAX_CREDENTIAL_BYTES) {
    return { ok: false, reason: "payload too large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const o = parsed as Record<string, unknown>;
  if (!nonEmptyString(o.auth_mode)) {
    return { ok: false, reason: "missing auth_mode" };
  }
  if (!o.tokens || typeof o.tokens !== "object") {
    return { ok: false, reason: "missing tokens object" };
  }
  const t = o.tokens as Record<string, unknown>;
  if (!nonEmptyString(t.access_token)) {
    return { ok: false, reason: "missing tokens.access_token" };
  }
  if (!nonEmptyString(t.refresh_token)) {
    return { ok: false, reason: "missing tokens.refresh_token" };
  }
  return { ok: true };
}

export type ByosubStatus = "connected" | "needs_reauth";
export interface ByosubConnectionView {
  connected: boolean;
  provider?: string;
  status?: ByosubStatus;
}

export function byosubConnectionView(
  ref: { provider?: unknown; status?: unknown } | null | undefined,
): ByosubConnectionView {
  if (!ref || typeof ref.provider !== "string" || !ref.provider) {
    return { connected: false };
  }
  const status: ByosubStatus =
    ref.status === "needs_reauth" ? "needs_reauth" : "connected";
  return { connected: status === "connected", provider: ref.provider, status };
}

export interface DeviceAuthStart {
  flowId: string;
  verificationUrl: string;
  userCode: string;
  expiresInMinutes: number | null;
}
export interface DeviceAuthStatus {
  state: string;
  expiresInMinutes?: number;
}
export interface GatewayDeviceAuthClient {
  start(args: { gatewayId: string; agentId: string }): Promise<DeviceAuthStart>;
  status(args: { gatewayId: string; flowId: string }): Promise<DeviceAuthStatus>;
}

export function gatewayDeviceAuthClient(): GatewayDeviceAuthClient {
  const key = process.env.INTERNAL_SERVICE_KEY ?? "";
  const ns = process.env.K8S_NAMESPACE ?? "octogee";
  const base = (gatewayId: string): string =>
    process.env.GATEWAY_INTERNAL_URL_TEMPLATE
      ? process.env.GATEWAY_INTERNAL_URL_TEMPLATE.replace(
          "{gatewayId}",
          gatewayId,
        )
      : `http://octogee-gateway-${gatewayId}.${ns}.svc.cluster.local:3003`;
  async function call<T>(url: string, init: RequestInit): Promise<T> {
    const r = await internalFetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    }, {
      internalServiceKey: key,
    });
    if (!r.ok) {
      throw new Error(`gateway ${r.status} ${await r.text().catch(() => "")}`);
    }
    return (await r.json()) as T;
  }
  return {
    start: ({ gatewayId, agentId }) =>
      call(`${base(gatewayId)}/internal/byosub/device-auth/start`, {
        method: "POST",
        body: JSON.stringify({ agentId }),
      }),
    status: ({ gatewayId, flowId }) =>
      call(
        `${base(gatewayId)}/internal/byosub/device-auth/status/${encodeURIComponent(flowId)}`,
        { method: "GET" },
      ),
  };
}
