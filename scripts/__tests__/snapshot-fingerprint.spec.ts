import { describe, expect, it, vi } from "vitest";
import {
  desiredFingerprints,
  snapshotConfigFingerprint,
} from "../lib/snapshot-fingerprint.js";
import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";

function snap(over: Partial<FleetBrokerUserSnapshot> = {}): FleetBrokerUserSnapshot {
  return {
    uid: "u1",
    slug: "alice",
    tier: "paid",
    gatewayId: "default",
    status: "complete",
    agentIds: ["octogee-alice-coach"],
    repoUrl: "https://gitea/alice",
    mattermostUserId: "mm-alice",
    customerMmUserId: "mm-alice",
    greetingPosted: true,
    channels: [
      { scope: "workspace", kind: "general", channelId: "wsgen" },
      { scope: "project", kind: "general", channelId: "projgen", projectId: "camp" },
    ],
    projects: [],
    ownerName: "Alice",
    email: "alice@example.com",
    displayName: "Alice",
    lastName: "A",
    photoURL: "",
    onboardingVibe: null,
    coachToken: "coach-pat",
    coachMmUserId: "mm-coach",
    coachIdentity: { name: "Octo", emoji: "🐙" },
    ...over,
  };
}

describe("snapshotConfigFingerprint", () => {
  it("is stable for the same config-affecting content", () => {
    expect(snapshotConfigFingerprint(snap())).toBe(snapshotConfigFingerprint(snap()));
  });

  it("ignores fields that do not affect the generated gateway config", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(snapshotConfigFingerprint(snap({ greetingPosted: false }))).toBe(base);
    expect(snapshotConfigFingerprint(snap({ status: "provisioning" }))).toBe(base);
    expect(snapshotConfigFingerprint(snap({ repoUrl: "https://other" }))).toBe(base);
    expect(snapshotConfigFingerprint(snap({ email: "new@example.com" }))).toBe(base);
    expect(snapshotConfigFingerprint(snap({ ownerName: "Alicia" }))).toBe(base);
  });

  it("is order-independent for channels", () => {
    const a = snap({
      channels: [
        { scope: "workspace", kind: "general", channelId: "wsgen" },
        { scope: "project", kind: "general", channelId: "projgen", projectId: "camp" },
      ],
    });
    const b = snap({
      channels: [
        { scope: "project", kind: "general", channelId: "projgen", projectId: "camp" },
        { scope: "workspace", kind: "general", channelId: "wsgen" },
      ],
    });
    expect(snapshotConfigFingerprint(a)).toBe(snapshotConfigFingerprint(b));
  });

  it("changes when a project agent is enabled (the Vegas toggle)", () => {
    const off = snap({ projectAgents: [] });
    const on = snap({
      projectAgents: [{ projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "proj-pat" }],
    });
    expect(snapshotConfigFingerprint(on)).not.toBe(snapshotConfigFingerprint(off));
  });

  it("changes when a project agent's minted token changes", () => {
    const before = snap({
      projectAgents: [{ projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "pat-1" }],
    });
    const after = snap({
      projectAgents: [{ projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "pat-2" }],
    });
    expect(snapshotConfigFingerprint(before)).not.toBe(snapshotConfigFingerprint(after));
  });

  it("changes when a channel is added or removed", () => {
    const base = snapshotConfigFingerprint(snap());
    const extra = snap({
      channels: [
        { scope: "workspace", kind: "general", channelId: "wsgen" },
        { scope: "project", kind: "general", channelId: "projgen", projectId: "camp" },
        { scope: "project", kind: "general", channelId: "projgen2", projectId: "other" },
      ],
    });
    expect(snapshotConfigFingerprint(extra)).not.toBe(base);
  });

  it("changes when the plan resolution inputs change (upgrade must reconverge model picks)", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(snapshotConfigFingerprint(snap({ tier: "trial" }))).not.toBe(base);
    expect(
      snapshotConfigFingerprint(snap({ subscription: { tier: "personal_pro", status: "active" } })),
    ).not.toBe(base);
    expect(
      snapshotConfigFingerprint(snap({ trialStartedAt: { _seconds: 1_783_500_000 } })),
    ).not.toBe(base);
  });

  it("ignores routine Stripe churn — only the plan-resolution slice of subscription hashes", () => {
    const base = snapshotConfigFingerprint(
      snap({ subscription: { tier: "personal_pro", status: "active" } }),
    );
    // currentPeriodEnd moves on every renewal; it must not re-ensure the fleet.
    expect(
      snapshotConfigFingerprint(
        snap({ subscription: { tier: "personal_pro", status: "active", currentPeriodEnd: 1234 } }),
      ),
    ).toBe(base);
    // status flips DO matter (dead statuses change resolveTier's precedence).
    expect(
      snapshotConfigFingerprint(
        snap({ subscription: { tier: "personal_pro", status: "canceled" } }),
      ),
    ).not.toBe(base);
  });

  it("changes when the operator flips the free-tier model dial (fleet-wide re-pin within a tick)", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(
      snapshotConfigFingerprint(
        snap({ freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro" }),
      ),
    ).not.toBe(base);
  });

  it("changes when a project flips provisioning→active — the clone only ever runs for active projects", () => {
    const provisioning = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "provisioning" }],
    });
    const active = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    expect(snapshotConfigFingerprint(active)).not.toBe(snapshotConfigFingerprint(provisioning));
  });

  it("changes when a project appears — a new project must converge its pod checkout", () => {
    const base = snapshotConfigFingerprint(snap({ projects: [] }));
    expect(
      snapshotConfigFingerprint(
        snap({
          projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
        }),
      ),
    ).not.toBe(base);
  });

  it("changes when a project's repo is first provisioned — no repo name means nothing to clone", () => {
    const noRepo = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: null, provisioningState: "active" }],
    });
    const withRepo = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    expect(snapshotConfigFingerprint(withRepo)).not.toBe(snapshotConfigFingerprint(noRepo));
  });

  it("does NOT change when a project fails — a failed project is never cloned, so it is not drift", () => {
    const provisioning = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "provisioning" }],
    });
    const failed = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "failed" }],
    });
    expect(snapshotConfigFingerprint(failed)).toBe(snapshotConfigFingerprint(provisioning));
  });

  it("does NOT change on a repo rename — cloneProjectRepo skips any path that already has .git, so calling it drift would only stamp a fresh fingerprint over a stale checkout", () => {
    const before = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    const renamed = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp-v2", provisioningState: "active" }],
    });
    expect(snapshotConfigFingerprint(renamed)).toBe(snapshotConfigFingerprint(before));
  });

  it("is order-independent for projects", () => {
    const p = (slug: string) => ({
      projectSlug: slug,
      giteaRepoName: `alice-${slug}`,
      provisioningState: "active",
    });
    const a = snap({ projects: [p("camp"), p("dune")] });
    const b = snap({ projects: [p("dune"), p("camp")] });
    expect(snapshotConfigFingerprint(a)).toBe(snapshotConfigFingerprint(b));
  });

  it("changes when the coach identity, token, or model config changes", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(snapshotConfigFingerprint(snap({ coachIdentity: { name: "Buddy", emoji: "🐶" } }))).not.toBe(base);
    expect(snapshotConfigFingerprint(snap({ coachToken: "rotated-pat" }))).not.toBe(base);
    expect(
      snapshotConfigFingerprint(snap({ systemConfig: { byot: { provider: "anthropic", model: "claude" } } })),
    ).not.toBe(base);
  });
});

describe("desiredFingerprints", () => {
  it("returns slug→fingerprint for every snapshot AND seeds each snapshot into the adapter cache", () => {
    const seed = vi.fn();
    const users = [snap(), snap({ uid: "u2", slug: "bob" })];

    const map = desiredFingerprints(users, seed);

    expect([...map.keys()].sort()).toEqual(["alice", "bob"]);
    expect(map.get("alice")).toBe(snapshotConfigFingerprint(users[0]));
    // Every fingerprinted snapshot is seeded — the ensure that a drift triggers must
    // apply exactly the content the fingerprint described, not a stale cache entry.
    expect(seed).toHaveBeenCalledTimes(2);
    expect(seed).toHaveBeenCalledWith(users[0]);
    expect(seed).toHaveBeenCalledWith(users[1]);
  });

  it("tolerates an absent seeder (operator-style callers without a cache)", () => {
    const map = desiredFingerprints([snap()]);
    expect(map.size).toBe(1);
  });
});
