import { createHash } from "node:crypto";
import { MalformedRecordError, type RecordKey } from "../errors.js";
import type { ControlSession, ControlTicket, GatewayTicket, ModelBrokerGatewayToken, ModelBrokerProvider, ModelBrokerToken, ModelBrokerTokenPurpose, UserSecret, UserSecretInput, UserSecretKind } from "../secrets.js";
import { FirestoreFields } from "./workspaces.js";

export const USER_MATTERMOST_SECRET_ID = "mattermost";
export const DEFAULT_AGENT_MATTERMOST_SECRET_ID = "coachMattermost";
export const PROJECT_AGENT_SECRET_PREFIX = "projectAgentMattermost-";
export const ACCESS_DENIAL_BUCKET_MS = 60_000;
export const MODEL_BROKER_PROVIDERS: readonly ModelBrokerProvider[] = ["anthropic", "vertex", "openrouter", "openai"];
export const MODEL_BROKER_PURPOSES: readonly ModelBrokerTokenPurpose[] = ["model", "embeddings"];
export const GATEWAY_TICKET_FIELDS = ["uid", "gatewayId", "expiresAt", "expireAt"] as const;
export const CONTROL_TICKET_FIELDS = ["uid", "gatewayId", "createdAt", "expiresAt", "expireAt", "redeemedAt"] as const;
export const CONTROL_SESSION_FIELDS = ["uid", "gatewayId", "createdAt", "expiresAt", "expireAt", "mobileEnrollmentId"] as const;

export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function without(data: PlainObject, keys: readonly string[]): PlainObject {
  const rest: PlainObject = {};
  for (const [key, value] of Object.entries(data)) if (!keys.includes(key)) rest[key] = value;
  return rest;
}

export function nonNull(map: PlainObject): PlainObject {
  return Object.fromEntries(Object.entries(map).filter(([, value]) => value !== null && value !== undefined));
}

export function secretKindOf(secretId: string): UserSecretKind {
  if (secretId === USER_MATTERMOST_SECRET_ID) return "builder-mattermost";
  if (secretId === DEFAULT_AGENT_MATTERMOST_SECRET_ID) return "coach-mattermost";
  if (secretId.startsWith(PROJECT_AGENT_SECRET_PREFIX)) return "project-agent-mattermost";
  return "connector";
}

export function mattermostUserIdField(kind: UserSecretKind): string {
  return kind === "coach-mattermost" ? "coachMmUserId" : "mmUserId";
}

export const secretKey = (uid: string, secretId: string): RecordKey => ({ aggregate: "builder-secret", key: `${uid}/${secretId}` });
export const gatewayTicketKey = (ticketId: string): RecordKey => ({ aggregate: "gateway-ticket", key: ticketId });
export const controlTicketKey = (ticketHash: string): RecordKey => ({ aggregate: "control-ticket", key: ticketHash });
export const controlSessionKey = (sessionHash: string): RecordKey => ({ aggregate: "control-session", key: sessionHash });
export const modelBrokerTokenKey = (tokenHash: string): RecordKey => ({ aggregate: "model-broker-token", key: tokenHash });
export const modelBrokerPointerKey = (pointerKey: string): RecordKey => ({ aggregate: "model-broker-gateway-token", key: pointerKey });

export function userSecretFromData(uid: string, secretId: string, data: Record<string, unknown>): UserSecret {
  const kind = secretKindOf(secretId);
  const fields = new FirestoreFields(secretKey(uid, secretId), data);
  if (kind === "connector") {
    const tokens = fields.nullableMap("tokens");
    const otherTokenFields = tokens === null ? {} : without(tokens, ["encryptedAccessToken", "encryptedRefreshToken"]);
    const detail = without(data, ["tokens"]);
    return {
      kind,
      secretId,
      encryptedAccessToken: fields.nullableString("tokens.encryptedAccessToken"),
      encryptedRefreshToken: fields.nullableString("tokens.encryptedRefreshToken"),
      detail: tokens === null || Object.keys(otherTokenFields).length === 0 ? detail : { ...detail, tokens: otherTokenFields },
    };
  }
  return {
    kind,
    secretId,
    projectId: kind === "project-agent-mattermost" ? secretId.slice(PROJECT_AGENT_SECRET_PREFIX.length) : null,
    personalToken: fields.string("personalToken"),
    mattermostUserId: fields.nullableString(mattermostUserIdField(kind)),
    createdAt: fields.nullableNumber("createdAt"),
    rotatedAt: fields.nullableNumber("rotatedAt"),
  };
}

export function userSecretToData(secret: UserSecretInput): PlainObject {
  const derivedKind = secretKindOf(secret.secretId);
  if (derivedKind !== secret.kind) {
    throw new TypeError(`secrets.put: secret id ${secret.secretId} holds a ${derivedKind} secret, not ${secret.kind}`);
  }
  if (secret.kind === "connector") {
    const detailTokens = isPlainObject(secret.detail.tokens) ? secret.detail.tokens : {};
    const tokens = {
      ...detailTokens,
      ...nonNull({ encryptedAccessToken: secret.encryptedAccessToken, encryptedRefreshToken: secret.encryptedRefreshToken }),
    };
    return Object.keys(tokens).length === 0 ? without(secret.detail, ["tokens"]) : { ...secret.detail, tokens };
  }
  const projectId = secret.kind === "project-agent-mattermost" ? secret.secretId.slice(PROJECT_AGENT_SECRET_PREFIX.length) : null;
  if (secret.projectId !== projectId) {
    throw new TypeError(`secrets.put: secret id ${secret.secretId} belongs to project ${String(projectId)}, not ${String(secret.projectId)}`);
  }
  return nonNull({
    personalToken: secret.personalToken,
    [mattermostUserIdField(secret.kind)]: secret.mattermostUserId,
    project: projectId,
    createdAt: secret.createdAt,
    rotatedAt: secret.rotatedAt,
  });
}

export function gatewayTicketFromData(ticketId: string, data: PlainObject): GatewayTicket {
  const fields = new FirestoreFields(gatewayTicketKey(ticketId), data);
  return {
    ticketId,
    uid: fields.string("uid"),
    gatewayId: fields.string("gatewayId"),
    expiresAt: fields.number("expiresAt"),
    grant: without(data, GATEWAY_TICKET_FIELDS),
  };
}

export function controlTicketFromData(ticketHash: string, data: PlainObject): ControlTicket {
  const fields = new FirestoreFields(controlTicketKey(ticketHash), data);
  return {
    ticketHash,
    uid: fields.string("uid"),
    gatewayId: fields.string("gatewayId"),
    createdAt: fields.number("createdAt"),
    expiresAt: fields.number("expiresAt"),
    redeemedAt: fields.nullableNumber("redeemedAt"),
    grant: without(data, CONTROL_TICKET_FIELDS),
  };
}

export function controlSessionFromData(sessionHash: string, data: PlainObject): ControlSession {
  const fields = new FirestoreFields(controlSessionKey(sessionHash), data);
  return {
    sessionHash,
    uid: fields.string("uid"),
    gatewayId: fields.string("gatewayId"),
    createdAt: fields.nullableNumber("createdAt"),
    expiresAt: fields.number("expiresAt"),
    attachmentId: fields.nullableString("mobileEnrollmentId"),
    grant: without(data, CONTROL_SESSION_FIELDS),
  };
}

export function modelBrokerTokenFromData(tokenHash: string, data: PlainObject): ModelBrokerToken {
  const key = modelBrokerTokenKey(tokenHash);
  const fields = new FirestoreFields(key, data);
  if (fields.value("capped") !== true) throw new MalformedRecordError(key, "capped must be true");
  return {
    tokenHash,
    gatewayId: fields.string("gatewayId"),
    ownerUid: fields.nullableString("ownerUid"),
    provider: fields.oneOf("provider", MODEL_BROKER_PROVIDERS),
    purpose: fields.value("purpose") === undefined ? "model" : fields.oneOf("purpose", MODEL_BROKER_PURPOSES),
    secretName: fields.string("secretName"),
    createdAt: fields.number("createdAt"),
    expiresAt: fields.nullableNumber("expiresAt"),
    limits: {
      spendWindowUsd: fields.nullableNumber("limits.spendWindowUsd"),
      spendWeekUsd: fields.nullableNumber("limits.spendWeekUsd"),
      requestsPerMinute: fields.nullableNumber("limits.requestsPerMinute"),
    },
    railPolicy: fields.nullableMap("policy") ?? {},
    trace: fields.nullableMap("trace"),
    revoked: fields.value("revoked") === true,
    revokedAt: fields.nullableNumber("revokedAt"),
  };
}

export function modelBrokerTokenDocument(token: ModelBrokerToken): PlainObject {
  const { railPolicy, revokedAt, ...rest } = token;
  return { ...rest, capped: true, policy: railPolicy, ...nonNull({ revokedAt }) };
}

export function modelBrokerGatewayTokenFromData(pointerKey: string, data: PlainObject): ModelBrokerGatewayToken {
  const fields = new FirestoreFields(modelBrokerPointerKey(pointerKey), data);
  return {
    pointerKey,
    gatewayId: fields.string("gatewayId"),
    ownerUid: fields.nullableString("ownerUid"),
    provider: fields.oneOf("provider", MODEL_BROKER_PROVIDERS),
    secretName: fields.string("secretName"),
    tokenHash: fields.string("tokenHash"),
    updatedAt: fields.number("updatedAt"),
  };
}

export function gatewayAccessDenialAuditId(gatewayId: string, granteeUid: string, reason: string, at: number): string {
  const bucket = Math.floor(at / ACCESS_DENIAL_BUCKET_MS);
  const digest = createHash("sha256")
    .update(gatewayId)
    .update("\0")
    .update(granteeUid)
    .update("\0")
    .update(reason)
    .update("\0")
    .update(String(bucket))
    .digest("hex");
  return `denied-${digest}`;
}
