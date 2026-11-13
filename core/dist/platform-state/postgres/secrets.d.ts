import type { AccessRepositories, UserSecretKind, SecretsRepository } from "../secrets.js";
import type { PostgresSession } from "./session.js";
export declare function secretKindOf(secretId: string): UserSecretKind;
export declare function createPostgresSecretsRepository(session: PostgresSession): SecretsRepository;
export declare function gatewayAccessDenialAuditId(gatewayId: string, granteeUid: string, reason: string, at: number): string;
export declare function createPostgresAccessRepositories(session: PostgresSession): AccessRepositories;
