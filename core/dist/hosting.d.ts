export type DeployResult = {
    success: true;
    url: string;
} | {
    success: false;
    error: string;
};
export interface CollectedFiles {
    /** Hosting deploy manifest: `/url-path` → sha256 of the gzipped file. */
    files: Record<string, string>;
    /** sha256 → base64(gzip(file)). The bytes Hosting may ask us to upload. */
    blobs: Record<string, string>;
}
export type HostingTokenGetter = (scopes: string[]) => Promise<string>;
/** A Hosting `ServingConfig` header rule. */
export interface HostingHeaderRule {
    glob: string;
    headers: Record<string, string>;
}
/** A Hosting `ServingConfig` rewrite rule (static destination only). */
export interface HostingRewriteRule {
    glob: string;
    path: string;
}
export interface HostingConfig {
    headers: HostingHeaderRule[];
    rewrites?: HostingRewriteRule[];
}
/**
 * The Hosting `ServingConfig` a project's recipe deserves.
 *
 * Hosting matches real files before rewrites, so the `vite-static` SPA fallback only
 * catches paths with no file behind them — it can never shadow a published asset.
 * Hashed build output (`/assets/**`, `/_astro/**`) is immutable; everything else stays
 * on the short TTL so a republish is visible quickly.
 */
export declare function hostingConfigForRecipe(recipe: string | null): HostingConfig;
/**
 * Walk `distDir`, gzip + sha256 each file, and return the Hosting deploy manifest
 * plus the gzipped blobs keyed by hash. Pure filesystem work — no credentials.
 * Null if no dist.
 */
export declare function collectDistFiles(distDir: string): CollectedFiles | null;
/**
 * A copy of `collected` with one more file in the manifest, gzipped + hashed the same
 * way `collectDistFiles` does. Lets a caller add bytes that were never on disk — the
 * publish-time social image — without re-walking the artifact.
 */
export declare function withCollectedFile(collected: CollectedFiles, urlPath: string, contents: Buffer): CollectedFiles;
export interface HostingApiOptions {
    getToken: HostingTokenGetter;
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
}
export interface DeployCollectedOptions extends HostingApiOptions {
    /** Serving config baked into the version. Defaults to the recipe-less config. */
    config?: HostingConfig;
}
export type UploadVersionResult = {
    success: true;
    versionName: string;
} | {
    success: false;
    error: string;
};
export type ReleaseResult = {
    success: true;
} | {
    success: false;
    error: string;
};
export type ChannelResult = {
    success: true;
    url: string;
    expireTime: string;
} | {
    success: false;
    error: string;
};
export interface HostingReleaseSummary {
    versionName: string;
    releaseTime: string;
    live: boolean;
    message?: string;
}
export type ListReleasesResult = {
    success: true;
    releases: HostingReleaseSummary[];
} | {
    success: false;
    error: string;
};
/**
 * Create a version carrying the recipe's serving config, populate its manifest, upload
 * only the blobs Hosting reports missing, and finalize it. The result is a version that
 * is ready to be released — to the live channel or to a preview channel.
 */
export declare function uploadVersion(siteId: string, collected: CollectedFiles, opts: DeployCollectedOptions): Promise<UploadVersionResult>;
/**
 * Point the site's live channel at `versionName`. This is both the last step of a deploy
 * and — when the version is an older one — a Hosting rollback: the history gains a new
 * release rather than losing one.
 */
export declare function releaseVersion(siteId: string, versionName: string, opts: HostingApiOptions): Promise<ReleaseResult>;
/**
 * Deploy already-collected files to a Hosting site's live channel: upload a version
 * carrying the recipe's serving config, then release it.
 */
export declare function deployCollectedFiles(siteId: string, collected: CollectedFiles, opts: DeployCollectedOptions): Promise<DeployResult>;
/**
 * Create the preview channel, or extend an existing one's TTL.
 *
 * `channelId` is immutable, so a second create returns ALREADY_EXISTS (409); the
 * documented way to move the expiry out is PATCH with `updateMask=ttl` (`ttl` is an
 * input-only Channel field that rewrites `expireTime`). Both verbs answer with the
 * Channel resource, whose `url` is the preview address.
 */
export declare function ensureChannel(siteId: string, channelId: string, ttlSeconds: number, opts: HostingApiOptions): Promise<ChannelResult>;
/** Point a preview channel at an already-finalized version. */
export declare function releaseToChannel(siteId: string, channelId: string, versionName: string, opts: HostingApiOptions): Promise<ReleaseResult>;
/**
 * The site's live-channel release history, newest first. Only releases that still name a
 * version are returned — a release without one (a site-disable) is not a rollback target.
 */
export declare function listReleases(siteId: string, opts: HostingApiOptions & {
    pageSize?: number;
}): Promise<ListReleasesResult>;
