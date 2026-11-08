import type { Stored } from "./store.js";
export interface ChannelInstallation {
    readonly provider: string;
    readonly installation: string;
}
export declare const MANAGED_CHANNEL_INSTALLATION: ChannelInstallation;
export declare const MANAGED_GIT_HOST = "managed";
export type ChannelIdentityOwnerKind = "user" | "agent";
export interface ChannelIdentity extends ChannelInstallation {
    readonly externalUserId: string;
    readonly ownerKind: ChannelIdentityOwnerKind;
    readonly ownerId: string;
}
export interface ChannelIdentitiesRepository {
    find(installation: ChannelInstallation, externalUserId: string): Promise<Stored<ChannelIdentity> | null>;
    listForOwner(ownerId: string): Promise<readonly Stored<ChannelIdentity>[]>;
    link(identity: ChannelIdentity): Promise<void>;
    unlink(installation: ChannelInstallation, externalUserId: string): Promise<void>;
}
