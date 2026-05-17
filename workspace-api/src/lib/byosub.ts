import { coachAgentId } from "../../../scripts/lib/byosub-onboarding";

export { coachAgentId };

/**
 * Owner-scoped Secret Manager name for a BYO-sub credential. MUST stay in
 * sync with scripts/ops/capture-byosub-credential.ts `secretNameFor` —
 * Chunk A restore reads the name from the glmGateways ref (opaque to it),
 * so the only invariant is that every writer uses this exact shape.
 */
export function byosubSecretName(uid: string, provider: string): string {
  return `byosub-${uid}-${provider}`;
}

/** A real codex auth.json is a few KB; this is the privileged credential
 * sink, so cap the blob well above that and well below anything abusive. */
const MAX_CREDENTIAL_BYTES = 32_768;

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

/**
 * Refuse to persist anything that isn't a plausible codex auth.json. This
 * is a server-mediated write into a path that is later restored into a
 * live runtime credential file, so require the exact fields codex restore
 * needs rather than "some object with a tokens key".
 */
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
  start(args: { instanceName: string; agentId: string }): Promise<DeviceAuthStart>;
  status(args: { instanceName: string; flowId: string }): Promise<DeviceAuthStatus>;
}

/**
 * Default I/O client → the gateway's internal device-auth endpoint (C1b),
 * via K8s DNS + X-Internal-Service-Key. Exercised in TEST; unit specs mock
 * this factory. The gateway Service name is the helm per-instance name
 * (`octogee-gateway-<instanceName>`) resolved from `glmGateways/{gatewayId}`
 * — the same derivation glm-controller uses, never `gatewayId` munging.
 * Env-overridable so TEST can retarget without code.
 */
export function gatewayDeviceAuthClient(): GatewayDeviceAuthClient {
  const key = process.env.INTERNAL_SERVICE_KEY ?? "";
  const ns = process.env.K8S_NAMESPACE ?? "octogee";
  const base = (instanceName: string): string =>
    process.env.GATEWAY_INTERNAL_URL_TEMPLATE
      ? process.env.GATEWAY_INTERNAL_URL_TEMPLATE.replace(
          "{instanceName}",
          instanceName,
        )
      : `http://octogee-gateway-${instanceName}.${ns}.svc.cluster.local:3003`;
  async function call<T>(url: string, init: RequestInit): Promise<T> {
    const r = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service-Key": key,
        ...(init.headers || {}),
      },
    });
    if (!r.ok) {
      throw new Error(`gateway ${r.status} ${await r.text().catch(() => "")}`);
    }
    return (await r.json()) as T;
  }
  return {
    start: ({ instanceName, agentId }) =>
      call(`${base(instanceName)}/internal/byosub/device-auth/start`, {
        method: "POST",
        body: JSON.stringify({ agentId }),
      }),
    status: ({ instanceName, flowId }) =>
      call(
        `${base(instanceName)}/internal/byosub/device-auth/status/${encodeURIComponent(flowId)}`,
        { method: "GET" },
      ),
  };
}
