import { FieldValue } from "firebase-admin/firestore";
import { db } from "./db.js";
import { internalFetch } from "./internal-fetch.js";
import { decryptSecret, encryptSecret } from "./kms.js";
import type { ConnectorDef } from "./connectors/def.js";

const FRESHNESS_MARGIN_MS = 60_000;

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function trimBaseUrl(baseUrl: string): string {
  let out = baseUrl.trim();
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export function connectorTokenBrokerBaseUrlFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return nonBlank(env.CONNECTOR_TOKEN_BROKER_URL);
}

async function readJsonOrNull(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface ConnectorTokenProjectAccessContext {
  kind: "project";
  requestingUid: string;
  workspaceSlug: string;
  projectSlug: string;
}

export type ConnectorTokenAccessContext = ConnectorTokenProjectAccessContext;

async function readConnectorAccessTokenViaBroker(
  uid: string,
  connectorId: string,
  access?: ConnectorTokenAccessContext,
): Promise<string | null> {
  const baseUrl = connectorTokenBrokerBaseUrlFromEnv();
  if (!baseUrl) return null;
  const gatewayId = nonBlank(process.env.GATEWAY_ID);
  if (!gatewayId) {
    throw new Error("CONNECTOR_TOKEN_BROKER_URL is set but GATEWAY_ID is missing");
  }

  const res = await internalFetch(
    `${trimBaseUrl(baseUrl)}/internal/connectors/access-token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gatewayId,
        uid,
        connectorId,
        ...(access ? { access } : {}),
      }),
    },
    {},
  );
  if (res.status === 404) return null;
  const body = await readJsonOrNull(res);
  if (!res.ok) {
    const error = typeof body?.error === "string" ? body.error : `broker HTTP ${res.status}`;
    throw new Error(`connector token broker failed: ${error}`);
  }
  const accessToken = body?.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("connector token broker returned malformed response");
  }
  return accessToken;
}

export async function readConnectorAccessToken(
  uid: string,
  connectorId: string,
  access?: ConnectorTokenAccessContext,
): Promise<string | null> {
  if (connectorTokenBrokerBaseUrlFromEnv()) {
    return readConnectorAccessTokenViaBroker(uid, connectorId, access);
  }
  // Temporary rollout bridge: direct Firestore/KMS reads are broken on hardened
  // cattle pods. Remove this fallback after TEST and PROD run the brokered bundle.
  const snap = await db.doc(`users/${uid}/secrets/${connectorId}`).get();
  const enc = (snap.data() as { tokens?: { encryptedAccessToken?: unknown } } | undefined)
    ?.tokens?.encryptedAccessToken;
  if (typeof enc !== "string" || enc.length === 0) return null;
  return decryptSecret(enc);
}

export interface ConnectorClientCreds {
  clientId: string;
  clientSecret: string;
  source: "platform" | "per-user";
}

async function readUserClientCreds(
  uid: string,
  def: ConnectorDef,
): Promise<ConnectorClientCreds | null> {
  const snap = await db.doc(`users/${uid}/secrets/${def.meta.id}`).get();
  const client = (
    snap.data() as
      | { client?: { encryptedClientId?: unknown; encryptedClientSecret?: unknown } }
      | undefined
  )?.client;
  if (
    typeof client?.encryptedClientId !== "string" ||
    typeof client?.encryptedClientSecret !== "string"
  ) {
    return null;
  }
  return {
    clientId: await decryptSecret(client.encryptedClientId),
    clientSecret: await decryptSecret(client.encryptedClientSecret),
    source: "per-user",
  };
}

function readPlatformClientCreds(def: ConnectorDef): ConnectorClientCreds | null {
  if (!def.oauth) return null;
  const clientId = process.env[def.oauth.clientIdEnv];
  const clientSecret = process.env[def.oauth.clientSecretEnv];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, source: "platform" };
}

export async function readConnectorClientCreds(
  uid: string,
  def: ConnectorDef,
  forSource?: "platform" | "per-user",
): Promise<ConnectorClientCreds | null> {
  if (!def.oauth) return null;
  if (forSource === "platform") return readPlatformClientCreds(def);
  if (forSource === "per-user") return readUserClientCreds(uid, def);
  if (def.meta.clientSource === "per-user") {
    return (await readUserClientCreds(uid, def)) ?? readPlatformClientCreds(def);
  }
  return readPlatformClientCreds(def);
}

export type FreshTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "not_connected" | "reauth_required" };

export async function getFreshAccessToken(
  uid: string,
  def: ConnectorDef,
): Promise<FreshTokenResult> {
  const ref = db.doc(`users/${uid}/secrets/${def.meta.id}`);
  const snap = await ref.get();
  const tokens = (
    snap.data() as
      | {
          tokens?: {
            encryptedAccessToken?: unknown;
            encryptedRefreshToken?: unknown;
            expiresAt?: unknown;
            tokenType?: unknown;
            clientSource?: unknown;
          };
        }
      | undefined
  )?.tokens;

  const enc = tokens?.encryptedAccessToken;
  if (typeof enc !== "string" || enc.length === 0) {
    return { ok: false, reason: "not_connected" };
  }

  const expiresAt = typeof tokens?.expiresAt === "number" ? tokens.expiresAt : null;
  if (expiresAt === null || expiresAt > Date.now() + FRESHNESS_MARGIN_MS) {
    return { ok: true, accessToken: await decryptSecret(enc) };
  }

  const encRefresh = tokens?.encryptedRefreshToken;
  if (typeof encRefresh !== "string" || encRefresh.length === 0 || !def.oauth) {
    return { ok: false, reason: "reauth_required" };
  }
  const storedSource =
    tokens?.clientSource === "platform" || tokens?.clientSource === "per-user"
      ? tokens.clientSource
      : undefined;
  const creds = await readConnectorClientCreds(uid, def, storedSource);
  if (!creds) {
    return { ok: false, reason: "reauth_required" };
  }

  return refreshAccessToken({
    ref,
    def,
    creds,
    encRefresh,
    previousAccessEnc: enc,
    fallbackTokenType: typeof tokens?.tokenType === "string" ? tokens.tokenType : "bearer",
  });
}

async function refreshAccessToken(args: {
  ref: FirebaseFirestore.DocumentReference;
  def: ConnectorDef;
  creds: ConnectorClientCreds;
  encRefresh: string;
  previousAccessEnc: string;
  fallbackTokenType: string;
}): Promise<FreshTokenResult> {
  const { ref, def, creds, encRefresh, previousAccessEnc, fallbackTokenType } = args;
  const lost = async (): Promise<FreshTokenResult> =>
    (await rereadAfterRefreshLoss(ref, previousAccessEnc)) ?? { ok: false, reason: "reauth_required" };

  const refreshToken = await decryptSecret(encRefresh);
  const resp = await fetch(def.oauth!.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  });
  if (!resp.ok) return lost();
  const out = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    error?: string;
  };
  if (out.error || !out.access_token) return lost();

  await ref.set(
    {
      tokens: {
        encryptedAccessToken: await encryptSecret(out.access_token),
        encryptedRefreshToken: out.refresh_token ? await encryptSecret(out.refresh_token) : encRefresh,
        expiresAt: out.expires_in ? Date.now() + out.expires_in * 1000 : null,
        tokenType: out.token_type ?? fallbackTokenType,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { ok: true, accessToken: out.access_token };
}

async function rereadAfterRefreshLoss(
  ref: FirebaseFirestore.DocumentReference,
  previousEncryptedAccessToken: string,
): Promise<FreshTokenResult | null> {
  const snap = await ref.get();
  const tokens = (
    snap.data() as { tokens?: { encryptedAccessToken?: unknown; expiresAt?: unknown } } | undefined
  )?.tokens;
  const enc = tokens?.encryptedAccessToken;
  if (typeof enc !== "string" || enc.length === 0 || enc === previousEncryptedAccessToken) {
    return null;
  }
  const expiresAt = typeof tokens?.expiresAt === "number" ? tokens.expiresAt : null;
  if (expiresAt !== null && expiresAt <= Date.now() + FRESHNESS_MARGIN_MS) {
    return null;
  }
  return { ok: true, accessToken: await decryptSecret(enc) };
}
