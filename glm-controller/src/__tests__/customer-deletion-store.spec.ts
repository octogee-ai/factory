import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import {
  deleteProjectAgentCredentialSecrets,
  ensureAnonymousDeletionArchive,
  persistDeletionProductContext,
} from "../index.js";

const builderRoot = {
  gatewayId: "alice-gw", latestRelease: 1, desiredRelease: 1, desiredStatus: "running",
  gatewayClass: "builder", profile: "builder", imageProfile: "builder",
};

function deletionJob(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, uid: "uid-alice", status: "hibernating", requestedAt: Date.UTC(2026, 9, 3),
    eraseAfter: Date.UTC(2026, 10, 3), currentGatewayId: "alice-gw", ...overrides,
  };
}

function productDb(rows: Record<string, Record<string, unknown>>): Firestore {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({ get: async () => ({ data: () => rows[`${name}/${id}`] }) }),
    }),
  } as unknown as Firestore;
}

describe("ensureAnonymousDeletionArchive", () => {
  it("archives the erased customer once and links the archive to its deletion job", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["customerDeletionJobs/del-1", deletionJob()],
      ["gateways/alice-gw", builderRoot],
    ]);
    const store = createDocumentFixtureStore(documents);
    const db = productDb({ "users/uid-alice": { selectedTier: "personal_pro" } });

    const archiveId = await ensureAnonymousDeletionArchive(db, store, "del-1");

    expect(documents.get("customerDeletionJobs/del-1")).toMatchObject({ archiveId, updatedAt: expect.any(Number) });
    expect(documents.get(`anonymousOperationalArchives/${archiveId}`)).toMatchObject({
      schemaVersion: 1, planTier: "personal_pro", gatewayClass: "builder", archivedAt: expect.any(Number),
    });
    await expect(ensureAnonymousDeletionArchive(db, store, "del-1")).resolves.toBe(archiveId);
    expect([...documents.keys()].filter((path) => path.startsWith("anonymousOperationalArchives/"))).toHaveLength(1);
  });

  it("refuses a vanished deletion job instead of archiving an unknown customer", async () => {
    await expect(ensureAnonymousDeletionArchive(productDb({}), createDocumentFixtureStore({}), "del-1"))
      .rejects.toThrow("deletion job missing: del-1");
  });
});

describe("persistDeletionProductContext", () => {
  it("records Stripe references without dropping the PostHog erasure state already on the job", async () => {
    const posthogErasure = { status: "requested", personIds: ["person-1"] };
    const documents = new Map<string, Record<string, unknown>>([
      ["customerDeletionJobs/del-1", deletionJob({ posthogErasure, stripeCustomerIds: ["cus_old"] })],
    ]);

    await persistDeletionProductContext(createDocumentFixtureStore(documents), "del-1", { stripeCustomerIds: ["cus_1"], stripeSubscriptionIds: ["sub_1"] });

    expect(documents.get("customerDeletionJobs/del-1")).toMatchObject({
      posthogErasure, stripeCustomerIds: ["cus_1"], stripeSubscriptionIds: ["sub_1"], updatedAt: expect.any(Number),
    });
  });

  it("refuses a vanished deletion job instead of creating one", async () => {
    const documents = new Map<string, Record<string, unknown>>();
    await expect(persistDeletionProductContext(createDocumentFixtureStore(documents), "del-1", { stripeCustomerIds: [] }))
      .rejects.toThrow("deletion job missing: del-1");
    expect(documents.size).toBe(0);
  });
});

describe("deleteProjectAgentCredentialSecrets", () => {
  it("deletes each project-agent Mattermost credential of the suspended Builder", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["users/uid-alice/secrets/projectAgentMattermost-p1", { personalToken: "t1" }],
      ["users/uid-alice/secrets/projectAgentMattermost-p2", { personalToken: "t2" }],
      ["users/uid-alice/secrets/coachMattermost", { personalToken: "coach" }],
    ]);

    await deleteProjectAgentCredentialSecrets(createDocumentFixtureStore(documents), [
      "users/uid-alice/secrets/projectAgentMattermost-p1",
      "users/uid-alice/secrets/projectAgentMattermost-p2",
    ]);

    expect([...documents.keys()]).toEqual(["users/uid-alice/secrets/coachMattermost"]);
  });

  it("refuses a credential path outside a Builder's secrets before deleting any", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["users/uid-alice/secrets/projectAgentMattermost-p1", { personalToken: "t1" }],
    ]);

    await expect(deleteProjectAgentCredentialSecrets(createDocumentFixtureStore(documents), [
      "users/uid-alice/secrets/projectAgentMattermost-p1",
      "workspaces/alice/projects/p1",
    ])).rejects.toThrow("project-agent credential is not a Builder secret: workspaces/alice/projects/p1");
    expect(documents.has("users/uid-alice/secrets/projectAgentMattermost-p1")).toBe(true);
  });
});
