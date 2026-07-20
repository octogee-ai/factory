

import { describe, it, expect } from "vitest";
import { loadCustomerCleanupContext } from "../lib/customer-ops/cleanup-context";

interface DocSnap {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
  id?: string;
}

interface DocRef {
  get: () => Promise<DocSnap>;
}

interface CollectionRef {
  doc: (id: string) => DocRef;
  get: () => Promise<{ docs: Array<DocSnap & { id: string; data: () => unknown }> }>;
}

interface DbStub {
  collection: (path: string) => CollectionRef;
  doc: (path: string) => DocRef;
}

function buildDb(initialDocs: Record<string, Record<string, unknown> | undefined>): DbStub {
  return {
    collection(path: string): CollectionRef {
      return {
        doc(id: string): DocRef {
          const fullPath = `${path}/${id}`;
          return {
            get: async () => {
              const data = initialDocs[fullPath];
              return {
                exists: data !== undefined,
                data: () => data,
                id,
              };
            },
          };
        },
        get: async () => {
          
          const prefix = `${path}/`;
          const matches = Object.entries(initialDocs)
            .filter(([k, v]) => v !== undefined && k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
            .map(([k, v]) => ({
              id: k.slice(prefix.length),
              exists: true,
              data: () => v,
            }));
          return { docs: matches as Array<DocSnap & { id: string; data: () => unknown }> };
        },
      };
    },
    doc(path: string): DocRef {
      return {
        get: async () => {
          const data = initialDocs[path];
          return { exists: data !== undefined, data: () => data };
        },
      };
    },
  };
}

describe("loadCustomerCleanupContext", () => {
  it("returns null when the user doc does not exist", async () => {
    const db = buildDb({});
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-missing",
    );
    expect(ctx).toBeNull();
  });

  it("resolves slug from provisioning.openclaw.slug (canonical)", async () => {
    const db = buildDb({
      "users/uid-alice": {
        email: "alice@example.com",
        provisioning: { openclaw: { slug: "alice-canon", gatewayId: "gw-test" } },
      },
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-alice",
    );
    expect(ctx?.slug).toBe("alice-canon");
    expect(ctx?.currentGatewayId).toBe("gw-test");
  });

  it("falls back to username when openclaw.slug is missing", async () => {
    const db = buildDb({
      "users/uid-bob": { username: "bob-legacy" },
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-bob",
    );
    expect(ctx?.slug).toBe("bob-legacy");
    expect(ctx?.currentGatewayId).toBeNull();
  });

  it("returns empty repoNames + null IDs when no slug at all", async () => {
    const db = buildDb({
      "users/uid-bare": { email: "bare@example.com" },
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-bare",
    );
    expect(ctx?.slug).toBe("");
    expect(ctx?.repoNames).toEqual([]);
    expect(ctx?.workspaceTeamId).toBeNull();
    expect(ctx?.adminChannelId).toBeNull();
  });

  it("derives bare project repo names (org-namespaced) when giteaRepoName absent", async () => {
    const db = buildDb({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/p1": { slug: "blog" },
      "workspaces/alice/projects/p2": { projectSlug: "shop" },
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-alice",
    );
    expect(ctx?.repoNames).toEqual(["workspace", "system_config", "blog", "shop"]);
  });

  it("prefers projData.giteaRepoName when present (the actual Gitea name)", async () => {
    const db = buildDb({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/p1": {
        slug: "ignored-derivation",
        giteaRepoName: "alice-proj-canonical-name",
      },
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-alice",
    );
    expect(ctx?.repoNames).toContain("alice-proj-canonical-name");
    expect(ctx?.repoNames).not.toContain("alice-proj-ignored-derivation");
  });

  it("falls back to project doc id when neither slug nor projectSlug nor giteaRepoName is set", async () => {
    const db = buildDb({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/legacy-doc-id": {},
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-alice",
    );
    expect(ctx?.repoNames).toEqual(["workspace", "system_config", "legacy-doc-id"]);
  });

  it("surfaces projectSlugs[] directly from project docs (PR #3 — drives Firebase Hosting deletes)", async () => {

const db = buildDb({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/p1": { slug: "blog" },
      "workspaces/alice/projects/p2": { projectSlug: "shop" },
      "workspaces/alice/projects/legacy-id": {},
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-alice",
    );
    
    expect(ctx?.projectSlugs).toEqual(["blog", "legacy-id", "shop"]);
  });

  it("returns projectSlugs: [] when the customer has no projects", async () => {
    const db = buildDb({
      "users/uid-bob": { username: "bob", provisioning: { openclaw: { slug: "bob" } } },
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-bob",
    );
    expect(ctx?.projectSlugs).toEqual([]);
  });

  it("returns projectSlugs: [] when the customer has no slug (no workspace path to scan)", async () => {
    const db = buildDb({
      "users/uid-bare": { email: "bare@example.com" },
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-bare",
    );
    expect(ctx?.projectSlugs).toEqual([]);
  });

  it("resolves Mattermost IDs from user, workspace, agents, and admin channel docs", async () => {
    const db = buildDb({
      "users/uid-alice": {
        username: "alice",
        email: "alice@example.com",
        provisioning: { openclaw: { slug: "alice", gatewayId: "gw-test" } },
        mattermost: { userId: "mm-u-1" },
      },
      "workspaces/alice": { mattermost: { teamId: "team-1" } },
      "agents/uid-alice": { mattermost: { userId: "mm-coach-1" } },
      "workspaces/alice/channels/admin": { mattermost: { channelId: "mm-c-admin" } },
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-alice",
    );
    expect(ctx).toMatchObject({
      uid: "uid-alice",
      slug: "alice",
      mmUserId: "mm-u-1",
      mmCoachUserId: "mm-coach-1",
      workspaceTeamId: "team-1",
      adminChannelId: "mm-c-admin",
      currentGatewayId: "gw-test",
      giteaOrg: "alice",
    });
  });

  it("captures every persisted model credential secret name before deletion", async () => {
    const db = buildDb({
      "users/uid-alice": { username: "alice" },
      "users/uid-alice/system/config": {
        modelCredential: { secretName: "byok-alice-openai-compatible" },
      },
      "users/uid-alice/integrations/byosub": {
        providers: {
          openai: { provider: "openai", connected: true, status: "connected" },
          anthropic: { provider: "anthropic", connected: true, status: "connected" },
        },
      },
    });
    const ctx = await loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-alice",
    );
    expect(ctx?.credentialSecretNames).toEqual([
      "byok-alice-openai-compatible",
      "byosub-uid-alice-anthropic",
      "byosub-uid-alice-openai",
    ]);
  });

  it("fails context capture when a connected credential leaf is malformed", async () => {
    const db = buildDb({
      "users/uid-alice": { username: "alice" },
      "users/uid-alice/integrations/byosub": {
        providers: { openai: { connected: true, status: "connected" } },
      },
    });
    await expect(loadCustomerCleanupContext(
      { db: db as unknown as Parameters<typeof loadCustomerCleanupContext>[0]["db"] },
      "uid-alice",
    )).rejects.toThrow(/malformed provider leaf/);
  });
});
