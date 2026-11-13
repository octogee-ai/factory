import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
export interface GatewayBuild {
    tag: string;
    pushedAt: string;
    digest: string;
}
interface ListOpts {
    service: string;
    limit?: number;
    project?: string;
    location?: string;
    repository?: string;
}
export declare function listGatewayBuilds(opts: ListOpts): Promise<GatewayBuild[]>;
interface PinCoords {
    project?: string;
    location?: string;
    repository?: string;
}
interface PinOpts extends PinCoords {
    service: string;
    env: string;
    tag: string;
}
export declare function ensureKeepTag(opts: Omit<PinOpts, "tag"> & {
    digest: string;
}): Promise<void>;
/** Release a `keep-<env>-<tag>` pin (image becomes eligible for the time-based
 *  cleanup once no env still pins it). Idempotent — 404 is already-gone. */
export declare function removeKeepTag(opts: PinOpts): Promise<void>;
export interface ReleaseDigestManifest {
    desktopImage?: unknown;
    sourceSha: string;
    manifestDigest: string;
    openclawVersion: string;
    openclawSourceSha?: string;
    repository: string;
    surfaces: {
        gateway: Record<string, string>;
        platform: Record<string, string>;
    };
}
export declare function centralGatewayReleasePayload(manifest: ReleaseDigestManifest): ReleasePayload;
export interface ReleaseDigestAlias {
    alias: string;
    intendedTarget: string;
}
export interface ReleaseDigestAliasOutcome {
    alias: string;
    status: "applied" | "already-applied" | "failed";
    observedTarget?: string | null;
    error?: string;
}
export declare class ReleaseDigestAliasError extends Error {
    readonly aliasOutcomes: ReleaseDigestAliasOutcome[];
    constructor(aliasOutcomes: ReleaseDigestAliasOutcome[], cause: unknown);
}
export declare class ReleaseDigestManifestNotFoundError extends Error {
    readonly sourceSha: string;
    constructor(sourceSha: string);
}
export interface CentralReleaseAuthority {
    resolveManifest: (sourceSha: string) => Promise<ReleaseDigestManifest>;
    aliasesFor: (manifest: ReleaseDigestManifest) => ReleaseDigestAlias[];
    keepTagsFor: (environment: "test" | "prod", manifest: ReleaseDigestManifest) => ReleaseDigestAlias[];
    ensureAliases: (aliases: readonly ReleaseDigestAlias[]) => Promise<ReleaseDigestAliasOutcome[]>;
}
export interface CentralReleaseAuthorityCoordinates {
    project: string;
    location: string;
    repository: string;
}
/** Injectable so the generator/authority contract can be exercised without
 *  Application Default Credentials — CI has none, and a contract test must not
 *  depend on the ambient cloud identity of whoever runs it. */
export interface CentralReleaseAuthorityDeps {
    getAccessToken?: () => Promise<string>;
}
export declare function createCentralReleaseAuthority(coordinates: CentralReleaseAuthorityCoordinates, deps?: CentralReleaseAuthorityDeps): CentralReleaseAuthority;
/** The referenced tags this env currently pins for `service` (keep-<env>- stripped). */
export declare function listKeepTags(opts: PinCoords & {
    service: string;
    env: string;
}): Promise<string[]>;
export {};
