import { type ChannelIdentitiesRepository, type ChannelIdentity, type ChannelIdentityOwnerKind } from "../channel-identities.js";
import { type PlatformAggregate, type RecordKey } from "../errors.js";
import type { PostgresSession } from "./session.js";
export interface ChannelIdentityDuplicate {
    readonly aggregate: PlatformAggregate;
    readonly lookup: string;
}
export declare function managedExternalUserIdOf(ownerKind: ChannelIdentityOwnerKind, ownerColumn: string): string;
export declare function managedOwnerIdOf(ownerKind: ChannelIdentityOwnerKind, externalUserIdSql: string): string;
export declare function linkChannelIdentity(session: PostgresSession, operation: string, record: RecordKey, identity: ChannelIdentity, duplicate: ChannelIdentityDuplicate): Promise<void>;
export declare function clearManagedChannelIdentity(session: PostgresSession, operation: string, record: RecordKey, ownerKind: ChannelIdentityOwnerKind, ownerId: string): Promise<void>;
export declare function createPostgresChannelIdentitiesRepository(session: PostgresSession): ChannelIdentitiesRepository;
