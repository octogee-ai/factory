import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";

// A stable fingerprint of the fields of a customer snapshot that shape what an ensure
// applies on disk — the generated OpenClaw config (agents.list,
// channels.mattermost.accounts, bindings) AND the project checkouts the ensure clones. The
// reconcile compares a mounted customer's desired fingerprint against the one applied at
// its last successful ensure; a mismatch means the on-disk state is stale and the
// customer must be re-ensured even though its mounted membership is unchanged. This is
// what makes a project-agent toggle converge on the next tick instead of only on remount.
//
// `projectCloneSet` is fingerprinted for targets that restore project checkouts because the
// clone only ever runs for an ACTIVE project (listProjectsNeedingClone skips the rest), while
// project create writes the MM channel BEFORE it flips provisioningState to active. Targets
// explicitly scoped to workspace-only project this set away.
//
// It hashes the SET the ensure would actually clone — repo present AND active (or legacy
// undefined), mirroring listProjectsNeedingClone's own filter — rather than raw project
// state. So provisioning→active is drift, while provisioning→failed (never cloned) is not,
// and a repo RENAME is not: cloneProjectRepo skips any path that already has a .git, so
// calling a rename "drift" would only record a fresh fingerprint over a stale checkout.
//
// Deliberately EXCLUDES fields the ensure never reads (status, greeting, repoUrl,
// email, ownerName, …) so routine snapshot churn does not trigger needless re-ensures.

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v));
  return `{${entries.join(",")}}`;
}

// 64-bit FNV-1a (two 32-bit lanes with distinct offset bases) over the canonical string.
// Deterministic — no Date/Math.random — so a resumed reconcile fingerprints identically.
function fnv1a64Hex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// One roster fetch drives BOTH convergence inputs: the fingerprint map the reconcile
// compares, and the adapter snapshot cache the triggered ensure reads. Seeding them from
// the same snapshot is the invariant that makes a re-ensure apply exactly the content its
// fingerprint described — the broker adapter's cache has no TTL, so without the seed a
// drift-triggered ensure would re-apply the boot-time state while the bookkeeping records
// the new fingerprint as applied.
export function desiredFingerprints(
  users: readonly FleetBrokerUserSnapshot[],
  seedSnapshot?: (snapshot: FleetBrokerUserSnapshot) => void,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const user of users) {
    seedSnapshot?.(user);
    map.set(user.slug, snapshotConfigFingerprint(user));
  }
  return map;
}

function planSubscriptionSlice(subscription: unknown): Record<string, unknown> | null {
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) return null;
  const sub = subscription as { tier?: unknown; status?: unknown };
  return {
    tier: sub.tier ?? null,
    status: sub.status ?? null,
  };
}

export function snapshotConfigFingerprint(snapshot: FleetBrokerUserSnapshot): string {
  const configSlice = {
    // Order-independent: bindings/accounts are keyed, not positional.
    channels: [...snapshot.channels]
      .map((c) => ({ scope: c.scope, kind: c.kind, channelId: c.channelId, projectId: c.projectId }))
      .sort((a, b) => compareStrings(a.channelId, b.channelId)),
    projectAgents: [...(snapshot.projectAgents ?? [])]
      .map((p) => ({ projectId: p.projectId, enabled: p.enabled, mmUserId: p.mmUserId, token: p.token }))
      .sort((a, b) => compareStrings(a.projectId, b.projectId)),
    projectCloneSet: snapshot.projectCheckoutScope === "workspace-only" ? [] : [...(snapshot.projects ?? [])]
      .filter(
        (p) =>
          !!p.giteaRepoName
          && (p.provisioningState === undefined || p.provisioningState === "active"),
      )
      .map((p) => p.projectSlug)
      .sort(compareStrings),
    coachIdentity: snapshot.coachIdentity ?? null,
    coachToken: snapshot.coachToken,
    coachMmUserId: snapshot.coachMmUserId,
    customerMmUserId: snapshot.customerMmUserId,
    systemConfig: snapshot.systemConfig ?? null,
    byotActive: snapshot.byotActive ?? false,
    // Plan fields shape the effective model config through the ensure's byot reassert —
    // an upgrade (or signup-offer grant) must reconverge a mounted customer's model picks.
    // Only the fields plan resolution reads: hashing the whole subscription object would
    // re-ensure every customer on routine Stripe churn (currentPeriodEnd on renewal).
    tier: snapshot.tier,
    selectedTier: snapshot.selectedTier ?? null,
    subscription: planSubscriptionSlice(snapshot.subscription),
    builderSubscription: planSubscriptionSlice(snapshot.builderSubscription),
    trialGrant: snapshot.trialGrant ?? null,
    signupOfferConvertedAt: snapshot.signupOfferConvertedAt ?? null,
    // The operator's free-tier dial: a flip must re-ensure every mounted
    // house-only customer, not wait for the next roll.
    freeTierModelRef: snapshot.freeTierModelRef ?? null,
    // The Builder Agent default dial: a flip must re-ensure every mounted
    // catalog customer running the platform default.
    builderAgentDefault: snapshot.builderAgentDefault ?? null,
  };
  return fnv1a64Hex(stableStringify(configSlice));
}
