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
/**
 * Walk `distDir`, gzip + sha256 each file, and return the Hosting deploy manifest
 * plus the gzipped blobs keyed by hash. Pure filesystem work — no credentials.
 * Null if no dist.
 */
export declare function collectDistFiles(distDir: string): CollectedFiles | null;
export interface DeployCollectedOptions {
    getToken: HostingTokenGetter;
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
}
/**
 * Deploy already-collected files to a Hosting site: create a version, populate the
 * file manifest, upload only the blobs Hosting reports missing, finalize, release.
 * `getToken` supplies the Hosting access token from whatever ADC is in scope.
 */
export declare function deployCollectedFiles(siteId: string, collected: CollectedFiles, opts: DeployCollectedOptions): Promise<DeployResult>;
