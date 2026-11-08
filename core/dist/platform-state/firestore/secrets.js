import { createHash } from "node:crypto";
import { MODEL_BROKER_GATEWAY_POINTERS_COLLECTION, MODEL_BROKER_TOKENS_COLLECTION } from "@octogee/shared/types/model-broker-usage";
import { GATEWAY_ACCESS_AUDIT_COLLECTION } from "../../gateway-principal-access.js";
import { OPENCLAW_CONTROL_TICKETS_COLLECTION } from "../../openclaw-control-tickets.js";
import { MalformedRecordError, MissingRecordError } from "../errors.js";
import { assertFenceEquals, assertRevisionFence } from "./fences.js";
import { decodeDocumentData, encodeDocument, revisionOf, STORED_AS_NUMBERS, storedAsTimestamps, } from "./values.js";
import { FirestoreFields, withStoredRevision } from "./workspaces.js";
export const GATEWAY_TICKETS_COLLECTION = "gatewayTickets";
export const OPENCLAW_CONTROL_SESSIONS_COLLECTION = "openclawControlSessions";
const BUILDER_MATTERMOST_SECRET_ID = "mattermost";
const COACH_MATTERMOST_SECRET_ID = "coachMattermost";
const PROJECT_AGENT_SECRET_PREFIX = "projectAgentMattermost-";
const SECRET_TIMES = storedAsTimestamps("createdAt", "rotatedAt", "updatedAt");
const TICKET_TIMES = storedAsTimestamps("expireAt");
const CONTROL_TICKET_TIMES = storedAsTimestamps("createdAt", "expireAt");
const ACCESS_DENIAL_BUCKET_MS = 60_000;
const MODEL_BROKER_PROVIDERS = ["anthropic", "vertex", "openrouter", "openai"];
const MODEL_BROKER_PURPOSES = ["model", "embeddings"];
const GATEWAY_TICKET_FIELDS = ["uid", "gatewayId", "expiresAt", "expireAt"];
const CONTROL_TICKET_FIELDS = ["uid", "gatewayId", "createdAt", "expiresAt", "expireAt", "redeemedAt"];
const CONTROL_SESSION_FIELDS = ["uid", "gatewayId", "createdAt", "expiresAt", "expireAt", "mobileEnrollmentId"];
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isPresent(value) {
    return value !== null;
}
function without(data, keys) {
    const rest = {};
    for (const [key, value] of Object.entries(data))
        if (!keys.includes(key))
            rest[key] = value;
    return rest;
}
function assertNoReservedKeys(operation, map, reserved) {
    const collisions = Object.keys(map).filter((key) => reserved.includes(key));
    if (collisions.length > 0) {
        throw new TypeError(`${operation}: ${collisions.join(", ")} are typed fields and cannot appear in the opaque map`);
    }
}
function nonNull(map) {
    return Object.fromEntries(Object.entries(map).filter(([, value]) => value !== null && value !== undefined));
}
export function secretKindOf(secretId) {
    if (secretId === BUILDER_MATTERMOST_SECRET_ID)
        return "builder-mattermost";
    if (secretId === COACH_MATTERMOST_SECRET_ID)
        return "coach-mattermost";
    if (secretId.startsWith(PROJECT_AGENT_SECRET_PREFIX))
        return "project-agent-mattermost";
    return "connector";
}
function mattermostUserIdField(kind) {
    return kind === "coach-mattermost" ? "coachMmUserId" : "mmUserId";
}
const secretKey = (uid, secretId) => ({ aggregate: "builder-secret", key: `${uid}/${secretId}` });
const gatewayTicketKey = (ticketId) => ({ aggregate: "gateway-ticket", key: ticketId });
const controlTicketKey = (ticketHash) => ({ aggregate: "control-ticket", key: ticketHash });
const controlSessionKey = (sessionHash) => ({ aggregate: "control-session", key: sessionHash });
const accessAuditKey = (id) => ({ aggregate: "gateway-access-audit", key: id });
const modelBrokerTokenKey = (tokenHash) => ({ aggregate: "model-broker-token", key: tokenHash });
const modelBrokerPointerKey = (pointerKey) => ({ aggregate: "model-broker-gateway-token", key: pointerKey });
function secretsCollection(session, uid) {
    return session.db.collection("users").doc(uid).collection("secrets");
}
function decodeSecret(uid, snapshot) {
    if (!snapshot.exists)
        return null;
    return withStoredRevision(snapshot, builderSecretFromData(uid, snapshot.id, decodeDocumentData(snapshot)));
}
export function builderSecretFromData(uid, secretId, data) {
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
function encodeSecret(secret) {
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
        return encodeDocument(Object.keys(tokens).length === 0 ? without(secret.detail, ["tokens"]) : { ...secret.detail, tokens }, SECRET_TIMES);
    }
    const projectId = secret.kind === "project-agent-mattermost" ? secret.secretId.slice(PROJECT_AGENT_SECRET_PREFIX.length) : null;
    if (secret.projectId !== projectId) {
        throw new TypeError(`secrets.put: secret id ${secret.secretId} belongs to project ${String(projectId)}, not ${String(secret.projectId)}`);
    }
    return encodeDocument(nonNull({
        personalToken: secret.personalToken,
        [mattermostUserIdField(secret.kind)]: secret.mattermostUserId,
        project: projectId,
        createdAt: secret.createdAt,
        rotatedAt: secret.rotatedAt,
    }), SECRET_TIMES);
}
export function createFirestoreSecretsRepository(session) {
    const ref = (uid, secretId) => secretsCollection(session, uid).doc(secretId);
    return {
        async get(uid, secretId) {
            return decodeSecret(uid, await session.read("secrets.get", ref(uid, secretId)));
        },
        async list(uid, kind) {
            const snapshot = await session.query("secrets.list", secretsCollection(session, uid));
            const docs = kind === undefined ? snapshot.docs : snapshot.docs.filter((doc) => secretKindOf(doc.id) === kind);
            return docs.map((doc) => decodeSecret(uid, doc)).filter(isPresent);
        },
        async put(uid, secret) {
            await session.set("secrets.put", secretKey(uid, secret.secretId), ref(uid, secret.secretId), encodeSecret(secret));
        },
        async delete(uid, secretId) {
            await session.delete("secrets.delete", secretKey(uid, secretId), ref(uid, secretId));
        },
    };
}
function decodeGatewayTicket(snapshot) {
    if (!snapshot.exists)
        return null;
    const data = decodeDocumentData(snapshot);
    const fields = new FirestoreFields(gatewayTicketKey(snapshot.id), data);
    return withStoredRevision(snapshot, {
        ticketId: snapshot.id,
        uid: fields.string("uid"),
        gatewayId: fields.string("gatewayId"),
        expiresAt: fields.number("expiresAt"),
        grant: without(data, GATEWAY_TICKET_FIELDS),
    });
}
function decodeControlTicket(snapshot) {
    if (!snapshot.exists)
        return null;
    const data = decodeDocumentData(snapshot);
    const fields = new FirestoreFields(controlTicketKey(snapshot.id), data);
    return withStoredRevision(snapshot, {
        ticketHash: snapshot.id,
        uid: fields.string("uid"),
        gatewayId: fields.string("gatewayId"),
        createdAt: fields.number("createdAt"),
        expiresAt: fields.number("expiresAt"),
        redeemedAt: fields.nullableNumber("redeemedAt"),
        grant: without(data, CONTROL_TICKET_FIELDS),
    });
}
function decodeControlSession(snapshot) {
    if (!snapshot.exists)
        return null;
    const data = decodeDocumentData(snapshot);
    const fields = new FirestoreFields(controlSessionKey(snapshot.id), data);
    return withStoredRevision(snapshot, {
        sessionHash: snapshot.id,
        uid: fields.string("uid"),
        gatewayId: fields.string("gatewayId"),
        createdAt: fields.nullableNumber("createdAt"),
        expiresAt: fields.number("expiresAt"),
        attachmentId: fields.nullableString("mobileEnrollmentId"),
        grant: without(data, CONTROL_SESSION_FIELDS),
    });
}
function decodeModelBrokerToken(snapshot) {
    if (!snapshot.exists)
        return null;
    const key = modelBrokerTokenKey(snapshot.id);
    const fields = new FirestoreFields(key, decodeDocumentData(snapshot));
    if (fields.value("capped") !== true)
        throw new MalformedRecordError(key, "capped must be true");
    return withStoredRevision(snapshot, {
        tokenHash: snapshot.id,
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
    });
}
function decodeModelBrokerGatewayToken(snapshot) {
    if (!snapshot.exists)
        return null;
    const fields = new FirestoreFields(modelBrokerPointerKey(snapshot.id), decodeDocumentData(snapshot));
    return withStoredRevision(snapshot, {
        pointerKey: snapshot.id,
        gatewayId: fields.string("gatewayId"),
        ownerUid: fields.nullableString("ownerUid"),
        provider: fields.oneOf("provider", MODEL_BROKER_PROVIDERS),
        secretName: fields.string("secretName"),
        tokenHash: fields.string("tokenHash"),
        updatedAt: fields.number("updatedAt"),
    });
}
export function gatewayAccessDenialAuditId(gatewayId, granteeUid, reason, at) {
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
async function fencedRead(session, name, key, ref) {
    const current = await session.readForFence(name, ref);
    if (!current.exists)
        throw new MissingRecordError(key);
    return current;
}
function createGatewayTicketsRepository(session) {
    const ref = (ticketId) => session.db.collection(GATEWAY_TICKETS_COLLECTION).doc(ticketId);
    return {
        async get(ticketId) {
            return decodeGatewayTicket(await session.read("access.gatewayTickets.get", ref(ticketId)));
        },
        async create(ticket) {
            assertNoReservedKeys("access.gatewayTickets.create", ticket.grant, GATEWAY_TICKET_FIELDS);
            await session.create("access.gatewayTickets.create", gatewayTicketKey(ticket.ticketId), ref(ticket.ticketId), encodeDocument({
                ...ticket.grant,
                uid: ticket.uid,
                gatewayId: ticket.gatewayId,
                expiresAt: ticket.expiresAt,
                expireAt: ticket.expiresAt,
            }, TICKET_TIMES));
        },
        async delete(ticketId, fence) {
            const name = "access.gatewayTickets.delete";
            const key = gatewayTicketKey(ticketId);
            if (fence?.revision === undefined) {
                await session.delete(name, key, ref(ticketId));
                return;
            }
            await session.atomically(name, async (fenced) => {
                const current = await fencedRead(fenced, name, key, ref(ticketId));
                assertRevisionFence(key, fence.revision, revisionOf(current));
                await fenced.delete(name, key, ref(ticketId));
            });
        },
    };
}
function createControlTicketsRepository(session) {
    const ref = (ticketHash) => session.db.collection(OPENCLAW_CONTROL_TICKETS_COLLECTION).doc(ticketHash);
    return {
        async get(ticketHash) {
            return decodeControlTicket(await session.read("access.controlTickets.get", ref(ticketHash)));
        },
        async create(ticket) {
            assertNoReservedKeys("access.controlTickets.create", ticket.grant, CONTROL_TICKET_FIELDS);
            await session.create("access.controlTickets.create", controlTicketKey(ticket.ticketHash), ref(ticket.ticketHash), encodeDocument({
                ...ticket.grant,
                uid: ticket.uid,
                gatewayId: ticket.gatewayId,
                createdAt: ticket.createdAt,
                expiresAt: ticket.expiresAt,
                expireAt: ticket.expiresAt,
                ...nonNull({ redeemedAt: ticket.redeemedAt }),
            }, CONTROL_TICKET_TIMES));
        },
        async markRedeemed(ticketHash, redeemedAt, fence) {
            const name = "access.controlTickets.markRedeemed";
            const key = controlTicketKey(ticketHash);
            await session.atomically(name, async (fenced) => {
                const current = decodeControlTicket(await fencedRead(fenced, name, key, ref(ticketHash)));
                assertFenceEquals(key, "absent", fence.redeemedAt, current?.redeemedAt);
                await fenced.update(name, key, ref(ticketHash), { redeemedAt });
            });
        },
    };
}
function createControlSessionsRepository(session) {
    const ref = (sessionHash) => session.db.collection(OPENCLAW_CONTROL_SESSIONS_COLLECTION).doc(sessionHash);
    return {
        async get(sessionHash) {
            return decodeControlSession(await session.read("access.controlSessions.get", ref(sessionHash)));
        },
        async put(controlSession) {
            assertNoReservedKeys("access.controlSessions.put", controlSession.grant, CONTROL_SESSION_FIELDS);
            await session.set("access.controlSessions.put", controlSessionKey(controlSession.sessionHash), ref(controlSession.sessionHash), encodeDocument({
                ...controlSession.grant,
                uid: controlSession.uid,
                gatewayId: controlSession.gatewayId,
                ...nonNull({ createdAt: controlSession.createdAt, mobileEnrollmentId: controlSession.attachmentId }),
                expiresAt: controlSession.expiresAt,
                expireAt: controlSession.expiresAt,
            }, TICKET_TIMES));
        },
        async delete(sessionHash) {
            await session.delete("access.controlSessions.delete", controlSessionKey(sessionHash), ref(sessionHash));
        },
    };
}
function createAccessAuditRepository(session) {
    return {
        async record(denial) {
            const id = gatewayAccessDenialAuditId(denial.gatewayId, denial.uid ?? "", denial.reason, denial.at);
            await session.set("access.accessAudit.record", accessAuditKey(id), session.db.collection(GATEWAY_ACCESS_AUDIT_COLLECTION).doc(id), encodeDocument({
                ...denial.detail,
                gatewayId: denial.gatewayId,
                granteeUid: denial.uid,
                event: "denied",
                reason: denial.reason,
                outcome: "denied",
                createdAt: Math.floor(denial.at / ACCESS_DENIAL_BUCKET_MS) * ACCESS_DENIAL_BUCKET_MS,
            }, STORED_AS_NUMBERS));
            return id;
        },
    };
}
function createModelBrokerTokensRepository(session) {
    const collection = () => session.db.collection(MODEL_BROKER_TOKENS_COLLECTION);
    const ref = (tokenHash) => collection().doc(tokenHash);
    return {
        async get(tokenHash) {
            return decodeModelBrokerToken(await session.read("access.modelBrokerTokens.get", ref(tokenHash)));
        },
        async listForOwner(ownerUid) {
            const query = collection().where("ownerUid", "==", ownerUid);
            const snapshot = await session.query("access.modelBrokerTokens.listForOwner", query);
            return snapshot.docs.map(decodeModelBrokerToken).filter(isPresent);
        },
        async create(token) {
            const { railPolicy, revokedAt, ...rest } = token;
            await session.create("access.modelBrokerTokens.create", modelBrokerTokenKey(token.tokenHash), ref(token.tokenHash), encodeDocument({ ...rest, capped: true, policy: railPolicy, ...nonNull({ revokedAt }) }, STORED_AS_NUMBERS));
        },
        async revoke(tokenHash, revokedAt) {
            await session.merge("access.modelBrokerTokens.revoke", modelBrokerTokenKey(tokenHash), ref(tokenHash), { revoked: true, revokedAt });
        },
        async delete(tokenHash) {
            await session.delete("access.modelBrokerTokens.delete", modelBrokerTokenKey(tokenHash), ref(tokenHash));
        },
    };
}
function createModelBrokerGatewayTokensRepository(session) {
    const collection = () => session.db.collection(MODEL_BROKER_GATEWAY_POINTERS_COLLECTION);
    const ref = (pointerKey) => collection().doc(pointerKey);
    return {
        async get(pointerKey) {
            return decodeModelBrokerGatewayToken(await session.read("access.modelBrokerGatewayTokens.get", ref(pointerKey)));
        },
        async listForOwner(ownerUid) {
            const snapshot = await session.query("access.modelBrokerGatewayTokens.listForOwner", collection().where("ownerUid", "==", ownerUid));
            return snapshot.docs.map(decodeModelBrokerGatewayToken).filter(isPresent);
        },
        async put(pointer) {
            const { pointerKey, ...fields } = pointer;
            await session.set("access.modelBrokerGatewayTokens.put", modelBrokerPointerKey(pointerKey), ref(pointerKey), encodeDocument(fields, STORED_AS_NUMBERS));
        },
        async delete(pointerKey) {
            await session.delete("access.modelBrokerGatewayTokens.delete", modelBrokerPointerKey(pointerKey), ref(pointerKey));
        },
    };
}
export function createFirestoreAccessRepositories(session) {
    return {
        gatewayTickets: createGatewayTicketsRepository(session),
        controlTickets: createControlTicketsRepository(session),
        controlSessions: createControlSessionsRepository(session),
        accessAudit: createAccessAuditRepository(session),
        modelBrokerTokens: createModelBrokerTokensRepository(session),
        modelBrokerGatewayTokens: createModelBrokerGatewayTokensRepository(session),
    };
}
