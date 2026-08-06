import type { AgentModelSelections } from "@octogee/shared/types/agent-models";
import type { CustomerSnapshot } from "@octogee/shared/types/fleet-controller";
import type { FleetBrokerProjectCheckoutScope, FleetBrokerProjectAgent, FleetBrokerProjectRestore, FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { ProjectRepoSource } from "@octogee/shared/types/project";
import type { MigrationActivationManifest } from "./migration-activation-manifest.js";
export interface UserSnapshot {
    uid: string;
    slug: string;
    tier: string;
    gatewayId: string;
    status: "" | "provisioning" | "complete";
    agentIds: string[];
    repoUrl: string;
    mattermostUserId: string | null;
    greetingPosted: boolean;
    channels: CustomerSnapshot["channels"];
    ownerName: string;
    projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
    projects?: FleetBrokerProjectRestore[];
    projectAgents?: FleetBrokerProjectAgent[];
    byotActive?: boolean;
    selectedTier?: unknown;
    subscription?: unknown;
    builderSubscription?: unknown;
    trialGrant?: unknown;
    signupOfferConvertedAt?: unknown;
    freeTierModelRef?: string;
    builderAgentDefault?: {
        primary: string;
        fallbacks: string[];
    };
    systemConfig?: {
        byot?: {
            provider?: string;
            baseUrl?: string;
            model?: string;
        };
        agentModels?: AgentModelSelections;
    };
}
export interface ProjectCloneTarget {
    projectSlug: string;
    giteaRepoName: string | null;
    repoSource?: ProjectRepoSource | null;
}
export interface ProjectCloneOptions {
    repoSource?: ProjectRepoSource | null;
}
export interface CustomerContext {
    uid: string;
    slug: string;
    tier: string;
    ownerName: string;
    customerDir: string;
    today: string;
    username: string;
    templateVars: Record<string, string>;
    userData: Record<string, unknown>;
}
export type MmUpdate = Record<string, unknown>;
export interface CustomerLifecycleAdapter {
    log: (msg: string) => void;
    isOperatorGateway?: () => boolean;
    /**
     * Re-run the platform broker-profile materialization for this customer's
     * agents. Only openclaw creates an agent's auth-profile store, so the mount's
     * first attempt runs too early and defers; this is called once the coach is
     * confirmed running+connected, when the store is guaranteed to exist.
     */
    materializeBrokerProfiles?: (slug: string) => void;
    /**
     * Read-only probe of the on-disk openclaw.json: is this customer's
     * coach fully wired (agent registered + MM account configured + at
     * least one binding linking the agent to the MM account)?
     * `applyAddCustomerConfigPatch` writes all three together — so a
     * state where only the agent is present means a prior config.patch
     * crashed mid-flight OR openclaw.json was hand-edited. The operator
     * short-circuit MUST NOT skip the full flow in either case, because
     * the agent will sit inert (no MM auth, no inbound routing) — which
     * is exactly what bender hit on 2026-05-26.
     */
    customerCoachWiredInOpenclawConfig?: (slug: string) => boolean;
    hasCustomerAgentRuntime?: (slug: string) => boolean;
    projectCheckoutScope?: (slug: string) => FleetBrokerProjectCheckoutScope;
    /** Locally-present, coach-wired customer slugs — the pod's honest mounted set
     *  read WITHOUT Firestore, served via /health for Cowboy's pull-model poller.
     *  Also the reconcile's heartbeat report + mount-observed basis. */
    listLocalCustomerSlugs?: () => string[];
    /** Raw on-disk customer dirs (no coach-wired filter) — the reconcile's evict-observed set,
     *  so a partial/junk dir from a mount that died before its config patch is still drained
     *  once unassigned. */
    listLocalCustomerDirs?: () => string[];
    /** True iff the slug's mount-completion marker is present — the LAST step a successful
     *  ensure writes, AFTER the customer is fully provisioned (not merely coach-wired). The
     *  reconcile's mount direction keys off this, so a coach-wired-but-incomplete mount
     *  (config patch landed, then greeting / mark-complete failed) is re-ensured rather than
     *  silently treated as done. */
    customerMountMarked?: (slug: string) => boolean;
    /** Stamp the mount-completion marker for the slug — the final step of a successful mount. */
    writeMountMarker?: (slug: string) => void;
    /** True iff the slug has a fresh migrating-in pin — a migration imported + coach-wired it
     *  here, but cutover hasn't yet made it desired-here. The reconcile's evict direction skips
     *  such slugs so it doesn't drain a freshly-imported customer mid-migration. */
    customerMigratingIn?: (slug: string) => boolean;
    /** Stamp the migrating-in pin (import handler, before activation). */
    markCustomerMigratingIn?: (slug: string) => void;
    /** On-disk slugs with a fresh migrating-in pin — reported via /health so Cowboy's operator
     *  poller skips them as eviction candidates pre-cutover (the operator path has no in-pod
     *  reconcile to honor the pin). */
    listMigratingInSlugs?: () => string[];
    loadUserSnapshot: (uid: string) => Promise<UserSnapshot | null>;
    seedUserSnapshotForMigration?: (snapshot: FleetBrokerUserSnapshot) => void;
    setProvisioningStatus: (uid: string, status: "provisioning" | "complete") => Promise<void>;
    setRepoUrl: (uid: string, repoUrl: string) => Promise<void>;
    setMattermostFields: (uid: string, fields: MmUpdate) => Promise<void>;
    setGreetingResult: (uid: string, result: {
        ok: true;
        jobId: string;
    } | {
        ok: false;
        error: string;
    }) => Promise<void>;
    setAgentIds: (uid: string, agentIds: string[]) => Promise<void>;
    hasCustomerDir: (slug: string) => boolean;
    hasWorkspaceGitDir: (slug: string) => boolean;
    hasGitRemote: (slug: string) => boolean;
    ensureCustomerDirectories: (slug: string) => void;
    writeCustomerTemplateFiles: (ctx: CustomerContext) => Promise<void>;
    deleteCustomerDir: (slug: string) => Promise<void>;
    cloneWorkspaceRepo: (slug: string, repoUrl: string) => Promise<boolean>;
    initWorkspaceRepoFromExistingDir: (ctx: CustomerContext) => Promise<string | null>;
    hasCustomerSshKey: (slug: string) => boolean;
    generateCustomerSshKey: (slug: string) => string;
    createGiteaUser: (slug: string, pubKey: string) => Promise<void>;
    ensureGiteaOrg: (slug: string) => Promise<void>;
    readLocalCustomerPubKey: (slug: string) => string | null;
    readGiteaCustomerPubKeys: (slug: string) => Promise<string[]>;
    deleteCustomerSshKey: (slug: string) => Promise<void>;
    blobSyncForSlug: (slug: string) => Promise<void>;
    restoreByosubForAgent: (slug: string) => Promise<{
        restored: boolean;
        present: boolean;
    }>;
    reassertByotForCustomer: (userData: Record<string, unknown>) => Promise<void>;
    reassertConvergedContextFilesForCustomer: (userData: Record<string, unknown>) => Promise<void>;
    listProjectsNeedingClone: (slug: string) => Promise<ProjectCloneTarget[]>;
    cloneProjectRepo: (customerSlug: string, projectSlug: string, giteaRepoName: string | null, opts?: ProjectCloneOptions) => Promise<boolean>;
    provisionMattermostUser: (ctx: CustomerContext) => Promise<MmUpdate>;
    /**
     * Idempotently ensure this Builder is a member of the shared Octogee Community
     * team + chat channels. Optional — adapters that don't own Mattermost community
     * reconciliation (migration/local tooling) may omit it. Runs at provision AND on
     * every re-mount (gateway restart), so an existing Builder self-heals without a
     * fresh MM-provisioning event.
     */
    reconcileCommunityMembership?: (ctx: CustomerContext) => Promise<void>;
    scheduleBootGreetingCron: (params: {
        slug: string;
        agentId: string;
        accountId: string;
    }) => Promise<{
        jobId: string;
    }>;
    /**
     * Detached, non-blocking, non-fatal safety net for the boot greeting.
     * After the agent-greeting cron is scheduled, this waits a grace delay,
     * re-checks the coach DM channel, and posts a static greeting AS THE COACH
     * if the agent turn failed to land one (so the onboarding `agentPosted`
     * gate flips true). Optional so test/other adapters don't have to implement
     * it. Implementations MUST be fire-and-forget (resolve immediately, do the
     * work in the background) and MUST NOT throw — the orchestrator does not
     * await it. The prod adapter resolves coachUserId, channelId, and the coach
     * PAT from Firestore internally; the orchestrator only knows {slug, uid}.
     */
    ensureBootGreetingFallback?: (params: {
        slug: string;
        uid: string;
    }) => void;
    applyAddCustomerConfigPatch: (snapshot: UserSnapshot, mmUpdate: MmUpdate | null, opts?: {
        signal?: AbortSignal;
        byosActive?: boolean;
        evictionBatch?: readonly string[];
        currentEvictionBatch?: () => Promise<readonly string[]>;
    }) => Promise<{
        elapsedMs: number;
        appliedFingerprint?: string;
    }>;
    applyRemoveCustomerConfigPatch: (slug: string, agentId: string, evictionBatch?: readonly string[], currentEvictionBatch?: () => Promise<readonly string[]>) => Promise<readonly string[] | void>;
    cancelPendingEviction?: (slug: string) => boolean | void;
    clearMountMarker?: (slug: string) => void;
    waitForAccountHealthy: (params: {
        slug: string;
        timeoutMs: number;
    }) => Promise<boolean>;
    notifyOpsOfSignup: (ctx: CustomerContext) => Promise<void>;
    onMounted?: (slug: string) => void;
    onUnmounted?: (slug: string) => void;
    uidForSlug: (slug: string) => Promise<string | null>;
    quiesceCustomer: (slug: string, timeoutMs: number) => Promise<{
        drained: boolean;
        runningCount: number;
    }>;
    listExportPaths: (slug: string) => Promise<Array<{
        cwd: string;
        path: string;
    }>>;
    prepareImportDir: (slug: string, mode: CustomerStateImportMode) => Promise<string>;
    prepareKeyImportDir: (slug: string) => Promise<string>;
    activateImportedCustomer: (slug: string, opts?: {
        signal?: AbortSignal;
    }) => Promise<{
        appliedFingerprint: string;
    }>;
    recordAppliedFingerprint?: (slug: string, fingerprint: string) => void;
    exportOpenClawActivationManifest?: (slug: string) => Promise<MigrationActivationManifest>;
    removeImportedCustomerBySlug?: (slug: string, evictionBatch?: readonly string[], currentEvictionBatch?: () => Promise<readonly string[]>) => Promise<RemoveCustomerResult>;
}
export type CustomerStateImportMode = "pre" | "final" | "default";
export type AddCustomerStep = "claim-slot" | "ensure-dir" | "write-templates" | "clone-workspace-repo" | "init-workspace-repo" | "ssh-key" | "ssh-key-resync" | "blob-sync" | "byosub-restore" | "byot-reassert" | "context-files-reassert" | "project-clone" | "mattermost-provision" | "community-membership" | "config-patch" | "verify-channel-ready" | "schedule-greeting-cron" | "mark-complete" | "notify-ops";
export interface AddCustomerResult {
    newCustomer: boolean;
    steps: AddCustomerStep[];
    appliedFingerprint?: string;
    pendingProjectClones: string[];
}
export interface RestoreCustomerRuntimeResult {
    restored: boolean;
    steps: AddCustomerStep[];
}
export type RemoveCustomerStep = "config-patch-remove" | "delete-dir";
export interface RemoveCustomerResult {
    wasMounted: boolean;
    steps: RemoveCustomerStep[];
    retained?: boolean;
}
export declare class ConcurrentMountError extends Error {
    readonly name = "ConcurrentMountError";
    constructor(uid: string);
}
export declare function _resetInFlightUidsForTests(): void;
export declare function _inFlightUidsHasForTests(uid: string): boolean;
export interface AddCustomerOptions {
    verifyTimeoutMs?: number;
    customersDir?: string;
    mountDeadlineMs?: number;
    convergeContent?: boolean;
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
    signal?: AbortSignal;
    onSignalCreated?: (signal: AbortSignal) => void;
}
export declare function addCustomerToGateway(adapter: CustomerLifecycleAdapter, uid: string, opts?: AddCustomerOptions): Promise<AddCustomerResult>;
export declare function restoreCustomerRuntimeFromSnapshot(adapter: CustomerLifecycleAdapter, snapshot: UserSnapshot, opts?: AddCustomerOptions): Promise<RestoreCustomerRuntimeResult>;
export declare function removeCustomerFromGateway(adapter: CustomerLifecycleAdapter, uid: string, opts?: {
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
}): Promise<RemoveCustomerResult>;
export declare function pubKeysMatch(a: string, b: string): boolean;
