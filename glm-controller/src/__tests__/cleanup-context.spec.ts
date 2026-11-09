

import { describe, it, expect } from "vitest";
import { builderAccountFromData, type BuilderAccountReader } from "@octogee/core/builder-account";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { loadCustomerCleanupContext, type ContextDeps } from "../lib/customer-ops/cleanup-context";

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
  where: (field: string, op: "==", value: unknown) => {
    get: () => Promise<{ docs: Array<DocSnap & { id: string; data: () => unknown }> }>;
  };
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
        where: (field: string, _op: "==", value: unknown) => ({
          get: async () => {
            const prefix = `${path}/`;
            const matches = Object.entries(initialDocs)
              .filter(([key, data]) =>
                data !== undefined &&
                key.startsWith(prefix) &&
                !key.slice(prefix.length).includes("/") &&
                data[field] === value)
              .map(([key, data]) => ({
                id: key.slice(prefix.length),
                exists: true,
                data: () => data,
              }));
            return { docs: matches as Array<DocSnap & { id: string; data: () => unknown }> };
          },
        }),
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

function agentImportDoc(uid: string, importId: string): Record<string, unknown> {
  return { uid, importId, status: "complete", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

function contextDeps(initialDocs: Record<string, Record<string, unknown> | undefined>): ContextDeps {
  const account = (uid: string) => {
    const data = initialDocs[`users/${uid}`];
    return data === undefined ? null : builderAccountFromData(uid, data);
  };
  const accounts: BuilderAccountReader = {
    get: async (uid) => account(uid),
    getMany: async () => { throw new Error("cleanup context reads one account"); },
    list: async () => { throw new Error("cleanup context reads one account"); },
  };
  return {
    store: createDocumentFixtureStore(initialDocs),
    accounts,
    db: buildDb(initialDocs) as unknown as ContextDeps["db"],
  };
}

describe("loadCustomerCleanupContext", () => {
  it("returns null when the user doc does not exist", async () => {
    const deps = contextDeps({});
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-missing",
    );
    expect(ctx).toBeNull();
  });

  it("resolves slug from provisioning.openclaw.slug (canonical)", async () => {
    const deps = contextDeps({
      "users/uid-alice": {
        email: "alice@example.com",
        provisioning: { openclaw: { slug: "alice-canon", gatewayId: "gw-test" } },
      },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.slug).toBe("alice-canon");
    expect(ctx?.currentGatewayId).toBe("gw-test");
    expect(ctx?.email).toBe("alice@example.com");
  });

  it("normalizes the captured email used to erase email-indexed PII", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice", email: " Alice@Example.COM " },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.email).toBe("alice@example.com");
  });

  it("falls back to username when openclaw.slug is missing", async () => {
    const deps = contextDeps({
      "users/uid-bob": { username: "bob-legacy" },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-bob",
    );
    expect(ctx?.slug).toBe("bob-legacy");
    expect(ctx?.currentGatewayId).toBeNull();
  });

  it("returns empty repoNames + null IDs when no slug at all", async () => {
    const deps = contextDeps({
      "users/uid-bare": { email: "bare@example.com" },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-bare",
    );
    expect(ctx?.slug).toBe("");
    expect(ctx?.repoNames).toEqual([]);
    expect(ctx?.workspaceTeamId).toBeNull();
    expect(ctx?.adminChannelId).toBeNull();
  });

  it("derives bare project repo names (org-namespaced) from the project slug when giteaRepoName absent", async () => {
    const deps = contextDeps({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/blog": { slug: "blog", ownerUid: "uid-alice" },
      "workspaces/alice/projects/shop": { projectSlug: "shop", ownerUid: "uid-alice" },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.repoNames).toEqual(["workspace", "system_config", "blog", "shop"]);
  });

  it("prefers projData.giteaRepoName when present (the actual Gitea name)", async () => {
    const deps = contextDeps({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/p1": {
        slug: "ignored-derivation",
        giteaRepoName: "alice-proj-canonical-name",
        ownerUid: "uid-alice",
      },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.repoNames).toContain("alice-proj-canonical-name");
    expect(ctx?.repoNames).not.toContain("alice-proj-ignored-derivation");
  });

  it("falls back to project doc id when neither slug nor projectSlug nor giteaRepoName is set", async () => {
    const deps = contextDeps({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/legacy-doc-id": { ownerUid: "uid-alice" },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.repoNames).toEqual(["workspace", "system_config", "legacy-doc-id"]);
  });

  it("surfaces projectSlugs[] directly from project docs (PR #3 — drives Firebase Hosting deletes)", async () => {

const deps = contextDeps({
      "users/uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice" } },
      },
      "workspaces/alice/projects/blog": { slug: "blog", ownerUid: "uid-alice" },
      "workspaces/alice/projects/shop": { projectSlug: "shop", ownerUid: "uid-alice" },
      "workspaces/alice/projects/legacy-id": { ownerUid: "uid-alice" },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );
    
    expect(ctx?.projectSlugs).toEqual(["blog", "legacy-id", "shop"]);
  });

  it("names projects by their document id rather than a diverging legacy slug field", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice", provisioning: { openclaw: { slug: "alice" } } },
      "workspaces/alice/projects/blog": { slug: "legacy-blog", projectSlug: "legacy-blog", ownerUid: "uid-alice" },
    });
    const ctx = await loadCustomerCleanupContext(deps, "uid-alice");
    expect(ctx?.projectSlugs).toEqual(["blog"]);
    expect(ctx?.repoNames).toEqual(["workspace", "system_config", "blog"]);
  });

  it("fails context capture when a workspace project record has no owner", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice", provisioning: { openclaw: { slug: "alice" } } },
      "workspaces/alice/projects/blog": { slug: "blog" },
    });
    await expect(loadCustomerCleanupContext(deps, "uid-alice")).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("returns projectSlugs: [] when the customer has no projects", async () => {
    const deps = contextDeps({
      "users/uid-bob": { username: "bob", provisioning: { openclaw: { slug: "bob" } } },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-bob",
    );
    expect(ctx?.projectSlugs).toEqual([]);
  });

  it("returns projectSlugs: [] when the customer has no slug (no workspace path to scan)", async () => {
    const deps = contextDeps({
      "users/uid-bare": { email: "bare@example.com" },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-bare",
    );
    expect(ctx?.projectSlugs).toEqual([]);
  });

  it("resolves Mattermost IDs from user, workspace, agents, and admin channel docs", async () => {
    const deps = contextDeps({
      "users/uid-alice": {
        username: "alice",
        email: "alice@example.com",
        provisioning: { openclaw: { slug: "alice", gatewayId: "gw-test" } },
        mattermost: { userId: "mm-u-1" },
      },
      "workspaces/alice": { id: "alice", ownerUid: "uid-alice", mattermost: { teamId: "team-1" } },
      "agents/uid-alice": { mattermost: { userId: "mm-coach-1" } },
      "workspaces/alice/channels/admin": { mattermost: { channelId: "mm-c-admin" } },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
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
    const deps = contextDeps({
      "users/uid-alice": { username: "alice" },
      "users/uid-alice/system/config": {
        modelCredential: { secretName: "untrusted-firestore-secret-name" },
      },
      "users/uid-alice/integrations/byosub": {
        providers: {
          openai: { provider: "openai", connected: true, status: "connected" },
          anthropic: { provider: "anthropic", connected: true, status: "connected" },
        },
      },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.credentialSecretNames).toEqual([
      "byok-alice-anthropic",
      "byok-alice-grok",
      "byok-alice-minimax",
      "byok-alice-openai",
      "byok-alice-openai-compatible",
      "byok-alice-openrouter",
      "byosub-uid-alice-anthropic",
      "byosub-uid-alice-openai",
    ]);
  });

  it("captures deterministic BYOS secret names even when a callback has not persisted its integration", async () => {
    const deps = contextDeps({ "users/uid-alice": { username: "alice" } });

    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );

    expect(ctx?.credentialSecretNames).toEqual([
      "byok-alice-anthropic",
      "byok-alice-grok",
      "byok-alice-minimax",
      "byok-alice-openai",
      "byok-alice-openai-compatible",
      "byok-alice-openrouter",
      "byosub-uid-alice-anthropic",
      "byosub-uid-alice-openai",
    ]);
  });

  it("captures every project-agent Mattermost user and credential document before suspension", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice" },
      "users/uid-alice/secrets/projectAgentMattermost-orbit": {
        mmUserId: "mm-project-orbit",
        personalToken: "secret-orbit",
      },
      "users/uid-alice/secrets/projectAgentMattermost-labs": {
        mmUserId: "mm-project-labs",
        personalToken: "secret-labs",
      },
      "users/uid-alice/secrets/coachMattermost": {
        coachMmUserId: "mm-coach",
      },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.projectAgentMmUserIds).toEqual(["mm-project-labs", "mm-project-orbit"]);
    expect(ctx?.projectAgentCredentialDocPaths).toEqual([
      "users/uid-alice/secrets/projectAgentMattermost-labs",
      "users/uid-alice/secrets/projectAgentMattermost-orbit",
    ]);
  });

  it("captures artifact object IDs owned by the user or their workspace", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice" },
      "chatArtifactJobs/aaa": {
        artifactId: "a".repeat(64),
        ownerUid: "uid-alice",
        workspaceSlug: "other",
      },
      "chatArtifactJobs/bbb": {
        artifactId: "b".repeat(64),
        ownerUid: "uid-collaborator",
        workspaceSlug: "alice",
      },
      "chatArtifactJobs/ccc": {
        artifactId: "c".repeat(64),
        ownerUid: "uid-other",
        workspaceSlug: "other",
      },
    });
    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );
    expect(ctx?.chatArtifactIds).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("captures every agent import staging prefix owned by the user", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice" },
      "users/uid-alice/agentImports/import-owned": agentImportDoc("uid-alice", "import-owned"),
      "users/uid-other/agentImports/import-other": agentImportDoc("uid-other", "import-other"),
    });

    const ctx = await loadCustomerCleanupContext(
      deps,
      "uid-alice",
    );

    expect(ctx?.agentImportIds).toEqual(["import-owned"]);
  });

  it("fails context capture when a connected credential leaf is malformed", async () => {
    const deps = contextDeps({
      "users/uid-alice": { username: "alice" },
      "users/uid-alice/integrations/byosub": {
        providers: { openai: { connected: true, status: "connected" } },
      },
    });
    await expect(loadCustomerCleanupContext(
      deps,
      "uid-alice",
    )).rejects.toThrow(/malformed provider leaf/);
  });
});
