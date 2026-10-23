import { withLogContext, setLogContext } from "@octogee/shared/server/service-logger";
import { projectCheckoutEnabled } from "@octogee/shared/types/project";
import { ADD_CUSTOMER_DEADLINE_MS, VERIFY_ACCOUNT_TIMEOUT_MS, } from "@octogee/shared/types/fleet-controller";
import { pickPlanInputs } from "@octogee/shared/types/billing";
import { UNKNOWN_TIME_ZONE } from "./context-file-convergence.js";
const VERIFY_CHANNEL_READY = "verify-channel-ready";
const CONFIG_PATCH = "config-patch";
const CONVERGED_STATE_STEPS = ["byot-reassert", "context-files-reassert"];
const inFlightUids = new Map();
export class ConcurrentMountError extends Error {
    name = "ConcurrentMountError";
    constructor(uid) {
        super(`[add:${uid}] another mount is already in-flight for this uid in this process`);
    }
}
export function _resetInFlightUidsForTests() {
    inFlightUids.clear();
}
export function _inFlightUidsHasForTests(uid) {
    return inFlightUids.has(uid);
}
export async function addCustomerToGateway(adapter, uid, opts = {}) {
    return withLogContext({}, async () => {
        return runUidMountExclusive(uid, opts, (signal, markStep) => addCustomerToGatewayInner(adapter, uid, { ...opts, signal, markStep }));
    });
}
export async function restoreCustomerRuntimeFromSnapshot(adapter, snapshot, opts = {}) {
    return withLogContext({}, async () => {
        setLogContext({ builderSlug: snapshot.slug, category: "lifecycle" });
        return runUidMountExclusive(snapshot.uid, opts, (signal, markStep) => restoreCustomerRuntimeFromSnapshotInner(adapter, snapshot, { ...opts, signal, markStep }));
    });
}
async function runUidMountExclusive(uid, opts, work) {
    if (inFlightUids.has(uid)) {
        throw new ConcurrentMountError(uid);
    }
    const claim = Symbol(uid);
    inFlightUids.set(uid, claim);
    const release = () => {
        if (inFlightUids.get(uid) === claim)
            inFlightUids.delete(uid);
    };
    let workSettled;
    const deadlineMs = opts.mountDeadlineMs ?? ADD_CUSTOMER_DEADLINE_MS;
    const controller = new AbortController();
    let step = "load-snapshot";
    const markStep = (next) => {
        step = next;
    };
    const externalAbortListener = () => controller.abort(opts.signal?.reason);
    if (opts.signal?.aborted) {
        controller.abort(opts.signal.reason);
    }
    else if (opts.signal) {
        opts.signal.addEventListener("abort", externalAbortListener, { once: true });
    }
    let timer = null;
    if (!controller.signal.aborted && Number.isFinite(deadlineMs) && deadlineMs > 0) {
        timer = setTimeout(() => controller.abort(new Error(`[add:${uid}] mountDeadlineMs=${deadlineMs}ms exceeded — step "${step}" is hung; retaining in-flight lock until work settles`)), deadlineMs);
    }
    try {
        opts.onSignalCreated?.(controller.signal);
        let workPromise;
        try {
            workPromise = work(controller.signal, markStep);
        }
        catch (error) {
            workPromise = Promise.reject(error);
        }
        workSettled = workPromise.then(() => undefined, () => undefined);
        void workSettled.then(release);
        opts.onWorkSettled?.(workSettled);
        return await raceWithSignal(workPromise, controller.signal);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        opts.signal?.removeEventListener("abort", externalAbortListener);
        if (!workSettled)
            release();
    }
}
function raceWithSignal(work, signal) {
    work.catch(() => { });
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("aborted"));
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        work.then((v) => {
            signal.removeEventListener("abort", onAbort);
            resolve(v);
        }, (e) => {
            signal.removeEventListener("abort", onAbort);
            reject(e);
        });
    });
}
async function restoreCustomerRuntimeFromSnapshotInner(adapter, snapshot, opts) {
    const verifyTimeoutMs = opts.verifyTimeoutMs ?? VERIFY_ACCOUNT_TIMEOUT_MS;
    const customersDir = opts.customersDir ?? "/home/node/.openclaw/customers";
    const ctx = buildCustomerContext(snapshot, customersDir);
    const steps = [];
    const { signal } = opts;
    const markStep = opts.markStep ?? (() => { });
    const { slug, uid } = snapshot;
    const startedAt = Date.now();
    adapter.log(`[restore:${slug}] starting durable restore for migration (repoUrl=${snapshot.repoUrl ? "set" : "empty"}, projects=${snapshot.projects?.length ?? 0})`);
    throwIfAborted(signal, uid);
    markStep("ssh-key");
    steps.push(...(await ensureSshKeyAndGitea(adapter, slug, true)));
    throwIfAborted(signal, uid);
    markStep("workspace-repo");
    const workspaceSteps = snapshot.repoUrl
        ? await convergeWorkspaceCheckout(adapter, uid, snapshot, ctx)
        : [];
    steps.push(...workspaceSteps);
    if (!workspaceSteps.includes("write-templates")) {
        adapter.ensureCustomerDirectories(slug);
        await adapter.writeCustomerTemplateFiles(ctx);
        steps.push("write-templates");
    }
    throwIfAborted(signal, uid);
    markStep("project-clones");
    const projectClones = rehydratesProjectCheckouts(adapter, snapshot)
        ? await cloneProjectsFromSnapshot(adapter, snapshot, { signal })
        : { steps: [], pending: [] };
    steps.push(...projectClones.steps);
    throwIfAborted(signal, uid);
    markStep("byos-restore");
    const byos = await restoreByos(adapter, slug);
    steps.push(...byos.steps);
    throwIfAborted(signal, uid);
    markStep(CONFIG_PATCH);
    const appliedFingerprint = await applyConfigPatchAndMount(adapter, snapshot, null, {
        byosActive: byos.present,
        signal,
        withoutProjectIds: projectClones.pending,
        runtimePublication: opts.runtimePublication,
    });
    steps.push(CONFIG_PATCH);
    throwIfAborted(signal, uid);
    markStep("reassert-converged");
    const reassertSteps = await reassertConvergedState(adapter, snapshot);
    steps.push(...reassertSteps);
    const convergedState = CONVERGED_STATE_STEPS.every((step) => reassertSteps.includes(step));
    throwIfAborted(signal, uid);
    markStep("community-membership");
    steps.push(...(await reconcileCommunityMembershipIfSupported(adapter, ctx)));
    throwIfAborted(signal, uid);
    markStep(VERIFY_CHANNEL_READY);
    await verifyChannelReady(adapter, slug, verifyTimeoutMs);
    steps.push(VERIFY_CHANNEL_READY);
    throwIfAborted(signal, uid);
    const admittedSnapshot = {
        ...snapshot,
        projectAgents: snapshot.projectAgents?.filter((agent) => !projectClones.pending.includes(agent.projectId)),
    };
    if (!await adapter.projectAgentsHealthy(admittedSnapshot)) {
        throw new Error(`[restore:${slug}] project agents are not connected to their configured channels`);
    }
    throwIfAborted(signal, uid);
    adapter.writeMountMarker?.(slug);
    adapter.log(`[restore:${slug}] durable restore complete in ${Date.now() - startedAt}ms`);
    return {
        restored: true,
        steps,
        pendingProjectClones: projectClones.pending,
        convergedState,
        ...(appliedFingerprint !== undefined ? { appliedFingerprint } : {}),
    };
}
function githubRepoSourceOf(target) {
    return target.repoSource?.provider === "github" ? target.repoSource : null;
}
function projectCloneOptions(target) {
    const repoSource = githubRepoSourceOf(target);
    if (!repoSource)
        return undefined;
    return { repoSource };
}
function projectCloneSourceLabel(target) {
    const repoSource = githubRepoSourceOf(target);
    return repoSource ? `github:${repoSource.owner}/${repoSource.repo}` : "Gitea";
}
function hasProjectCloneSource(target) {
    return githubRepoSourceOf(target) !== null || Boolean(target.giteaRepoName);
}
export async function cloneProjectsFromSnapshot(adapter, snapshot, options = {}) {
    const steps = [];
    const pending = [];
    const refreshOptions = {
        refreshRemote: true,
        refreshLeaseDeadlineMs: performance.now() + ADD_CUSTOMER_DEADLINE_MS,
        ...(options.signal ? { signal: options.signal } : {}),
    };
    for (const project of snapshot.projects ?? []) {
        options.signal?.throwIfAborted();
        if (project.provisioningState !== undefined && project.provisioningState !== "active")
            continue;
        if (!projectCheckoutEnabled(project.checkoutEnabled)) {
            adapter.log(`[restore:${snapshot.slug}/${project.projectSlug}] project checkout is turned off by its owner`);
            continue;
        }
        if (!hasProjectCloneSource(project)) {
            adapter.log(`[restore:${snapshot.slug}/${project.projectSlug}] ✖ project checkout skipped — no Gitea repo and no GitHub repoSource`);
            pending.push(project.projectSlug);
            continue;
        }
        try {
            const cloned = await adapter.cloneProjectRepo(snapshot.slug, project.projectSlug, project.giteaRepoName, githubRepoSourceOf(project)
                ? projectCloneOptions(project)
                : refreshOptions);
            options.signal?.throwIfAborted();
            if (cloned)
                steps.push("project-clone");
            else
                pending.push(project.projectSlug);
        }
        catch (error) {
            options.signal?.throwIfAborted();
            pending.push(project.projectSlug);
            adapter.log(`[restore:${snapshot.slug}/${project.projectSlug}] ⚠ project clone failed (non-fatal): ${String(error)}`);
        }
    }
    return { steps, pending: pending.sort() };
}
function rehydratesProjectCheckouts(adapter, snapshot) {
    const scope = snapshot.projectCheckoutScope ?? adapter.projectCheckoutScope?.(snapshot.slug);
    return scope === "workspace-and-projects";
}
function throwIfAborted(signal, uid) {
    if (!signal?.aborted)
        return;
    const reason = signal.reason;
    if (reason instanceof Error)
        throw reason;
    throw new Error(`[add:${uid}] aborted: ${String(reason ?? "operation cancelled")}`);
}
function configuredBuilderOverlayIsReady(adapter, snapshot) {
    const { slug } = snapshot;
    return snapshot.status === "complete"
        && Boolean(adapter.isBuilderGateway?.())
        && Boolean(adapter.isConfiguredBuilderCustomer?.(slug));
}
async function attachConfiguredBuilderOverlay(adapter, snapshot, opts) {
    const { slug, uid } = snapshot;
    const ctx = buildCustomerContext(snapshot, opts.customersDir);
    const steps = [];
    opts.markStep("ssh-key");
    steps.push(...(await ensureSshKeyAndGitea(adapter, slug, opts.reclaimExistingSshKey === true)));
    throwIfAborted(opts.signal, uid);
    opts.markStep("workspace-repo");
    steps.push(...(await convergeWorkspaceCheckout(adapter, uid, snapshot, ctx)));
    throwIfAborted(opts.signal, uid);
    opts.markStep("byos-restore");
    steps.push(...(await restoreByos(adapter, slug)).steps);
    throwIfAborted(opts.signal, uid);
    opts.markStep("project-clones");
    const projectClones = opts.convergeContent && rehydratesProjectCheckouts(adapter, snapshot)
        ? await cloneMissingProjects(adapter, slug)
        : { steps: [], pending: [] };
    steps.push(...projectClones.steps);
    throwIfAborted(opts.signal, uid);
    let appliedFingerprint;
    if (opts.deferRuntimeVerification) {
        adapter.log(`[add:${slug}] project runtime reconciliation deferred until OpenClaw starts`);
    }
    else if (adapter.reconcileConfiguredBuilderProjectAgents) {
        opts.markStep(CONFIG_PATCH);
        const result = await adapter.reconcileConfiguredBuilderProjectAgents(snapshot, {
            signal: opts.signal,
            withoutProjectIds: projectClones.pending,
            runtimePublication: opts.runtimePublication,
        });
        appliedFingerprint = result.appliedFingerprint;
        steps.push(CONFIG_PATCH);
        throwIfAborted(opts.signal, uid);
    }
    else if (snapshot.projectAgents?.length) {
        throw new Error(`[add:${slug}] configured Builder project reconciliation is unavailable`);
    }
    const platformCoachWired = adapter.customerCoachWiredInOpenclawConfig?.(slug) ?? false;
    if (platformCoachWired && !opts.deferRuntimeVerification) {
        adapter.log(`[add:${slug}] configured Builder overlay retained — verifying MM coach`);
        opts.markStep(VERIFY_CHANNEL_READY);
        await verifyChannelReady(adapter, slug, opts.verifyTimeoutMs);
        steps.push(VERIFY_CHANNEL_READY);
    }
    else if (!platformCoachWired) {
        adapter.log(`[add:${slug}] configured Builder overlay has no platform MM coach wiring; retaining workspace config`);
    }
    else {
        adapter.log(`[add:${slug}] configured Builder overlay runtime verification deferred without a config patch`);
    }
    if (adapter.onMounted)
        adapter.onMounted(slug);
    return { newCustomer: false, steps, pendingProjectClones: projectClones.pending, appliedFingerprint };
}
async function addCustomerToGatewayInner(adapter, uid, opts = {}) {
    const verifyTimeoutMs = opts.verifyTimeoutMs ?? VERIFY_ACCOUNT_TIMEOUT_MS;
    const customersDir = opts.customersDir ?? "/home/node/.openclaw/customers";
    const { signal } = opts;
    const markStep = opts.markStep ?? (() => { });
    const steps = [];
    const attachStartedAt = Date.now();
    throwIfAborted(signal, uid);
    const prepared = await loadAndPrepareForMount(adapter, uid, customersDir);
    let snapshot = prepared.snapshot;
    const { ctx, newCustomer } = prepared;
    const { slug } = snapshot;
    setLogContext({ builderSlug: slug, category: "lifecycle" });
    if (configuredBuilderOverlayIsReady(adapter, snapshot)) {
        if (!adapter.configuredBuilderOverlayPresent?.(slug)) {
            throw new Error(`[add:${slug}] configured Builder system-config overlay is unavailable`);
        }
        return attachConfiguredBuilderOverlay(adapter, snapshot, {
            verifyTimeoutMs,
            customersDir,
            convergeContent: opts.convergeContent,
            deferRuntimeVerification: opts.deferRuntimeVerification,
            reclaimExistingSshKey: opts.reclaimExistingSshKey,
            runtimePublication: opts.runtimePublication,
            signal,
            markStep,
        });
    }
    if (snapshot.status !== "complete") {
        markStep("claim-slot");
        await adapter.setProvisioningStatus(uid, "provisioning");
        await adapter.setAgentIds(uid, [`octogee-${slug}-coach`]);
        steps.push("claim-slot");
    }
    const brokerProfilesReady = startBrokerProfiles(adapter, slug);
    markStep("ssh-key");
    const [workspace, mm] = await settleBoth(adapter, slug, provisionWorkspace(adapter, uid, snapshot, ctx, markStep), provisionMattermostIfMissing(adapter, uid, snapshot, ctx));
    steps.push(...workspace.steps, ...mm.steps);
    throwIfAborted(signal, uid);
    if (mm.mmUpdate) {
        snapshot = (await adapter.loadUserSnapshot(uid)) ?? snapshot;
    }
    const { projectClones, byos } = workspace;
    markStep(CONFIG_PATCH);
    const appliedFingerprint = await applyConfigPatchAndMount(adapter, snapshot, mm.mmUpdate, {
        byosActive: byos.present,
        signal,
        evictionBatch: opts.evictionBatch,
        currentEvictionBatch: opts.currentEvictionBatch,
        withoutProjectIds: projectClones.pending,
        runtimePublication: opts.runtimePublication,
        ...(brokerProfilesReady ? { brokerProfilesReady } : {}),
    });
    steps.push(CONFIG_PATCH);
    throwIfAborted(signal, uid);
    markStep(VERIFY_CHANNEL_READY);
    await verifyChannelReady(adapter, slug, verifyTimeoutMs);
    steps.push(VERIFY_CHANNEL_READY);
    throwIfAborted(signal, uid);
    markStep("reassert-converged");
    steps.push(...(await reassertConvergedState(adapter, snapshot)));
    throwIfAborted(signal, uid);
    markStep("finalize");
    adapter.log(`✅ [add:${slug}] coach attach complete in ${Date.now() - attachStartedAt}ms`);
    steps.push(...(await markCompleteIfNeeded(adapter, uid, snapshot, newCustomer, mm.mmUpdate)));
    markStep("community-membership");
    steps.push(...(await reconcileCommunityMembershipIfSupported(adapter, ctx)));
    throwIfAborted(signal, uid);
    markStep("blob-sync");
    steps.push(...(await runBlobSync(adapter, slug)));
    throwIfAborted(signal, uid);
    steps.push(...(await notifyOpsIfNew(adapter, ctx, newCustomer)));
    return {
        newCustomer,
        steps,
        pendingProjectClones: projectClones.pending,
        ...(appliedFingerprint ? { appliedFingerprint } : {}),
    };
}
async function settleBoth(adapter, slug, workspace, mattermost) {
    const [workspaceResult, mattermostResult] = await Promise.allSettled([workspace, mattermost]);
    if (workspaceResult.status === "rejected" && mattermostResult.status === "rejected") {
        adapter.log(`[add:${slug}] ⚠ Mattermost provisioning also failed: ${String(mattermostResult.reason)}`);
    }
    if (workspaceResult.status === "rejected")
        throw workspaceResult.reason;
    if (mattermostResult.status === "rejected")
        throw mattermostResult.reason;
    return [workspaceResult.value, mattermostResult.value];
}
function startBrokerProfiles(adapter, slug) {
    const materialize = adapter.materializeBrokerProfiles;
    if (!materialize)
        return undefined;
    return (async () => {
        try {
            await materialize(slug);
        }
        catch (err) {
            adapter.log(`[add:${slug}] ⚠ early broker profile materialization failed (the post-verify retry and the sweep cover it): ${String(err)}`);
        }
    })();
}
async function provisionWorkspace(adapter, uid, snapshot, ctx, markStep) {
    const { slug } = snapshot;
    const steps = [];
    steps.push(...(await ensureSshKeyAndGitea(adapter, slug)));
    markStep("workspace-repo");
    steps.push(...(await ensureWorkspaceRepo(adapter, uid, snapshot, ctx)));
    markStep("project-clones");
    const projectClones = rehydratesProjectCheckouts(adapter, snapshot)
        ? await cloneMissingProjects(adapter, slug)
        : { steps: [], pending: [] };
    steps.push(...projectClones.steps);
    markStep("byos-restore");
    const byos = await restoreByos(adapter, slug);
    steps.push(...byos.steps);
    return { steps, projectClones, byos };
}
async function loadAndPrepareForMount(adapter, uid, customersDir) {
    const snapshot = await adapter.loadUserSnapshot(uid);
    if (!snapshot) {
        throw new Error(`[add:${uid}] user doc not found in Firestore`);
    }
    const newCustomer = snapshot.status !== "complete";
    const ctx = buildCustomerContext(snapshot, customersDir);
    adapter.log(`🟢 [add:${snapshot.slug}] starting (status=${snapshot.status || "<empty>"}, repoUrl=${snapshot.repoUrl ? "set" : "empty"}, mmUserId=${snapshot.mattermostUserId ? "set" : "empty"})`);
    return { snapshot, ctx, newCustomer };
}
async function ensureSshKeyAndGitea(adapter, slug, reclaimExistingSshKey = false) {
    if (!adapter.hasCustomerSshKey(slug)) {
        await registerFirstTimeSshKey(adapter, slug);
        return ["ssh-key"];
    }
    return resyncSshKeyIfDrifted(adapter, slug, reclaimExistingSshKey);
}
async function registerFirstTimeSshKey(adapter, slug) {
    const pubKey = adapter.generateCustomerSshKey(slug);
    try {
        await adapter.createGiteaUser(slug, pubKey);
        const giteaPubKeys = await adapter.readGiteaCustomerPubKeys(slug);
        if (!giteaPubKeys.some((candidate) => pubKeysMatch(candidate, pubKey))) {
            throw new Error(`Gitea did not register the new SSH key (giteaPub=${giteaPubKeys.length === 0 ? "absent" : "mismatch"})`);
        }
    }
    catch (err) {
        await adapter.deleteCustomerSshKey(slug).catch(() => { });
        throw new Error(`[add:${slug}] SSH key registration failed: ${String(err)}`);
    }
    adapter.log(`[add:${slug}] SSH key + Gitea user registered`);
}
async function resyncSshKeyIfDrifted(adapter, slug, reclaimExistingSshKey) {
    const localPub = adapter.readLocalCustomerPubKey(slug);
    if (localPub === null) {
        await adapter.deleteCustomerSshKey(slug).catch(() => { });
        throw new Error(`[add:${slug}] SSH key dir exists but pubkey is unreadable; cleared, retry will regenerate`);
    }
    const giteaPubKeys = await adapter.readGiteaCustomerPubKeys(slug);
    const registered = giteaPubKeys.some((candidate) => pubKeysMatch(candidate, localPub));
    if (!reclaimExistingSshKey && registered)
        return [];
    const giteaState = giteaPubKeys.length === 0 ? "absent" : "mismatch";
    let reason = `SSH key drift (giteaPub=${giteaState})`;
    if (reclaimExistingSshKey && registered)
        reason = "ownership reclaim";
    adapter.log(`[add:${slug}] resync triggered: ${reason}`);
    await adapter.createGiteaUser(slug, localPub);
    const recheck = await adapter.readGiteaCustomerPubKeys(slug);
    if (!recheck.some((candidate) => pubKeysMatch(candidate, localPub))) {
        throw new Error(`[add:${slug}] SSH key resync did not persist in Gitea`);
    }
    return ["ssh-key-resync"];
}
async function ensureWorkspaceRepo(adapter, uid, snapshot, ctx) {
    await adapter.ensureGiteaOrg(snapshot.slug);
    // A builder born onto a shared pod never runs the non-shared pre-boot
    // restore, which is the only other thing that creates this repo. Without it
    // the migration flush reads a head that does not exist and the move retries
    // forever (#3196).
    await adapter.ensureSystemConfigRepo(snapshot.slug);
    return convergeWorkspaceCheckout(adapter, uid, snapshot, ctx);
}
async function convergeWorkspaceCheckout(adapter, uid, snapshot, ctx) {
    const { slug } = snapshot;
    if (adapter.hasWorkspaceGitDir(slug)) {
        if (adapter.hasGitRemote(slug))
            return [];
        if (snapshot.repoUrl) {
            adapter.log(`[add:${slug}] workspace Git metadata is incomplete; repairing from canonical Gitea`);
            return cloneExistingWorkspaceRepo(adapter, snapshot, ctx);
        }
        return recoverMissingWorkspaceRemote(adapter, uid, ctx);
    }
    if (snapshot.repoUrl) {
        return cloneExistingWorkspaceRepo(adapter, snapshot, ctx);
    }
    return initNewWorkspaceRepo(adapter, uid, ctx);
}
async function recoverMissingWorkspaceRemote(adapter, uid, ctx) {
    const repoUrl = await adapter.initWorkspaceRepoFromExistingDir(ctx);
    if (!repoUrl) {
        throw new Error(`[add:${ctx.slug}] recovery workspace repo creation failed`);
    }
    await adapter.setRepoUrl(uid, repoUrl);
    adapter.ensureCustomerDirectories(ctx.slug);
    adapter.log(`[add:${ctx.slug}] workspace remote recovered + Firestore updated (${repoUrl})`);
    return ["init-workspace-repo"];
}
async function cloneExistingWorkspaceRepo(adapter, snapshot, ctx) {
    const { slug, repoUrl } = snapshot;
    if (adapter.hasCustomerDir(slug) && !adapter.hasWorkspaceGitDir(slug)) {
        adapter.log(`[add:${slug}] removing partial workspace before clone; projects stay`);
        await adapter.removePartialWorkspace(slug);
    }
    const cloned = await adapter.cloneWorkspaceRepo(slug, repoUrl);
    if (!cloned) {
        throw new Error(`[add:${slug}] workspace clone from ${repoUrl} failed`);
    }
    adapter.ensureCustomerDirectories(slug);
    await adapter.writeCustomerTemplateFiles(ctx);
    adapter.log(`[add:${slug}] workspace cloned from Gitea; template files ensured`);
    return ["clone-workspace-repo", "write-templates"];
}
async function initNewWorkspaceRepo(adapter, uid, ctx) {
    adapter.ensureCustomerDirectories(ctx.slug);
    await adapter.writeCustomerTemplateFiles(ctx);
    const repoUrl = await adapter.initWorkspaceRepoFromExistingDir(ctx);
    if (!repoUrl) {
        throw new Error(`[add:${ctx.slug}] initial workspace repo creation failed`);
    }
    await adapter.setRepoUrl(uid, repoUrl);
    adapter.log(`[add:${ctx.slug}] workspace repo initialized + pushed (${repoUrl})`);
    return ["write-templates", "init-workspace-repo"];
}
async function runBlobSync(adapter, slug) {
    try {
        await adapter.blobSyncForSlug(slug);
        return ["blob-sync"];
    }
    catch (err) {
        adapter.log(`[add:${slug}] ⚠ blob sync failed (non-fatal): ${String(err)}`);
        return [];
    }
}
async function restoreByos(adapter, slug) {
    const result = await adapter.restoreByosubForAgent(slug);
    if (!result.restored) {
        return { ...result, steps: [] };
    }
    adapter.log(`[add:${slug}] BYOS oauth activated from user integration broker`);
    return { ...result, steps: ["byosub-restore"] };
}
// The byot userData that syncByotForCustomer (via deriveDesiredByotState) needs to make a
// NON-destructive decision. deriveDesiredByotState gates BYOT derivation on
// provisioning.openclaw.status === "complete"; below that it returns input=null, and on a
// shared GW a null state runs applyByotState(slug, null), which REMOVES a non-anthropic
// customer's models.json. reassertByot is called ONLY after applyConfigPatchAndMount has
// registered + mounted the agent, so the runtime IS complete here — but the in-memory
// snapshot.status is the PRE-mount Firestore value, still "" / "provisioning" on a
// first-time provision (loadAndPrepareForMount never advances it). Forwarding that stale
// status would derive input=null and skip writing a first-time BYOK customer's model files
// (and clear them on a retry that already has managed files). So pin status to "complete":
// it reflects the just-mounted runtime, not the stale doc. byotActive + systemConfig.byot
// drive the provider; tier drives the free-tier coach model.
function byotUserDataFromSnapshot(snapshot) {
    return {
        username: snapshot.slug,
        timeZone: snapshot.timeZone ?? null,
        byotActive: snapshot.byotActive,
        systemConfig: snapshot.systemConfig,
        tier: snapshot.tier,
        freeTierModelRef: snapshot.freeTierModelRef,
        builderAgentDefault: snapshot.builderAgentDefault,
        // Full plan-input set: the reassert's resolveBillingProfile must see the same
        // plan the trusted side resolved, or a trial/builder user's agent-model picks
        // defer to house_only on every mount/roll.
        ...pickPlanInputs(snapshot),
        provisioning: { openclaw: { status: "complete" } },
    };
}
// Re-assert the customer's broker-routed model auth into the openclaw config. The
// Anthropic provider key on a shared GW is a broker token set via config.patch, not a
// file — so a fresh emptyDir pod (roll / Spot preemption) loses it and boot-sync's
// restoreByos (BYOS oauth) alone does not restore it. Runs here so it's re-applied on
// every provision AND re-mount. Idempotent; non-fatal so a transient broker hiccup
// doesn't strand the whole mount — the change-trigger and next re-mount re-run it.
async function refreshSnapshotForReassert(adapter, snapshot) {
    try {
        return (await adapter.loadUserSnapshot(snapshot.uid)) ?? snapshot;
    }
    catch (err) {
        adapter.log(`[add:${snapshot.slug}] ⚠ refresh before byot re-assert failed; using mount snapshot: ${String(err)}`);
        return snapshot;
    }
}
// Re-asserts BYOT model auth and the platform-converged context files
// (AGENTS.md/TOOLS.md for house_only plans) off ONE fresh snapshot fetch —
// both are idempotent/non-fatal convergence steps that must run on every
// provision AND re-mount, but they are independent failure domains: one
// failing must never skip the other, and neither should cost a customer a
// second Firestore read.
async function reassertConvergedState(adapter, snapshot) {
    const refreshed = await refreshSnapshotForReassert(adapter, snapshot);
    const userData = byotUserDataFromSnapshot(refreshed);
    const steps = [];
    try {
        await adapter.reassertByotForCustomer(userData);
        steps.push("byot-reassert");
    }
    catch (err) {
        adapter.log(`[add:${snapshot.slug}] ⚠ byot re-assert failed (non-fatal; retry on next sync/re-mount): ${String(err)}`);
    }
    try {
        await adapter.reassertConvergedContextFilesForCustomer(userData);
        steps.push("context-files-reassert");
    }
    catch (err) {
        adapter.log(`[add:${snapshot.slug}] ⚠ context-file re-assert failed (non-fatal; retry on next sync/re-mount): ${String(err)}`);
    }
    return steps;
}
async function reconcileCommunityMembershipIfSupported(adapter, ctx) {
    if (!adapter.reconcileCommunityMembership)
        return [];
    try {
        await adapter.reconcileCommunityMembership(ctx);
        return ["community-membership"];
    }
    catch (err) {
        adapter.log(`[add:${ctx.slug}] ⚠ community membership reconcile failed (non-fatal; retry on next sync/re-mount): ${String(err)}`);
        return [];
    }
}
function githubCheckoutsHydrateHere(adapter, slug) {
    if (!adapter.isBuilderGateway || !adapter.isConfiguredBuilderCustomer)
        return true;
    return adapter.isBuilderGateway() && adapter.isConfiguredBuilderCustomer(slug);
}
export async function cloneMissingProjects(adapter, slug, options = {}) {
    const toClone = await adapter.listProjectsNeedingClone(slug);
    const steps = [];
    const deferred = new Set();
    const ownerRuntime = options.githubCheckouts !== "defer" && githubCheckoutsHydrateHere(adapter, slug);
    for (const p of toClone) {
        if (!hasProjectCloneSource(p)) {
            adapter.log(`[add:${slug}/${p.projectSlug}] ✖ project checkout skipped — no Gitea repo and no GitHub repoSource`);
            continue;
        }
        if (githubRepoSourceOf(p) && !ownerRuntime) {
            deferred.add(p.projectSlug);
            await adapter.seedDeferredProjectWorkspace(slug, p.projectSlug);
            adapter.log(options.githubCheckouts === "defer"
                ? `[add:${slug}/${p.projectSlug}] GitHub checkout deferred until the customer is assigned here — the reconcile clones it after cutover`
                : `[add:${slug}/${p.projectSlug}] GitHub checkout deferred — it hydrates on ${slug}'s own Builder runtime`);
            continue;
        }
        try {
            const ok = await adapter.cloneProjectRepo(slug, p.projectSlug, p.giteaRepoName, projectCloneOptions(p));
            if (ok) {
                steps.push("project-clone");
                adapter.log(`[add:${slug}/${p.projectSlug}] cloned from ${projectCloneSourceLabel(p)}`);
            }
        }
        catch (err) {
            adapter.log(`[add:${slug}/${p.projectSlug}] ✖ project clone failed: ${String(err)}`);
        }
    }
    // On-disk truth, not cloneProjectRepo's boolean: it returns false for several non-error
    // reasons (repo absent upstream, no SSH key), so only a re-probe can say whether the
    // checkout actually landed.
    const remaining = await adapter.listProjectsNeedingClone(slug);
    const pending = remaining
        .map((p) => p.projectSlug)
        .filter((projectSlug) => !deferred.has(projectSlug))
        .sort();
    if (pending.length > 0) {
        adapter.log(`[add:${slug}] ✖ project checkout still absent after converge: ${pending.join(", ")} — the pending-checkout retry lane re-runs the clone`);
    }
    return { steps, pending, deferred: [...deferred].sort() };
}
async function provisionMattermostIfMissing(adapter, uid, snapshot, ctx) {
    if (snapshot.mattermostUserId) {
        return { mmUpdate: null, steps: [] };
    }
    const mmUpdate = await adapter.provisionMattermostUser(ctx);
    await adapter.setMattermostFields(uid, mmUpdate);
    return { mmUpdate, steps: ["mattermost-provision"] };
}
async function applyConfigPatchAndMount(adapter, snapshot, mmUpdate, options) {
    const patchResult = await adapter.applyAddCustomerConfigPatch(snapshot, mmUpdate, {
        signal: options.signal,
        byosActive: options.byosActive,
        evictionBatch: options.evictionBatch,
        currentEvictionBatch: options.currentEvictionBatch,
        withoutProjectIds: options.withoutProjectIds,
        ...(options.brokerProfilesReady ? { brokerProfilesReady: options.brokerProfilesReady } : {}),
        ...(options.runtimePublication ? { runtimePublication: options.runtimePublication } : {}),
    });
    adapter.log(`[add:${snapshot.slug}] config patch in ${patchResult.elapsedMs}ms`);
    if (adapter.onMounted)
        adapter.onMounted(snapshot.slug);
    return patchResult.appliedFingerprint;
}
async function verifyChannelReady(adapter, slug, verifyTimeoutMs) {
    adapter.log(`[add:${slug}] verify: waiting for coach MM account to report running+connected (timeoutMs=${verifyTimeoutMs})`);
    const startedAt = Date.now();
    const healthy = await adapter.waitForAccountHealthy({ slug, timeoutMs: verifyTimeoutMs });
    const elapsed = Date.now() - startedAt;
    if (!healthy) {
        throw new Error(`[add:${slug}] channel didn't reach running+connected within ${verifyTimeoutMs}ms (waited ${elapsed}ms) — failing the mount; fleet will retry`);
    }
    adapter.log(`[add:${slug}] ✅ verify: channel ready (running+connected) in ${elapsed}ms`);
    await adapter.materializeBrokerProfiles?.(slug);
}
async function markCompleteIfNeeded(adapter, uid, snapshot, newCustomer, mmUpdate) {
    if (!newCustomer && snapshot.agentIds.length > 0)
        return [];
    if (newCustomer) {
        const coachChannels = snapshot.channels.filter((channel) => channel.scope === "workspace" && channel.kind === "coach-dm");
        const existingCoachChannelId = coachChannels.length === 1 ? coachChannels[0].channelId : null;
        const coachChannelId = mmUpdate ? mmUpdate["mattermost.channelId"] : existingCoachChannelId;
        if (typeof coachChannelId !== "string" || !coachChannelId) {
            throw new Error(`Initial coach monitoring for ${snapshot.slug} has no private coach channel`);
        }
        await adapter.provisionCoachAutomation({ slug: snapshot.slug, coachChannelId });
    }
    const coachAgentId = `octogee-${snapshot.slug}-coach`;
    await adapter.setAgentIds(uid, [coachAgentId]);
    await adapter.setProvisioningStatus(uid, "complete");
    return ["mark-complete"];
}
async function notifyOpsIfNew(adapter, ctx, newCustomer) {
    if (!newCustomer)
        return [];
    try {
        await adapter.notifyOpsOfSignup(ctx);
        return ["notify-ops"];
    }
    catch (err) {
        adapter.log(`[add:${ctx.slug}] ⚠ ops notification failed (non-fatal): ${String(err)}`);
        return [];
    }
}
function retainConfiguredBuilderOverlay(adapter, slug, steps) {
    if (!adapter.configuredBuilderOverlayPresent?.(slug)) {
        throw new Error(`[remove:${slug}] configured Builder system-config overlay is unavailable`);
    }
    adapter.clearMountMarker?.(slug);
    adapter.clearCustomerMigratingIn?.(slug);
    adapter.onUnmounted?.(slug);
    adapter.log(`[remove:${slug}] retained configured Builder system-config overlay`);
    return { wasMounted: true, steps, retained: true };
}
async function evictionWasCancelled(slug, remaining, currentEvictionBatch) {
    if (remaining && !remaining.includes(slug))
        return true;
    return currentEvictionBatch !== undefined && !(await currentEvictionBatch()).includes(slug);
}
export async function removeCustomerFromGateway(adapter, uid, opts = {}) {
    return withLogContext({}, async () => {
        const steps = [];
        const snapshot = await adapter.loadUserSnapshot(uid);
        if (!snapshot) {
            throw new Error(`[remove:${uid}] user doc not found in Firestore`);
        }
        const { slug } = snapshot;
        setLogContext({ builderSlug: slug, category: "lifecycle" });
        const wasMounted = adapter.hasCustomerDir(slug) || snapshot.status === "complete";
        if (!wasMounted) {
            adapter.log(`[remove:${slug}] nothing to do (no dir, status=${snapshot.status})`);
            return { wasMounted: false, steps };
        }
        if (adapter.isBuilderGateway?.() && adapter.isConfiguredBuilderCustomer?.(slug)) {
            return retainConfiguredBuilderOverlay(adapter, slug, steps);
        }
        const remaining = await adapter.applyRemoveCustomerConfigPatch(slug, `octogee-${slug}-coach`, opts.evictionBatch, opts.currentEvictionBatch);
        steps.push("config-patch-remove");
        adapter.log(`[remove:${slug}] removed from openclaw config`);
        if (await evictionWasCancelled(slug, remaining, opts.currentEvictionBatch)) {
            adapter.cancelPendingEviction?.(slug);
            return { wasMounted: true, steps, retained: true };
        }
        await adapter.deleteDepartedCustomerState(slug);
        steps.push("delete-dir");
        adapter.log(`[remove:${slug}] customer state deleted`);
        if (await releaseUnmountedGiteaKey(adapter, slug))
            steps.push("release-gitea-key");
        if (adapter.onUnmounted)
            adapter.onUnmounted(slug);
        return { wasMounted: true, steps };
    });
}
async function releaseUnmountedGiteaKey(adapter, slug) {
    const pubKey = adapter.readLocalCustomerPubKey(slug);
    if (pubKey === null)
        return false;
    try {
        await adapter.releaseGiteaUserKey(slug, pubKey);
    }
    catch (err) {
        adapter.log(`⚠ [remove:${slug}] Gitea key release failed; local keypair kept for the preStop release: ${String(err)}`);
        return false;
    }
    await adapter.deleteCustomerSshKey(slug);
    adapter.log(`[remove:${slug}] Gitea key released and local keypair removed`);
    return true;
}
export function pubKeysMatch(a, b) {
    const norm = (s) => {
        const parts = s.trim().split(/\s+/);
        return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : s.trim();
    };
    return norm(a) === norm(b);
}
function buildCustomerContext(snapshot, customersDir) {
    const today = new Date().toISOString().slice(0, 10);
    const username = snapshot.slug;
    return {
        uid: snapshot.uid,
        slug: snapshot.slug,
        tier: snapshot.tier,
        ownerName: snapshot.ownerName,
        customerDir: `${customersDir}/${snapshot.slug}`,
        today,
        username,
        templateVars: {
            uid: snapshot.uid,
            ownerName: snapshot.ownerName,
            username,
            tier: snapshot.tier,
            createdAt: today,
            slug: snapshot.slug,
            timeZone: snapshot.timeZone ?? UNKNOWN_TIME_ZONE,
        },
        userData: {},
    };
}
