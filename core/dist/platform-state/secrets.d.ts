import type { OpaqueMap, Revision, Stored, TimeInput } from "./store.js";
export type UserSecretKind = "builder-mattermost" | "coach-mattermost" | "project-agent-mattermost" | "connector";
export interface MattermostTokenSecret {
    readonly kind: "builder-mattermost" | "coach-mattermost" | "project-agent-mattermost";
    readonly secretId: string;
    readonly projectId: string | null;
    readonly personalToken: string;
    readonly mattermostUserId: string | null;
    readonly createdAt: number | null;
    readonly rotatedAt: number | null;
}
export interface ConnectorTokenSecret {
    readonly kind: "connector";
    readonly secretId: string;
    readonly encryptedAccessToken: string | null;
    readonly encryptedRefreshToken: string | null;
    readonly detail: OpaqueMap;
}
export type UserSecret = MattermostTokenSecret | ConnectorTokenSecret;
export type UserSecretInput = (Omit<MattermostTokenSecret, "createdAt" | "rotatedAt"> & {
    readonly createdAt: TimeInput | null;
    readonly rotatedAt: TimeInput | null;
}) | ConnectorTokenSecret;
export interface SecretsRepository {
    get(uid: string, secretId: string): Promise<Stored<UserSecret> | null>;
    list(uid: string, kind?: UserSecretKind): Promise<readonly Stored<UserSecret>[]>;
    put(uid: string, secret: UserSecretInput): Promise<void>;
    delete(uid: string, secretId: string): Promise<void>;
}
export interface GatewayTicket {
    readonly ticketId: string;
    readonly uid: string;
    readonly gatewayId: string;
    readonly expiresAt: number;
    readonly grant: OpaqueMap;
}
export interface GatewayTicketMint {
    readonly uid: string;
    readonly purpose: string;
    readonly mintedAt: number;
    readonly expiresAt: number;
}
export interface GatewayTicketsRepository {
    get(ticketId: string): Promise<Stored<GatewayTicket> | null>;
    create(ticket: GatewayTicket): Promise<void>;
    countLive(uid: string, purpose: string, now: number): Promise<number>;
    countMintsSince(uid: string, purpose: string, since: number): Promise<number>;
    recordMint(mint: GatewayTicketMint): Promise<void>;
    patchGrant(ticketId: string, patch: OpaqueMap, fence?: {
        readonly revision?: Revision;
    }): Promise<void>;
    delete(ticketId: string, fence?: {
        readonly revision?: Revision;
    }): Promise<void>;
}
export interface ControlTicket {
    readonly ticketHash: string;
    readonly gatewayId: string;
    readonly uid: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly redeemedAt: number | null;
    readonly grant: OpaqueMap;
}
export interface ControlTicketsRepository {
    get(ticketHash: string): Promise<Stored<ControlTicket> | null>;
    create(ticket: Omit<ControlTicket, "createdAt"> & {
        readonly createdAt: TimeInput;
    }): Promise<void>;
    markRedeemed(ticketHash: string, redeemedAt: number, fence: {
        readonly redeemedAt: null;
    }): Promise<void>;
}
export interface ControlSession {
    readonly sessionHash: string;
    readonly gatewayId: string;
    readonly uid: string;
    readonly createdAt: number | null;
    readonly expiresAt: number;
    readonly attachmentId: string | null;
    readonly grant: OpaqueMap;
}
export interface ControlSessionsRepository {
    get(sessionHash: string): Promise<Stored<ControlSession> | null>;
    put(session: ControlSession): Promise<void>;
    delete(sessionHash: string): Promise<void>;
}
export type ModelBrokerProvider = "anthropic" | "vertex" | "openrouter" | "openai" | "meta";
export type ModelBrokerTokenPurpose = "model" | "embeddings";
export interface ModelBrokerTokenLimits {
    readonly spendWindowUsd: number | null;
    readonly spendWeekUsd: number | null;
    readonly requestsPerMinute: number | null;
}
export interface ModelBrokerToken {
    readonly tokenHash: string;
    readonly gatewayId: string;
    readonly ownerUid: string | null;
    readonly provider: ModelBrokerProvider;
    readonly purpose: ModelBrokerTokenPurpose;
    readonly secretName: string;
    readonly createdAt: number;
    readonly expiresAt: number | null;
    readonly limits: ModelBrokerTokenLimits;
    readonly railPolicy: OpaqueMap;
    readonly trace: OpaqueMap | null;
    readonly revoked: boolean;
    readonly revokedAt: number | null;
}
export interface ModelBrokerTokensRepository {
    get(tokenHash: string): Promise<Stored<ModelBrokerToken> | null>;
    listForOwner(ownerUid: string): Promise<readonly Stored<ModelBrokerToken>[]>;
    create(token: ModelBrokerToken): Promise<void>;
    revoke(tokenHash: string, revokedAt: number): Promise<void>;
    delete(tokenHash: string): Promise<void>;
}
export interface ModelBrokerGatewayToken {
    readonly pointerKey: string;
    readonly gatewayId: string;
    readonly ownerUid: string | null;
    readonly provider: ModelBrokerProvider;
    readonly secretName: string;
    readonly tokenHash: string;
    readonly updatedAt: number;
}
export interface ModelBrokerGatewayTokensRepository {
    get(pointerKey: string): Promise<Stored<ModelBrokerGatewayToken> | null>;
    listForOwner(ownerUid: string): Promise<readonly Stored<ModelBrokerGatewayToken>[]>;
    put(pointer: ModelBrokerGatewayToken): Promise<void>;
    delete(pointerKey: string): Promise<void>;
}
export interface GatewayAccessDenial {
    readonly at: number;
    readonly gatewayId: string;
    readonly uid: string | null;
    readonly reason: string;
    readonly detail: OpaqueMap;
}
export interface GatewayAccessAuditRepository {
    record(denial: GatewayAccessDenial): Promise<string>;
}
export interface AccessRepositories {
    readonly gatewayTickets: GatewayTicketsRepository;
    readonly controlTickets: ControlTicketsRepository;
    readonly controlSessions: ControlSessionsRepository;
    readonly accessAudit: GatewayAccessAuditRepository;
    readonly modelBrokerTokens: ModelBrokerTokensRepository;
    readonly modelBrokerGatewayTokens: ModelBrokerGatewayTokensRepository;
    listRecordsForUid(uid: string): Promise<readonly string[]>;
    eraseForUid(uid: string): Promise<void>;
}
