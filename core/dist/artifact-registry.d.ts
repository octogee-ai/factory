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
/** The referenced tags this env currently pins for `service` (keep-<env>- stripped). */
export declare function listKeepTags(opts: PinCoords & {
    service: string;
    env: string;
}): Promise<string[]>;
export {};
