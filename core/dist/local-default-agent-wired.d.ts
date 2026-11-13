export interface OpenclawConfig {
    agents?: {
        defaults?: Record<string, unknown>;
        list?: Array<unknown>;
        entries?: Record<string, unknown>;
    };
    channels?: {
        mattermost?: {
            accounts?: Record<string, unknown>;
        };
    };
    bindings?: Array<unknown>;
    session?: Record<string, unknown>;
}
/** Read + parse the openclaw config once; null on any read/parse failure. */
export declare function readOpenclawConfig(configPath: string): OpenclawConfig | null;
export declare function hasReadableOpenclawConfig(configPath: string): boolean;
export declare function isSafeConfiguredAgentId(value: unknown): value is string;
export declare function isPortableConfiguredAgentId(value: unknown): value is string;
export declare function configuredSafeAgentIds(configPath: string): string[];
export declare function configuredSafeAgentIdsFromConfig(config: OpenclawConfig): string[];
export interface ConfiguredUserPortableStatePath {
    relativePath: string;
    kind: "directory" | "file";
}
export interface ConfiguredUserPortableStatePlan {
    agentIds: string[];
    agentDirs: string[];
    sessionStorePaths: string[];
    paths: ConfiguredUserPortableStatePath[];
}
export declare function configuredUserPortableStatePlanFromConfig(config: OpenclawConfig, stateDir: string): ConfiguredUserPortableStatePlan;
export declare function configuredUserPortableStatePlan(configPath: string, stateDir: string): ConfiguredUserPortableStatePlan;
export declare function configuredUserStatePlanAllowsEntry(raw: string, plan: ConfiguredUserPortableStatePlan): boolean;
export declare function assertConfiguredUserPortableStatePlanOnDisk(stateDir: string, plan: ConfiguredUserPortableStatePlan): void;
/**
 * True iff `slug`'s agent is fully wired in an already-parsed config: its agent
 * agent is in `agents.list` or keyed `agents.entries`, its `{slug}-coach` Mattermost account exists, and
 * a Mattermost binding references both the agent agent and that account. Pure:
 * callers that check many slugs parse the config once (see readOpenclawConfig).
 */
export declare function defaultAgentWiredInParsedConfig(config: OpenclawConfig, slug: string): boolean;
/** Convenience single-slug check (reads + parses the config per call). */
export declare function userDefaultAgentWiredInOpenclawConfig(configPath: string, slug: string): boolean;
/** True iff the slug's mount-completion marker is present (the LAST step a successful
 *  ensure writes). Never throws — an absent dir/marker is simply false. */
export declare function hasMountedMarker(usersDir: string, slug: string): boolean;
/** Stamp the mount-completion marker — the LAST step of a successful ensure, written only
 *  after the user is fully provisioned. Ensures .system/ exists first. */
export declare function writeMountedMarker(usersDir: string, slug: string): void;
export declare function clearMountedMarker(usersDir: string, slug: string): void;
export declare function _resetMigratingInProcessPinsForTests(): void;
/** True iff a migrating-in pin exists for the slug AND is newer than ttlMs. Never throws. */
export declare function isMigratingInPinned(usersDir: string, slug: string, ttlMs: number): boolean;
/**
 * Stamp the migrating-in pin (import handler, before activation). Ensures .system/ exists.
 * Also clears any .mounted marker that rode in on the migration tarball: an import is NOT a
 * completed mount on THIS pod, so the target must re-earn its own marker after cutover rather
 * than inherit the source's — keeping .mounted single-writer (a pod's own ensure) and the
 * post-config wedge guard intact.
 */
export declare function writeMigratingInPin(usersDir: string, slug: string): void;
export declare function clearMigratingInPin(usersDir: string, slug: string): void;
export declare function listMigratingInSlugs(usersDir: string, ttlMs: number): string[];
/**
 * Raw on-disk user dirs (safe-slug-named directories under usersDir), WITHOUT the
 * default-agent-wired filter. The reconcile's evict direction observes this — so a partial/junk dir
 * left by a mount that died before its config patch is still drained once it's unassigned
 * (default-agent-wired presence would never see it). Never throws — a missing dir is [].
 */
export declare function listLocalUserDirs(usersDir: string): string[];
/**
 * The pod's honest mounted set, read WITHOUT Firestore: user dirs present on the
 * PVC whose agent is wired. The fleet controller polls this via /health and intersects it with the
 * assigned roster on the trusted side; the chat-proxy uses it to reconcile agents.
 */
export declare function listLocalDefaultAgentWiredSlugs(usersDir: string, isDefaultAgentWired: (slug: string) => boolean): string[];
