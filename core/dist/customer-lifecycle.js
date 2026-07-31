import { ADD_CUSTOMER_DEADLINE_MS, VERIFY_ACCOUNT_TIMEOUT_MS, } from "@octogee/shared/types/fleet-controller";
import { pickPlanInputs } from "@octogee/shared/types/billing";
const inFlightUids = new Set();
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
    return runUidMountExclusive(uid, opts, (signal) => addCustomerToGatewayInner(adapter, uid, { ...opts, signal }));
}
export async function restoreCustomerRuntimeFromSnapshot(adapter, snapshot, opts = {}) {
    return runUidMountExclusive(snapshot.uid, opts, (signal) => restoreCustomerRuntimeFromSnapshotInner(adapter, snapshot, { ...opts, signal }));
}
async function runUidMountExclusive(uid, opts, work) {
    if (inFlightUids.has(uid)) {
        throw new ConcurrentMountError(uid);
    }
    inFlightUids.add(uid);
    const deadlineMs = opts.mountDeadlineMs ?? ADD_CUSTOMER_DEADLINE_MS;
    const controller = new AbortController();
    const deadlineErr = new Error(`[add:${uid}] mountDeadlineMs=${deadlineMs}ms exceeded — a step is hung; releasing in-flight lock so the next retry can run`);
    const externalAbortListener = () => controller.abort(opts.signal?.reason);
    if (opts.signal?.aborted) {
        controller.abort(opts.signal.reason);
    }
    else if (opts.signal) {
        opts.signal.addEventListener("abort", externalAbortListener, { once: true });
    }
    let timer = null;
    if (!controller.signal.aborted && Number.isFinite(deadlineMs) && deadlineMs > 0) {
        timer = setTimeout(() => controller.abort(deadlineErr), deadlineMs);
    }
    opts.onSignalCreated?.(controller.signal);
    try {
        return await raceWithSignal(work(controller.signal), controller.signal);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        opts.signal?.removeEventListener("abort", externalAbortListener);
        inFlightUids.delete(uid);
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
    const { slug, uid } = snapshot;
    const startedAt = Date.now();
    adapter.log(`[restore:${slug}] starting durable restore for migration (repoUrl=${snapshot.repoUrl ? "set" : "empty"}, projects=${snapshot.projects?.length ?? 0})`);
    throwIfAborted(signal, uid);
    steps.push(...(await ensureSshKeyAndGitea(adapter, slug)));
    throwIfAborted(signal, uid);
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
    const byos = await restoreByos(adapter, slug);
    steps.push(...byos.steps);
    throwIfAborted(signal, uid);
    await applyConfigPatchAndMount(adapter, snapshot, null, byos.present, signal);
    steps.push("config-patch");
    throwIfAborted(signal, uid);
    steps.push(...(await reassertConvergedState(adapter, snapshot)));
    throwIfAborted(signal, uid);
    steps.push(...(await reconcileCommunityMembershipIfSupported(adapter, ctx)));
    throwIfAborted(signal, uid);
    steps.push(...(await warmAgentRuntimePluginsIfSupported(adapter, slug)));
    throwIfAborted(signal, uid);
    await verifyChannelReady(adapter, slug, verifyTimeoutMs);
    steps.push("verify-channel-ready");
    throwIfAborted(signal, uid);
    if (rehydratesProjectCheckouts(adapter, snapshot)) {
        steps.push(...(await cloneProjectsFromSnapshot(adapter, snapshot)));
    }
    throwIfAborted(signal, uid);
    adapter.writeMountMarker?.(slug);
    adapter.log(`[restore:${slug}] durable restore complete in ${Date.now() - startedAt}ms`);
    return { restored: true, steps };
}
async function cloneProjectsFromSnapshot(adapter, snapshot) {
    const steps = [];
    for (const p of snapshot.projects ?? []) {
        if (!p.giteaRepoName)
            continue;
        if (p.provisioningState !== undefined && p.provisioningState !== "active")
            continue;
        try {
            const ok = await adapter.cloneProjectRepo(snapshot.slug, p.projectSlug, p.giteaRepoName);
            if (ok)
                steps.push("project-clone");
        }
        catch (err) {
            adapter.log(`[restore:${snapshot.slug}/${p.projectSlug}] ⚠ project clone failed (non-fatal): ${String(err)}`);
        }
    }
    return steps;
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
function operatorGatewayIsReadyForFastAttach(adapter, snapshot, convergeContent) {
    const { slug } = snapshot;
    return snapshot.status === "complete"
        && !convergeContent
        && Boolean(adapter.isOperatorGateway?.())
        && Boolean(adapter.customerCoachWiredInOpenclawConfig?.(slug))
        && Boolean(adapter.hasCustomerAgentRuntime?.(slug))
        && adapter.hasWorkspaceGitDir(slug)
        && adapter.hasGitRemote(slug);
}
async function addCustomerToGatewayInner(adapter, uid, opts = {}) {
    const verifyTimeoutMs = opts.verifyTimeoutMs ?? VERIFY_ACCOUNT_TIMEOUT_MS;
    const customersDir = opts.customersDir ?? "/home/node/.openclaw/customers";
    const { signal } = opts;
    const steps = [];
    const attachStartedAt = Date.now();
    throwIfAborted(signal, uid);
    const prepared = await loadAndPrepareForMount(adapter, uid, customersDir);
    let snapshot = prepared.snapshot;
    const { ctx, newCustomer } = prepared;
    const { slug } = snapshot;
    if (operatorGatewayIsReadyForFastAttach(adapter, snapshot, opts.convergeContent)) {
        steps.push(...(await ensureSshKeyAndGitea(adapter, slug)));
        throwIfAborted(signal, uid);
        adapter.log(`[add:${slug}] operator gateway, status=complete, coach and durable workspace ready — verifying MM coach only`);
        throwIfAborted(signal, uid);
        await verifyChannelReady(adapter, slug, verifyTimeoutMs);
        // Fleet heartbeat must include this customer as mounted — same as
        // the non-short-circuit path which calls onMounted after config.patch.
        if (adapter.onMounted)
            adapter.onMounted(slug);
        steps.push("verify-channel-ready");
        // This short-circuit never reaches cloneMissingProjects, so it makes no claim about
        // project checkouts — reporting them pending here would re-ensure forever.
        return { newCustomer: false, steps, pendingProjectClones: [] };
    }
    if (snapshot.status !== "complete") {
        await adapter.setProvisioningStatus(uid, "provisioning");
        steps.push("claim-slot");
    }
    steps.push(...(await ensureSshKeyAndGitea(adapter, slug)));
    throwIfAborted(signal, uid);
    steps.push(...(await ensureWorkspaceRepo(adapter, uid, snapshot, ctx)));
    throwIfAborted(signal, uid);
    const byos = await restoreByos(adapter, slug);
    steps.push(...byos.steps);
    throwIfAborted(signal, uid);
    const mm = await provisionMattermostIfMissing(adapter, uid, snapshot, ctx);
    snapshot = mm.snapshot;
    steps.push(...mm.steps);
    throwIfAborted(signal, uid);
    const appliedFingerprint = await applyConfigPatchAndMount(adapter, snapshot, mm.mmUpdate, byos.present, signal);
    steps.push("config-patch");
    throwIfAborted(signal, uid);
    steps.push(...(await reassertConvergedState(adapter, snapshot)));
    throwIfAborted(signal, uid);
    steps.push(...(await reconcileCommunityMembershipIfSupported(adapter, ctx)));
    throwIfAborted(signal, uid);
    steps.push(...(await warmAgentRuntimePluginsIfSupported(adapter, slug)));
    throwIfAborted(signal, uid);
    await verifyChannelReady(adapter, slug, verifyTimeoutMs);
    steps.push("verify-channel-ready");
    throwIfAborted(signal, uid);
    steps.push(...(await runBlobSync(adapter, slug)));
    throwIfAborted(signal, uid);
    const projectClones = rehydratesProjectCheckouts(adapter, snapshot)
        ? await cloneMissingProjects(adapter, slug)
        : { steps: [], pending: [] };
    steps.push(...projectClones.steps);
    throwIfAborted(signal, uid);
    adapter.log(`✅ [add:${slug}] coach attach complete in ${Date.now() - attachStartedAt}ms — scheduling greeting next`);
    steps.push(...(await scheduleGreetingIfNeeded(adapter, uid, snapshot)));
    steps.push(...(await markCompleteIfNeeded(adapter, uid, snapshot, newCustomer)));
    steps.push(...(await notifyOpsIfNew(adapter, ctx, newCustomer)));
    return {
        newCustomer,
        steps,
        pendingProjectClones: projectClones.pending,
        ...(appliedFingerprint ? { appliedFingerprint } : {}),
    };
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
async function ensureSshKeyAndGitea(adapter, slug) {
    if (!adapter.hasCustomerSshKey(slug)) {
        await registerFirstTimeSshKey(adapter, slug);
        return ["ssh-key"];
    }
    return resyncSshKeyIfDrifted(adapter, slug);
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
async function resyncSshKeyIfDrifted(adapter, slug) {
    const localPub = adapter.readLocalCustomerPubKey(slug);
    if (localPub === null) {
        await adapter.deleteCustomerSshKey(slug).catch(() => { });
        throw new Error(`[add:${slug}] SSH key dir exists but pubkey is unreadable; cleared, retry will regenerate`);
    }
    const giteaPubKeys = await adapter.readGiteaCustomerPubKeys(slug);
    if (giteaPubKeys.some((candidate) => pubKeysMatch(candidate, localPub)))
        return [];
    const driftDetail = giteaPubKeys.length === 0 ? "absent" : "mismatch";
    adapter.log(`[add:${slug}] resync triggered: SSH key drift (giteaPub=${driftDetail})`);
    await adapter.createGiteaUser(slug, localPub);
    const recheck = await adapter.readGiteaCustomerPubKeys(slug);
    if (!recheck.some((candidate) => pubKeysMatch(candidate, localPub))) {
        throw new Error(`[add:${slug}] SSH key resync did not persist in Gitea`);
    }
    return ["ssh-key-resync"];
}
async function ensureWorkspaceRepo(adapter, uid, snapshot, ctx) {
    await adapter.ensureGiteaOrg(snapshot.slug);
    return convergeWorkspaceCheckout(adapter, uid, snapshot, ctx);
}
async function convergeWorkspaceCheckout(adapter, uid, snapshot, ctx) {
    const { slug } = snapshot;
    if (adapter.hasWorkspaceGitDir(slug)) {
        if (adapter.hasGitRemote(slug))
            return [];
        if (snapshot.repoUrl) {
            adapter.log(`[add:${slug}] workspace has no origin; restoring canonical Gitea checkout`);
            await adapter.deleteCustomerDir(slug);
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
        adapter.log(`[add:${slug}] removing partial workspace dir before clone`);
        await adapter.deleteCustomerDir(slug);
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
async function cloneMissingProjects(adapter, slug) {
    const toClone = await adapter.listProjectsNeedingClone(slug);
    const steps = [];
    for (const p of toClone) {
        try {
            const ok = await adapter.cloneProjectRepo(slug, p.projectSlug, p.giteaRepoName);
            if (ok) {
                steps.push("project-clone");
                adapter.log(`[add:${slug}/${p.projectSlug}] cloned from Gitea`);
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
    const pending = remaining.map((p) => p.projectSlug).sort();
    if (pending.length > 0) {
        adapter.log(`[add:${slug}] ✖ project checkout still absent after converge: ${pending.join(", ")} — leaving this customer stale so the next reconcile retries`);
    }
    return { steps, pending };
}
async function provisionMattermostIfMissing(adapter, uid, snapshot, ctx) {
    if (snapshot.mattermostUserId) {
        return { snapshot, mmUpdate: null, steps: [] };
    }
    const mmUpdate = await adapter.provisionMattermostUser(ctx);
    await adapter.setMattermostFields(uid, mmUpdate);
    const refreshed = await adapter.loadUserSnapshot(uid);
    return {
        snapshot: refreshed ?? snapshot,
        mmUpdate,
        steps: ["mattermost-provision"],
    };
}
async function applyConfigPatchAndMount(adapter, snapshot, mmUpdate, byosActive, signal) {
    const patchResult = await adapter.applyAddCustomerConfigPatch(snapshot, mmUpdate, {
        signal,
        byosActive,
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
}
async function warmAgentRuntimePluginsIfSupported(adapter, slug) {
    if (!adapter.warmAgentRuntimePlugins)
        return [];
    const startedAt = Date.now();
    adapter.log(`[add:${slug}] warming agent runtime plugins`);
    await adapter.warmAgentRuntimePlugins(slug);
    adapter.log(`[add:${slug}] agent runtime plugins warm in ${Date.now() - startedAt}ms`);
    return ["warm-runtime-plugins"];
}
async function scheduleGreetingIfNeeded(adapter, uid, snapshot) {
    if (snapshot.greetingPosted)
        return [];
    const { slug } = snapshot;
    const accountId = `${slug}-coach`;
    const agentId = `octogee-${slug}-coach`;
    adapter.log(`[add:${slug}] greeting-cron: scheduling boot-greeting via cron.add (agentId=${agentId} accountId=${accountId})`);
    const startedAt = Date.now();
    try {
        const result = await adapter.scheduleBootGreetingCron({ slug, agentId, accountId });
        const elapsed = Date.now() - startedAt;
        await adapter.setGreetingResult(uid, { ok: true, jobId: result.jobId });
        adapter.log(`[add:${slug}] ✅ greeting-cron: scheduled (jobId=${result.jobId} elapsedMs=${elapsed}) — agent turn will fire shortly; check gateway logs for 'cron: job created' and the eventual announce delivery`);
        // Fire-and-forget safety net: if the agent greeting turn fails (model
        // error / stall), this posts a static greeting as the coach after a grace
        // delay so the onboarding `agentPosted` gate still clears. Detached +
        // non-fatal by contract — do NOT await; it must not delay the mount.
        adapter.ensureBootGreetingFallback?.({ slug, uid });
        return ["schedule-greeting-cron"];
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        adapter.log(`[add:${slug}] ❌ greeting-cron: scheduleBootGreetingCron FAILED (fatal — mount will retry; provisioning stays incomplete): ${message}`);
        await adapter.setGreetingResult(uid, { ok: false, error: message });
        throw err;
    }
}
async function markCompleteIfNeeded(adapter, uid, snapshot, newCustomer) {
    if (!newCustomer && snapshot.agentIds.length > 0)
        return [];
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
export async function removeCustomerFromGateway(adapter, uid) {
    const steps = [];
    const snapshot = await adapter.loadUserSnapshot(uid);
    if (!snapshot) {
        throw new Error(`[remove:${uid}] user doc not found in Firestore`);
    }
    const { slug } = snapshot;
    const wasMounted = adapter.hasCustomerDir(slug) || snapshot.status === "complete";
    if (!wasMounted) {
        adapter.log(`[remove:${slug}] nothing to do (no dir, status=${snapshot.status})`);
        return { wasMounted: false, steps };
    }
    const coachAgentId = `octogee-${slug}-coach`;
    await adapter.applyRemoveCustomerConfigPatch(slug, coachAgentId);
    steps.push("config-patch-remove");
    adapter.log(`[remove:${slug}] removed from openclaw config`);
    if (adapter.hasCustomerDir(slug)) {
        await adapter.deleteCustomerDir(slug);
        steps.push("delete-dir");
        adapter.log(`[remove:${slug}] customer dir deleted`);
    }
    if (adapter.onUnmounted)
        adapter.onUnmounted(slug);
    return { wasMounted: true, steps };
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
        },
        userData: {},
    };
}
