import { describe, expect, it, vi } from "vitest";
import {
  desiredUsers,
  snapshotConfigFingerprint,
} from "../lib/snapshot-fingerprint.js";
import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";
import {
  installUserEntitlements,
  staticUserEntitlements,
  userEntitlements,
} from "../../shared/types/user-entitlements.js";

const PAID = { subscription: { tier: "personal_pro", status: "active" } };
const OFFER_CLAIMED_AT_SECONDS = 1_783_500_000;
const OFFER_ENDS_AT_SECONDS = 1_784_104_800;
const DURING_OFFER = new Date((OFFER_CLAIMED_AT_SECONDS + 86_400) * 1000);
const AFTER_OFFER = new Date((OFFER_ENDS_AT_SECONDS + 86_400) * 1000);
const SIGNUP_OFFER = {
  trialGrant: {
    schemaVersion: 3,
    offerId: "builder-signup",
    offerVersion: 1,
    personalTier: "personal",
    builderTier: "hobby",
    configHash: "config-a",
    claimedAt: { _seconds: OFFER_CLAIMED_AT_SECONDS },
    endsAt: { _seconds: OFFER_ENDS_AT_SECONDS },
  },
};

function snap(over: Partial<FleetBrokerUserSnapshot> = {}): FleetBrokerUserSnapshot {
  return {
    uid: "u1",
    slug: "alice",
    contextTemplateKey: "default",
    planInputs: {},
    gatewayId: "default",
    status: "complete",
    agentIds: ["octogee-alice-coach"],
    repoUrl: "https://gitea/alice",
    mattermostUserId: "mm-alice",
    customerMmUserId: "mm-alice",
    channels: [
      { scope: "workspace", kind: "general", channelId: "wsgen" },
      { scope: "project", kind: "general", channelId: "projgen", projectId: "camp" },
    ],
    projects: [],
    projectCheckoutScope: "workspace-and-projects",
    ownerName: "Alice",
    email: "alice@example.com",
    displayName: "Alice",
    lastName: "A",
    photoURL: "",
    onboardingVibe: null,
    coachToken: "default-agent-pat",
    defaultAgentMmUserId: "mm-coach",
    coachIdentity: { name: "Octo", emoji: "🐙" },
    ...over,
  };
}

describe("snapshotConfigFingerprint", () => {
  it("is stable for the same config-affecting content", () => {
    expect(snapshotConfigFingerprint(snap())).toBe(snapshotConfigFingerprint(snap()));
  });

  it("reconciles a legacy GitHub-backed agent after import even when checkout stays disabled", () => {
    const snapshot = snap({
      projects: [{ projectSlug: "orbit", giteaRepoName: "orbit", checkoutEnabled: false, repoSource: { provider: "github", owner: "alice", repo: "orbit" } }],
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot", token: "pat" }],
    });
    const before = snapshotConfigFingerprint(snapshot);
    snapshot.projectAgents![0].githubBacked = true;
    expect(snapshotConfigFingerprint(snapshot)).not.toBe(before);
  });

  it("ignores fields that do not affect the generated gateway config", () => {
    const base = snapshotConfigFingerprint(snap());
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

  it("changes when a project agent is enabled (the multi-agent toggle)", () => {
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

  it("reconciles a newly minted project activation even if other configuration is unchanged", () => {
    const project = { projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "pat-1" };
    expect(snapshotConfigFingerprint(snap({ projectAgents: [{ ...project, activationId: "activation-1" }] })))
      .not.toBe(snapshotConfigFingerprint(snap({ projectAgents: [{ ...project, activationId: "activation-2" }] })));
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

  it("changes when the user's time zone changes (USER.md is re-synced at reassert)", () => {
    expect(snapshotConfigFingerprint(snap({ timeZone: "America/Chicago" }))).not.toBe(snapshotConfigFingerprint(snap()));
    expect(snapshotConfigFingerprint(snap({ timeZone: null }))).toBe(snapshotConfigFingerprint(snap()));
  });

  it("changes when the plan the inputs resolve to changes (an upgrade must reconverge model picks)", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(snapshotConfigFingerprint(snap({ planInputs: PAID }))).not.toBe(base);
    expect(
      snapshotConfigFingerprint(snap({ planInputs: { builderSubscription: { tier: "pro", status: "active" } } })),
    ).not.toBe(base);
    expect(snapshotConfigFingerprint(snap({ planInputs: SIGNUP_OFFER }), DURING_OFFER))
      .not.toBe(snapshotConfigFingerprint(snap(), DURING_OFFER));
  });

  it("changes when a plan ends — the status flip resolves to a different plan", () => {
    expect(
      snapshotConfigFingerprint(snap({ planInputs: { subscription: { tier: "personal_pro", status: "canceled" } } })),
    ).not.toBe(snapshotConfigFingerprint(snap({ planInputs: PAID })));
  });

  it("ignores billing renewal noise — inputs that resolve to the same plan fingerprint the same", () => {
    const base = snapshotConfigFingerprint(snap({ planInputs: PAID }));
    expect(
      snapshotConfigFingerprint(
        snap({ planInputs: { subscription: { ...PAID.subscription, currentPeriodEnd: 1234 } } }),
      ),
    ).toBe(base);
    expect(
      snapshotConfigFingerprint(
        snap({
          planInputs: {
            subscription: { ...PAID.subscription, currentPeriodEnd: 5678, latestInvoiceId: "in_2" },
          },
        }),
      ),
    ).toBe(base);
  });

  it("re-ensures a mounted user when a time-boxed plan lapses with its inputs unchanged", () => {
    const offer = snap({ planInputs: SIGNUP_OFFER });
    expect(snapshotConfigFingerprint(offer, AFTER_OFFER)).not.toBe(snapshotConfigFingerprint(offer, DURING_OFFER));
  });

  it("is stable over time while the plan the inputs resolve to stays the same", () => {
    const offer = snap({ planInputs: SIGNUP_OFFER });
    const laterDuringOffer = new Date(DURING_OFFER.getTime() + 2 * 86_400_000);
    const laterAfterOffer = new Date(AFTER_OFFER.getTime() + 30 * 86_400_000);
    expect(snapshotConfigFingerprint(offer, laterDuringOffer)).toBe(snapshotConfigFingerprint(offer, DURING_OFFER));
    expect(snapshotConfigFingerprint(offer, laterAfterOffer)).toBe(snapshotConfigFingerprint(offer, AFTER_OFFER));
    expect(snapshotConfigFingerprint(snap({ planInputs: PAID }), laterAfterOffer))
      .toBe(snapshotConfigFingerprint(snap({ planInputs: PAID }), DURING_OFFER));
  });

  it("asks the entitlement resolver what the inputs mean and never reads inside the bag", () => {
    const product = userEntitlements();
    installUserEntitlements(staticUserEntitlements);
    try {
      expect(snapshotConfigFingerprint(snap({ planInputs: PAID }))).toBe(snapshotConfigFingerprint(snap()));
    } finally {
      installUserEntitlements(product);
    }
  });

  it("ignores a plan field that sits beside the bag", () => {
    const beside = { ...snap(), ...PAID, selectedTier: "personal_pro", tier: "personal_pro" };
    expect(snapshotConfigFingerprint(beside as FleetBrokerUserSnapshot)).toBe(snapshotConfigFingerprint(snap()));
  });

  it("changes when the seed context template changes", () => {
    expect(snapshotConfigFingerprint(snap({ contextTemplateKey: "free" }))).not.toBe(snapshotConfigFingerprint(snap()));
  });

  it("changes when the operator flips the house model dial (fleet-wide re-pin within a tick)", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(
      snapshotConfigFingerprint(
        snap({ freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro" }),
      ),
    ).not.toBe(base);
  });

  it("changes when the operator flips the user Agent default dial", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(
      snapshotConfigFingerprint(
        snap({
          builderAgentDefault: {
            primary: "platform-openrouter/deepseek/deepseek-v4-pro",
            fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
          },
        }),
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

  it("changes when the owner turns a project's checkout off — the toggle must converge on the next tick, not only on remount", () => {
    const on = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    const off = snap({
      projects: [{
        projectSlug: "camp",
        giteaRepoName: "alice-camp",
        provisioningState: "active",
        checkoutEnabled: false,
      }],
    });
    expect(snapshotConfigFingerprint(off)).not.toBe(snapshotConfigFingerprint(on));
  });

  it("treats an absent checkoutEnabled as on — existing project docs carry no flag and must not re-converge", () => {
    const absent = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    const explicitlyOn = snap({
      projects: [{
        projectSlug: "camp",
        giteaRepoName: "alice-camp",
        provisioningState: "active",
        checkoutEnabled: true,
      }],
    });
    expect(snapshotConfigFingerprint(explicitlyOn)).toBe(snapshotConfigFingerprint(absent));
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

  it("ignores project checkout drift for workspace-only snapshots while retaining project config drift", () => {
    const withoutProject = snap({
      projectCheckoutScope: "workspace-only",
      projects: [],
    });
    const withProject = snap({
      projectCheckoutScope: "workspace-only",
      projects: [
        { projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" },
      ],
    });

    expect(snapshotConfigFingerprint(withProject)).toBe(
      snapshotConfigFingerprint(withoutProject),
    );
    expect(snapshotConfigFingerprint(withProject)).not.toBe(
      snapshotConfigFingerprint(snap({
        ...withProject,
        projectAgents: [
          { projectId: "camp", enabled: true, mmUserId: "mm-camp", token: "pat-camp" },
        ],
      })),
    );
  });

  it("changes when a project connects a GitHub repo — the pod must re-point its checkout", () => {
    const gitea = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    const github = snap({
      projects: [
        {
          projectSlug: "camp",
          giteaRepoName: "alice-camp",
          provisioningState: "active",
          repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
        },
      ],
    });
    expect(snapshotConfigFingerprint(github)).not.toBe(snapshotConfigFingerprint(gitea));
  });

  it("changes when the connected GitHub repo is swapped", () => {
    const project = (repo: string) => snap({
      projects: [
        {
          projectSlug: "camp",
          giteaRepoName: null,
          provisioningState: "active",
          repoSource: { provider: "github", owner: "octogee-ai", repo },
        },
      ],
    });
    expect(snapshotConfigFingerprint(project("demo"))).not.toBe(
      snapshotConfigFingerprint(project("other")),
    );
  });

  it("counts a GitHub-backed project with no Gitea repo as clone drift", () => {
    const base = snapshotConfigFingerprint(snap({ projects: [] }));
    expect(
      snapshotConfigFingerprint(
        snap({
          projects: [
            {
              projectSlug: "camp",
              giteaRepoName: null,
              provisioningState: "active",
              repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
            },
          ],
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

  it("changes when the agent identity, token, or model config changes", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(snapshotConfigFingerprint(snap({ coachIdentity: { name: "Buddy", emoji: "🐶" } }))).not.toBe(base);
    expect(snapshotConfigFingerprint(snap({ coachToken: "rotated-pat" }))).not.toBe(base);
    expect(
      snapshotConfigFingerprint(snap({ systemConfig: { byot: { provider: "anthropic", model: "claude" } } })),
    ).not.toBe(base);
  });
});

describe("desiredUsers", () => {
  it("returns slug→fingerprint for every snapshot AND seeds each snapshot into the adapter cache", () => {
    const seed = vi.fn();
    const users = [snap(), snap({ uid: "u2", slug: "bob" })];

    const map = desiredUsers(users, [
      { uid: "u1", state: "serving", epoch: 1 },
      { uid: "u2", state: "serving", epoch: 1 },
    ], seed);

    expect([...map.keys()].sort()).toEqual(["alice", "bob"]);
    expect(map.get("alice")?.fingerprint).toBe(snapshotConfigFingerprint(users[0]));
    // Every fingerprinted snapshot is seeded — the ensure that a drift triggers must
    // apply exactly the content the fingerprint described, not a stale cache entry.
    expect(seed).toHaveBeenCalledTimes(2);
    expect(seed).toHaveBeenCalledWith(users[0]);
    expect(seed).toHaveBeenCalledWith(users[1]);
  });

  it("tolerates an absent seeder (operator-style callers without a cache)", () => {
    const map = desiredUsers([snap()], [{ uid: "u1", state: "serving", epoch: 1 }]);
    expect(map.size).toBe(1);
  });

  it("lanes a user that has completed provisioning as a move and an unprovisioned one as a create", () => {
    const map = desiredUsers([
      snap({ status: "complete" }),
      snap({ uid: "u2", slug: "bob", status: "provisioning" }),
      snap({ uid: "u3", slug: "cara", status: "" }),
    ], [
      { uid: "u1", state: "serving", epoch: 1 },
      { uid: "u2", state: "serving", epoch: 1 },
      { uid: "u3", state: "migrating", epoch: 1 },
    ]);
    expect(map.get("alice")?.lane).toBe("move");
    expect(map.get("bob")?.lane).toBe("create");
    expect(map.get("cara")?.lane).toBe("create");
  });
});

it('refreshes runtime identity and retries delivery when project onboarding changes', () => {
  const p = { projectId: 'camp', enabled: true, mmUserId: 'mm', token: 'pat' };
  const original = snapshotConfigFingerprint(snap({ projectAgents: [p] }));
  expect(snapshotConfigFingerprint(snap({ projectAgents: [{ ...p, identity: { name: 'Chip', emoji: '⛳', persona: 'Caddie' } }] }))).not.toBe(original);
  expect(snapshotConfigFingerprint(snap({ projectAgents: [{ ...p, deliveryPending: true }] }))).not.toBe(original);
});
