import { coachAgentId } from "../../../scripts/lib/byosub-onboarding.js";
import { isValidGatewayId } from "../../../shared/types/glm.js";
import { deriveCodexAuthHealth } from "../../../scripts/lib/codex-auth-health.js";
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

// The DEEP byosub health: byosubConnectionView reads only the Firestore ref
// (the "a credential was provisioned" pointer), which survives a reroll/
// relocation whether or not the destination pod actually re-materialized a
// working credential. This crosses that expectation with pod REALITY — is the
// auth-profile store actually present on this pod, and does codex consider it
// alive — so a silent boot-sync materialization failure surfaces as `missing`
// instead of a false `connected`. Used by /api/byosub/health on the customer's
// own pod (the durability harness's real proof) and to fix the product
// false-"connected" the ref-only read can't catch.
export type ByosubHealthStatus =
  | "healthy"
  | "needs_reauth"
  | "missing"
  | "not_connected"
  | "not_on_this_pod";

export interface ByosubHealthView {
  connected: boolean;
  status: ByosubHealthStatus;
  provider?: string;
}

export function deriveByosubHealth(input: {
  mountedHere: boolean;
  refProvider: string | null;
  storePresent: boolean;
  authStateText: string | null;
  profileId: string;
  now: number;
}): ByosubHealthView {
  if (!input.mountedHere) return { connected: false, status: "not_on_this_pod" };
  if (!input.refProvider) return { connected: false, status: "not_connected" };
  if (!input.storePresent) {
    return { connected: false, status: "missing", provider: input.refProvider };
  }
  const health = deriveCodexAuthHealth(input.authStateText, input.profileId, input.now);
  if (health === "needs_reauth") {
    return { connected: false, status: "needs_reauth", provider: input.refProvider };
  }
  return { connected: true, status: "healthy", provider: input.refProvider };
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
