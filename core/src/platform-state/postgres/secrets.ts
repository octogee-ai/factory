import { createHash } from "node:crypto";
import type { RecordKey } from "../errors.js";
import type {
  AccessRepositories,
  BuilderSecret,
  BuilderSecretInput,
  BuilderSecretKind,
  ControlSession,
  ControlSessionsRepository,
  ControlTicket,
  ControlTicketsRepository,
  GatewayAccessAuditRepository,
  GatewayTicket,
  GatewayTicketsRepository,
  ModelBrokerGatewayToken,
  ModelBrokerGatewayTokensRepository,
  ModelBrokerToken,
  ModelBrokerTokensRepository,
  SecretsRepository,
} from "../secrets.js";
import type { OpaqueMap, Stored } from "../store.js";
import { deleteRecord, equalsFence, insertRecord, revisionFence, selectByKey, selectRecords, updateRecord } from "./records.js";
import type { PostgresSession } from "./session.js";
import type { Row } from "./sql.js";
import { column, columnFor, decodeStored, type TableSpec } from "./values.js";

const BUILDER_MATTERMOST_SECRET_ID = "mattermost";
const COACH_MATTERMOST_SECRET_ID = "coachMattermost";
const PROJECT_AGENT_SECRET_PREFIX = "projectAgentMattermost-";
const ACCESS_DENIAL_BUCKET_MS = 60_000;
const GATEWAY_TICKET_RESERVED = ["uid", "gatewayId", "expiresAt", "expireAt"] as const;
const CONTROL_TICKET_RESERVED = ["uid", "gatewayId", "createdAt", "expiresAt", "expireAt", "redeemedAt"] as const;
const CONTROL_SESSION_RESERVED = ["uid", "gatewayId", "createdAt", "expiresAt", "expireAt", "mobileEnrollmentId"] as const;
const ENCRYPTED_TOKEN_FIELDS = ["encryptedAccessToken", "encryptedRefreshToken"] as const;

const nullable = { nullAs: "null" } as const;
const grantColumn = column("grant", "jsonb", { column: "access_grant" });

const SECRETS_TABLE: TableSpec = {
  table: "builder_secrets",
  aggregate: "builder-secret",
  keyColumns: ["uid", "secret_id"],
  columns: [
    column("uid", "text"),
    column("secretId", "text"),
    column("personalToken", "text"),
    column("mattermostUserId", "text", nullable),
    column("encryptedAccessToken", "text", nullable),
    column("encryptedRefreshToken", "text", nullable),
    column("detail", "jsonb"),
    column("createdAt", "bigint", nullable),
    column("rotatedAt", "bigint", nullable),
  ],
};

const GATEWAY_TICKETS_TABLE: TableSpec = {
  table: "gateway_tickets",
  aggregate: "gateway-ticket",
  keyColumns: ["ticket_id"],
  columns: [column("ticketId", "text"), column("uid", "text"), column("gatewayId", "text"), column("expiresAt", "bigint"), grantColumn],
};

const CONTROL_TICKETS_TABLE: TableSpec = {
  table: "control_tickets",
  aggregate: "control-ticket",
  keyColumns: ["ticket_hash"],
  columns: [
    column("ticketHash", "text"),
    column("gatewayId", "text"),
    column("uid", "text"),
    column("createdAt", "bigint"),
    column("expiresAt", "bigint"),
    column("redeemedAt", "bigint", nullable),
    grantColumn,
  ],
};

const CONTROL_SESSIONS_TABLE: TableSpec = {
  table: "control_sessions",
  aggregate: "control-session",
  keyColumns: ["session_hash"],
  columns: [
    column("sessionHash", "text"),
    column("gatewayId", "text"),
    column("uid", "text"),
    column("createdAt", "bigint", nullable),
    column("expiresAt", "bigint"),
    column("attachmentId", "text", nullable),
    grantColumn,
  ],
};

const ACCESS_AUDIT_TABLE: TableSpec = {
  table: "gateway_access_audit",
  aggregate: "gateway-access-audit",
  keyColumns: ["id"],
  columns: [
    column("id", "text"),
    column("at", "bigint"),
    column("gatewayId", "text"),
    column("uid", "text", nullable),
    column("reason", "text"),
    column("detail", "jsonb"),
  ],
};

const MODEL_BROKER_TOKENS_TABLE: TableSpec = {
  table: "model_broker_tokens",
  aggregate: "model-broker-token",
  keyColumns: ["token_hash"],
  columns: [
    column("tokenHash", "text"),
    column("gatewayId", "text"),
    column("ownerUid", "text", nullable),
    column("provider", "text"),
    column("purpose", "text"),
    column("secretName", "text"),
    column("createdAt", "bigint"),
    column("expiresAt", "bigint", nullable),
    column("limitSpendWindowUsd", "double", nullable),
    column("limitSpendWeekUsd", "double", nullable),
    column("limitRequestsPerMinute", "double", nullable),
    column("railPolicy", "jsonb"),
    column("trace", "jsonb", nullable),
    column("revoked", "boolean"),
    column("revokedAt", "bigint", nullable),
  ],
};

const MODEL_BROKER_GATEWAY_TOKENS_TABLE: TableSpec = {
  table: "model_broker_gateway_tokens",
  aggregate: "model-broker-gateway-token",
  keyColumns: ["pointer_key"],
  columns: [
    column("pointerKey", "text"),
    column("gatewayId", "text"),
    column("ownerUid", "text", nullable),
    column("provider", "text"),
    column("secretName", "text"),
    column("tokenHash", "text"),
    column("updatedAt", "bigint"),
  ],
};

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function without(map: OpaqueMap, keys: readonly string[]): PlainObject {
  return Object.fromEntries(Object.entries(map).filter(([key]) => !keys.includes(key)));
}

function assertNoReservedKeys(operation: string, map: OpaqueMap, reserved: readonly string[]): void {
  const collisions = Object.keys(map).filter((key) => reserved.includes(key));
  if (collisions.length > 0) {
    throw new TypeError(`${operation}: ${collisions.join(", ")} are typed fields and cannot appear in the opaque map`);
  }
}

export function secretKindOf(secretId: string): BuilderSecretKind {
  if (secretId === BUILDER_MATTERMOST_SECRET_ID) return "builder-mattermost";
  if (secretId === COACH_MATTERMOST_SECRET_ID) return "coach-mattermost";
  if (secretId.startsWith(PROJECT_AGENT_SECRET_PREFIX)) return "project-agent-mattermost";
  return "connector";
}

function projectIdOf(secretId: string): string | null {
  return secretKindOf(secretId) === "project-agent-mattermost" ? secretId.slice(PROJECT_AGENT_SECRET_PREFIX.length) : null;
}

function encryptedToken(tokens: PlainObject, field: (typeof ENCRYPTED_TOKEN_FIELDS)[number]): string | null {
  const value = tokens[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError(`secrets.put: detail.tokens.${field} must be a string, got ${JSON.stringify(value)}`);
  return value;
}

function connectorRow(uid: string, secret: Extract<BuilderSecretInput, { kind: "connector" }>): PlainObject {
  const detailTokens = isPlainObject(secret.detail.tokens) ? secret.detail.tokens : {};
  const tokens: PlainObject = { ...detailTokens };
  if (secret.encryptedAccessToken !== null) tokens.encryptedAccessToken = secret.encryptedAccessToken;
  if (secret.encryptedRefreshToken !== null) tokens.encryptedRefreshToken = secret.encryptedRefreshToken;
  const otherTokenFields = without(tokens, ENCRYPTED_TOKEN_FIELDS);
  const detail = without(secret.detail, ["tokens"]);
  return {
    uid,
    secretId: secret.secretId,
    encryptedAccessToken: encryptedToken(tokens, "encryptedAccessToken"),
    encryptedRefreshToken: encryptedToken(tokens, "encryptedRefreshToken"),
    detail: Object.keys(otherTokenFields).length === 0 ? detail : { ...detail, tokens: otherTokenFields },
  };
}

function secretRow(uid: string, secret: BuilderSecretInput): PlainObject {
  const derivedKind = secretKindOf(secret.secretId);
  if (derivedKind !== secret.kind) {
    throw new TypeError(`secrets.put: secret id ${secret.secretId} holds a ${derivedKind} secret, not ${secret.kind}`);
  }
  if (secret.kind === "connector") return connectorRow(uid, secret);
  const projectId = projectIdOf(secret.secretId);
  if (secret.projectId !== projectId) {
    throw new TypeError(`secrets.put: secret id ${secret.secretId} belongs to project ${String(projectId)}, not ${String(secret.projectId)}`);
  }
  return {
    uid,
    secretId: secret.secretId,
    personalToken: secret.personalToken,
    mattermostUserId: secret.mattermostUserId,
    createdAt: secret.createdAt,
    rotatedAt: secret.rotatedAt,
  };
}

function decodeSecret(row: Row): Stored<BuilderSecret> {
  const stored = decodeStored<{
    secretId: string;
    personalToken: string;
    mattermostUserId: string | null;
    encryptedAccessToken: string | null;
    encryptedRefreshToken: string | null;
    detail: OpaqueMap;
    createdAt: number | null;
    rotatedAt: number | null;
  }>(SECRETS_TABLE, row);
  const kind = row.secret_kind as BuilderSecretKind;
  if (kind === "connector") {
    return {
      kind,
      secretId: stored.secretId,
      encryptedAccessToken: stored.encryptedAccessToken,
      encryptedRefreshToken: stored.encryptedRefreshToken,
      detail: stored.detail,
      revision: stored.revision,
    };
  }
  return {
    kind,
    secretId: stored.secretId,
    projectId: (row.project_id as string | null) ?? null,
    personalToken: stored.personalToken,
    mattermostUserId: stored.mattermostUserId,
    createdAt: stored.createdAt,
    rotatedAt: stored.rotatedAt,
    revision: stored.revision,
  };
}

export function createPostgresSecretsRepository(session: PostgresSession): SecretsRepository {
  return {
    async get(uid, secretId) {
      const row = await selectByKey(session, "secrets.get", { table: SECRETS_TABLE, key: [uid, secretId] });
      return row === null ? null : decodeSecret(row);
    },

    async list(uid, kind) {
      const rows =
        kind === undefined
          ? await selectRecords(session, "secrets.list", "SELECT * FROM $schema.builder_secrets WHERE uid = $1::text ORDER BY secret_id", [uid])
          : await selectRecords(
              session,
              "secrets.list",
              "SELECT * FROM $schema.builder_secrets WHERE uid = $1::text AND secret_kind = $2::text ORDER BY secret_id",
              [uid, kind],
            );
      return rows.map(decodeSecret);
    },

    async put(uid, secret) {
      await insertRecord(session, "secrets.put", SECRETS_TABLE, secretRow(uid, secret), "put");
    },

    async delete(uid, secretId) {
      await deleteRecord(session, "secrets.delete", { table: SECRETS_TABLE, key: [uid, secretId] });
    },
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

function createGatewayTicketsRepository(session: PostgresSession): GatewayTicketsRepository {
  return {
    async get(ticketId) {
      const row = await selectByKey(session, "access.gatewayTickets.get", { table: GATEWAY_TICKETS_TABLE, key: [ticketId] });
      return row === null ? null : decodeStored<GatewayTicket>(GATEWAY_TICKETS_TABLE, row);
    },

    async create(ticket) {
      assertNoReservedKeys("access.gatewayTickets.create", ticket.grant, GATEWAY_TICKET_RESERVED);
      await insertRecord(session, "access.gatewayTickets.create", GATEWAY_TICKETS_TABLE, ticket, "create");
    },

    async delete(ticketId, fence) {
      await deleteRecord(
        session,
        "access.gatewayTickets.delete",
        { table: GATEWAY_TICKETS_TABLE, key: [ticketId] },
        revisionFence(fence?.revision),
      );
    },
  };
}

const controlTicketKey = (ticketHash: string): RecordKey => ({ aggregate: "control-ticket", key: ticketHash });
const REDEEMED_AT = columnFor(CONTROL_TICKETS_TABLE, controlTicketKey(""), "redeemedAt");

function createControlTicketsRepository(session: PostgresSession): ControlTicketsRepository {
  return {
    async get(ticketHash) {
      const row = await selectByKey(session, "access.controlTickets.get", { table: CONTROL_TICKETS_TABLE, key: [ticketHash] });
      return row === null ? null : decodeStored<ControlTicket>(CONTROL_TICKETS_TABLE, row);
    },

    async create(ticket) {
      assertNoReservedKeys("access.controlTickets.create", ticket.grant, CONTROL_TICKET_RESERVED);
      await insertRecord(session, "access.controlTickets.create", CONTROL_TICKETS_TABLE, ticket, "create");
    },

    async markRedeemed(ticketHash, redeemedAt, fence) {
      await updateRecord(
        session,
        "access.controlTickets.markRedeemed",
        { table: CONTROL_TICKETS_TABLE, key: [ticketHash] },
        { redeemedAt },
        equalsFence("absent", REDEEMED_AT, fence.redeemedAt),
      );
    },
  };
}

function createControlSessionsRepository(session: PostgresSession): ControlSessionsRepository {
  return {
    async get(sessionHash) {
      const row = await selectByKey(session, "access.controlSessions.get", { table: CONTROL_SESSIONS_TABLE, key: [sessionHash] });
      return row === null ? null : decodeStored<ControlSession>(CONTROL_SESSIONS_TABLE, row);
    },

    async put(controlSession) {
      assertNoReservedKeys("access.controlSessions.put", controlSession.grant, CONTROL_SESSION_RESERVED);
      await insertRecord(session, "access.controlSessions.put", CONTROL_SESSIONS_TABLE, controlSession, "put");
    },

    async delete(sessionHash) {
      await deleteRecord(session, "access.controlSessions.delete", { table: CONTROL_SESSIONS_TABLE, key: [sessionHash] });
    },
  };
}

function createAccessAuditRepository(session: PostgresSession): GatewayAccessAuditRepository {
  return {
    async record(denial) {
      const id = gatewayAccessDenialAuditId(denial.gatewayId, denial.uid ?? "", denial.reason, denial.at);
      await insertRecord(session, "access.accessAudit.record", ACCESS_AUDIT_TABLE, { id, ...denial }, "put");
      return id;
    },
  };
}

interface ModelBrokerTokenRow extends Omit<ModelBrokerToken, "limits" | "trace"> {
  readonly trace?: OpaqueMap | null;
  readonly limitSpendWindowUsd: number | null;
  readonly limitSpendWeekUsd: number | null;
  readonly limitRequestsPerMinute: number | null;
}

function modelBrokerTokenRow(token: ModelBrokerToken): ModelBrokerTokenRow {
  const { limits, trace, ...fields } = token;
  return {
    ...fields,
    ...(trace === null ? {} : { trace }),
    limitSpendWindowUsd: limits.spendWindowUsd,
    limitSpendWeekUsd: limits.spendWeekUsd,
    limitRequestsPerMinute: limits.requestsPerMinute,
  };
}

function decodeModelBrokerToken(row: Row): Stored<ModelBrokerToken> {
  const { limitSpendWindowUsd, limitSpendWeekUsd, limitRequestsPerMinute, ...fields } = decodeStored<
    ModelBrokerTokenRow & Pick<ModelBrokerToken, "trace">
  >(MODEL_BROKER_TOKENS_TABLE, row);
  return {
    ...fields,
    limits: { spendWindowUsd: limitSpendWindowUsd, spendWeekUsd: limitSpendWeekUsd, requestsPerMinute: limitRequestsPerMinute },
  };
}

function createModelBrokerTokensRepository(session: PostgresSession): ModelBrokerTokensRepository {
  return {
    async get(tokenHash) {
      const row = await selectByKey(session, "access.modelBrokerTokens.get", { table: MODEL_BROKER_TOKENS_TABLE, key: [tokenHash] });
      return row === null ? null : decodeModelBrokerToken(row);
    },

    async listForOwner(ownerUid) {
      const rows = await selectRecords(
        session,
        "access.modelBrokerTokens.listForOwner",
        "SELECT * FROM $schema.model_broker_tokens WHERE owner_uid = $1::text ORDER BY token_hash",
        [ownerUid],
      );
      return rows.map(decodeModelBrokerToken);
    },

    async create(token) {
      await insertRecord(session, "access.modelBrokerTokens.create", MODEL_BROKER_TOKENS_TABLE, modelBrokerTokenRow(token), "create");
    },

    async revoke(tokenHash, revokedAt) {
      await updateRecord(
        session,
        "access.modelBrokerTokens.revoke",
        { table: MODEL_BROKER_TOKENS_TABLE, key: [tokenHash] },
        { revoked: true, revokedAt },
        [],
      );
    },

    async delete(tokenHash) {
      await deleteRecord(session, "access.modelBrokerTokens.delete", { table: MODEL_BROKER_TOKENS_TABLE, key: [tokenHash] });
    },
  };
}

function createModelBrokerGatewayTokensRepository(session: PostgresSession): ModelBrokerGatewayTokensRepository {
  const decode = (row: Row) => decodeStored<ModelBrokerGatewayToken>(MODEL_BROKER_GATEWAY_TOKENS_TABLE, row);

  return {
    async get(pointerKey) {
      const row = await selectByKey(session, "access.modelBrokerGatewayTokens.get", {
        table: MODEL_BROKER_GATEWAY_TOKENS_TABLE,
        key: [pointerKey],
      });
      return row === null ? null : decode(row);
    },

    async listForOwner(ownerUid) {
      const rows = await selectRecords(
        session,
        "access.modelBrokerGatewayTokens.listForOwner",
        "SELECT * FROM $schema.model_broker_gateway_tokens WHERE owner_uid = $1::text ORDER BY pointer_key",
        [ownerUid],
      );
      return rows.map(decode);
    },

    async put(pointer) {
      await insertRecord(session, "access.modelBrokerGatewayTokens.put", MODEL_BROKER_GATEWAY_TOKENS_TABLE, pointer, "put");
    },

    async delete(pointerKey) {
      await deleteRecord(session, "access.modelBrokerGatewayTokens.delete", {
        table: MODEL_BROKER_GATEWAY_TOKENS_TABLE,
        key: [pointerKey],
      });
    },
  };
}

export function createPostgresAccessRepositories(session: PostgresSession): AccessRepositories {
  return {
    gatewayTickets: createGatewayTicketsRepository(session),
    controlTickets: createControlTicketsRepository(session),
    controlSessions: createControlSessionsRepository(session),
    accessAudit: createAccessAuditRepository(session),
    modelBrokerTokens: createModelBrokerTokensRepository(session),
    modelBrokerGatewayTokens: createModelBrokerGatewayTokensRepository(session),
  };
}
