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
/** Pin the image behind `service:tag` with a `keep-<env>-<tag>` tag so the
 *  cleanup policy retains it while a gateway references it. Idempotent. */
export declare function ensureKeepTag(opts: PinOpts): Promise<void>;
/** Release a `keep-<env>-<tag>` pin (image becomes eligible for the time-based
 *  cleanup once no env still pins it). Idempotent — 404 is already-gone. */
export declare function removeKeepTag(opts: PinOpts): Promise<void>;
declare const RELEASE_MANIFEST_SURFACE_IMAGES: {
    readonly gateway: readonly ["gateway-edge", "octogee-gateway", "octogee-gateway-operator"];
    readonly platform: readonly ["artifact-worker", "glm-controller", "octogee-api", "octogee-ops-agent", "octogee-project-runner"];
};
export interface ReleaseDigestManifest {
    sourceSha: string;
    manifestDigest: string;
    openclawVersion: string;
    repository: string;
    surfaces: {
        gateway: Record<(typeof RELEASE_MANIFEST_SURFACE_IMAGES.gateway)[number], string>;
        platform: Record<(typeof RELEASE_MANIFEST_SURFACE_IMAGES.platform)[number], string>;
    };
}
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
export interface CentralReleaseAuthority {
    resolveManifest: (sourceSha: string) => Promise<ReleaseDigestManifest>;
    resolveTestManifest: (version: string) => Promise<ReleaseDigestManifest>;
    aliasesFor: (manifest: ReleaseDigestManifest) => ReleaseDigestAlias[];
    testRecordAlias: (version: string, manifest: ReleaseDigestManifest) => ReleaseDigestAlias;
    ensureAliases: (aliases: readonly ReleaseDigestAlias[]) => Promise<ReleaseDigestAliasOutcome[]>;
}
export interface CentralReleaseAuthorityCoordinates {
    project: string;
    location: string;
    repository: string;
}
export declare function createCentralReleaseAuthority(coordinates: CentralReleaseAuthorityCoordinates): CentralReleaseAuthority;
/** The referenced tags this env currently pins for `service` (keep-<env>- stripped). */
export declare function listKeepTags(opts: PinCoords & {
    service: string;
    env: string;
}): Promise<string[]>;
export {};
