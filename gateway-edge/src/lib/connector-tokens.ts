import { FieldValue } from "firebase-admin/firestore";
import { db } from "./db.js";
import { internalFetch } from "./internal-fetch.js";
import { decryptSecret, encryptSecret } from "./kms.js";
import {
  getConnector,
  isConnectorAgentRuntimeTokenMaterializable,
  isConnectorTokenBrokerable,
} from "./connectors/index.js";
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

export function connectorTokenAuthorityFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = nonBlank(env.CONNECTOR_TOKEN_AUTHORITY);
  return value === "1" || value === "true";
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

export interface ConnectorTokenOwnerRuntimeAccessContext {
  kind: "owner-runtime";
}

export type ConnectorTokenAccessContext =
  | ConnectorTokenProjectAccessContext
  | ConnectorTokenOwnerRuntimeAccessContext;

export class ConnectorTokenReadError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message = `connector token read failed: ${errorCode}`,
  ) {
    super(message);
    this.name = "ConnectorTokenReadError";
  }
}

export class ConnectorTokenBrokerError extends ConnectorTokenReadError {
  constructor(status: number, errorCode: string) {
    super(status, errorCode, `connector token broker failed: ${errorCode}`);
    this.name = "ConnectorTokenBrokerError";
  }
}

async function readConnectorAccessTokenViaBroker(
  baseUrl: string,
  uid: string,
  connectorId: string,
  access?: ConnectorTokenAccessContext,
): Promise<string | null> {
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
    throw new ConnectorTokenBrokerError(res.status, error);
  }
  const accessToken = body?.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("connector token broker returned malformed response");
  }
  return accessToken;
}

async function readConnectorAccessTokenDirect(
  uid: string,
  connectorId: string,
  access?: ConnectorTokenAccessContext,
): Promise<string | null> {
  const allowed =
    access?.kind === "owner-runtime"
      ? isConnectorAgentRuntimeTokenMaterializable(connectorId)
      : isConnectorTokenBrokerable(connectorId);
  if (!allowed) {
    throw new Error(`connector not brokerable: ${connectorId}`);
  }
  if (access?.kind === "owner-runtime") {
    const def = getConnector(connectorId);
    if (!def) throw new Error(`connector not brokerable: ${connectorId}`);
    const fresh = await getFreshAccessToken(uid, def);
    if (!fresh.ok) {
      if (fresh.reason === "not_connected") return null;
      throw new ConnectorTokenReadError(409, fresh.reason);
    }
    return fresh.accessToken;
  }
  const snap = await db.doc(`users/${uid}/secrets/${connectorId}`).get();
  const enc = (snap.data() as { tokens?: { encryptedAccessToken?: unknown } } | undefined)
    ?.tokens?.encryptedAccessToken;
  if (typeof enc !== "string" || enc.length === 0) return null;
  return decryptSecret(enc);
}

export async function readConnectorAccessToken(
  uid: string,
  connectorId: string,
  access?: ConnectorTokenAccessContext,
): Promise<string | null> {
  const baseUrl = connectorTokenBrokerBaseUrlFromEnv();
  if (baseUrl) return readConnectorAccessTokenViaBroker(baseUrl, uid, connectorId, access);
  if (connectorTokenAuthorityFromEnv()) return readConnectorAccessTokenDirect(uid, connectorId, access);
  throw new Error("CONNECTOR_TOKEN_BROKER_URL is required");
}

export interface ConnectorClientCreds {
  clientId: string;
  clientSecret: string;
  source: "platform" | "per-user";
}

export type ConnectorTokenStore = Pick<FirebaseFirestore.Firestore, "doc">;

async function readUserClientCreds(
  store: ConnectorTokenStore,
  uid: string,
  def: ConnectorDef,
): Promise<ConnectorClientCreds | null> {
  const snap = await store.doc(`users/${uid}/secrets/${def.meta.id}`).get();
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

export async function readConnectorClientCredsFromDb(
  store: ConnectorTokenStore,
  uid: string,
  def: ConnectorDef,
  forSource?: "platform" | "per-user",
): Promise<ConnectorClientCreds | null> {
  if (!def.oauth) return null;
  if (forSource === "platform") return readPlatformClientCreds(def);
  if (forSource === "per-user") return readUserClientCreds(store, uid, def);
  if (def.meta.clientSource === "per-user") {
    return (await readUserClientCreds(store, uid, def)) ?? readPlatformClientCreds(def);
  }
  return readPlatformClientCreds(def);
}

export async function readConnectorClientCreds(
  uid: string,
  def: ConnectorDef,
  forSource?: "platform" | "per-user",
): Promise<ConnectorClientCreds | null> {
  return readConnectorClientCredsFromDb(db, uid, def, forSource);
}

export type FreshTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "not_connected" | "reauth_required" };

interface StoredConnectorTokens {
  encryptedAccessToken?: unknown;
  encryptedRefreshToken?: unknown;
  expiresAt?: unknown;
  tokenType?: unknown;
  clientSource?: unknown;
}

export async function getFreshAccessToken(
  uid: string,
  def: ConnectorDef,
): Promise<FreshTokenResult> {
  return getFreshAccessTokenFromDb(db, uid, def);
}

export async function getFreshAccessTokenFromDb(
  store: ConnectorTokenStore,
  uid: string,
  def: ConnectorDef,
): Promise<FreshTokenResult> {
  const ref = store.doc(`users/${uid}/secrets/${def.meta.id}`);
  const snap = await ref.get();
  const tokens = readStoredConnectorTokens(snap.data());

  const enc = readEncryptedToken(tokens?.encryptedAccessToken);
  if (!enc) {
    return { ok: false, reason: "not_connected" };
  }

  if (isStoredAccessTokenFresh(tokens)) {
    return { ok: true, accessToken: await decryptSecret(enc) };
  }

  const encRefresh = readEncryptedToken(tokens?.encryptedRefreshToken);
  if (!encRefresh || !def.oauth) {
    return { ok: false, reason: "reauth_required" };
  }
  const creds = await readConnectorClientCredsFromDb(
    store,
    uid,
    def,
    readStoredClientSource(tokens),
  );
  if (!creds) {
    return { ok: false, reason: "reauth_required" };
  }

  return refreshAccessToken({
    ref,
    def,
    creds,
    encRefresh,
    previousAccessEnc: enc,
    fallbackTokenType: readStoredTokenType(tokens),
  });
}

function readStoredConnectorTokens(data: unknown): StoredConnectorTokens | undefined {
  return (data as { tokens?: StoredConnectorTokens } | undefined)?.tokens;
}

function readEncryptedToken(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isStoredAccessTokenFresh(tokens: StoredConnectorTokens | undefined): boolean {
  const expiresAt = typeof tokens?.expiresAt === "number" ? tokens.expiresAt : null;
  return expiresAt === null || expiresAt > Date.now() + FRESHNESS_MARGIN_MS;
}

function readStoredClientSource(tokens: StoredConnectorTokens | undefined): "platform" | "per-user" | undefined {
  return tokens?.clientSource === "platform" || tokens?.clientSource === "per-user"
    ? tokens.clientSource
    : undefined;
}

function readStoredTokenType(tokens: StoredConnectorTokens | undefined): string {
  return typeof tokens?.tokenType === "string" ? tokens.tokenType : "bearer";
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
