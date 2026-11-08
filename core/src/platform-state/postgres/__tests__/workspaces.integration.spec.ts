import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicateRecordError, FenceMismatchError, MissingRecordError } from "../../errors.js";
import type { TimeInput, WatchAggregate, WatchChange, WatchRecords, WatchRequest } from "../../store.js";
import type { WorkspaceChannel, WorkspaceInput, WorkspaceMember, WorkspaceProjectInput } from "../../workspaces.js";
import { createHarness, dsn, recordingListener, type PlatformStateHarness, type RecordingListener } from "./fixtures/harness.js";

const NOW = 1_762_500_000_000;
const WAIT = { timeout: 20_000, interval: 20 };

function workspace(slug: string, ownerUid: string, overrides: Partial<WorkspaceInput> = {}): WorkspaceInput {
  return {
    slug,
    id: slug,
    ownerUid,
    ownerActive: null,
    mattermostTeamId: `team-${slug}`,
    giteaOrgName: slug,
    giteaRepoName: `${slug}-workspace`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function member(workspaceSlug: string, uid: string, overrides: Partial<Omit<WorkspaceMember, "joinedAt"> & { joinedAt: TimeInput | null }> = {}) {
  return { workspaceSlug, uid, role: "member" as const, joinedAt: NOW, mattermostUserId: null, ...overrides };
}

function project(workspaceSlug: string, projectSlug: string, overrides: Partial<WorkspaceProjectInput> = {}): WorkspaceProjectInput {
  return {
    workspaceSlug,
    projectSlug,
    ownerUid: "u1",
    ownerActive: null,
    giteaRepoName: `${workspaceSlug}-${projectSlug}`,
    provisioningState: "ready",
    provisioningError: null,
    pendingVisibility: null,
    visibility: "private",
    checkoutEnabled: null,
    status: "active",
    archived: null,
    archivedAt: null,
    commercialLifecycleStatus: null,
    repoSource: null,
    agent: null,
    updatedAt: NOW,
    ...overrides,
  };
}

type ChannelInput = Omit<WorkspaceChannel, "createdAt"> & { readonly createdAt: WorkspaceInput["createdAt"] };

function channel(workspaceSlug: string, projectSlug: string | null, channelId: string, overrides: Partial<ChannelInput> = {}): ChannelInput {
  return {
    scope: { workspaceSlug, projectSlug },
    channelId,
    kind: "general",
    mattermostChannelId: `mm-${workspaceSlug}-${projectSlug ?? "ws"}-${channelId}`,
    archivedAt: null,
    createdBy: null,
    createdAt: NOW,
    ...overrides,
  };
}

const channelLabel = (record: WorkspaceChannel) => `${record.scope.workspaceSlug}/${record.scope.projectSlug ?? "-"}/${record.channelId}`;

function changesOf<A extends WatchAggregate>(listener: RecordingListener<A>): WatchChange<A>[] {
  return listener.events.flatMap((event) => (event.kind === "changes" ? [...event.changes] : []));
}

function changeLog<A extends WatchAggregate>(listener: RecordingListener<A>): string[] {
  return changesOf(listener).map((change) => `${change.type}:${change.key}`);
}

function snapshotOf<A extends WatchAggregate>(listener: RecordingListener<A>): readonly WatchRecords[A][] | undefined {
  const event = listener.events.find((candidate) => candidate.kind === "snapshot");
  return event?.kind === "snapshot" ? event.records : undefined;
}

describe.skipIf(!dsn)("PostgreSQL workspace repositories", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function watch<A extends WatchAggregate>(request: WatchRequest<A>): Promise<RecordingListener<A>> {
    const listener = recordingListener<A>();
    harness.store.watch(request, listener);
    await vi.waitFor(() => expect(snapshotOf(listener)).toBeDefined(), WAIT);
    return listener;
  }

  describe("records", () => {
    it("looks up Mattermost teams and rejects ambiguous matches", async () => {
      const records = harness.store.workspaces.records;
      expect(await records.findByMattermostTeamId("team-acme")).toBeNull();
      await records.put(workspace("acme", "u1"));
      expect(await records.findByMattermostTeamId("team-acme")).toMatchObject({ slug: "acme", ownerUid: "u1" });
      await records.put(workspace("other", "u2", { mattermostTeamId: "team-acme" }));
      await expect(records.findByMattermostTeamId("team-acme")).rejects.toBeInstanceOf(DuplicateRecordError);
    });

    it("reads project membership inside a transaction and removes it with its project", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.projects.put(project("acme", "demo"));
      const members = harness.store.workspaces.projectMembers;
      expect(await members.get("acme", "demo", "u2")).toBeNull();
      await harness.query("INSERT INTO $schema.workspace_project_members (workspace_slug, project_slug, uid, role) VALUES ('acme', 'demo', 'u2', 'member')");
      const member = await harness.store.transaction({ label: "project-membership" }, tx => tx.workspaces.projectMembers.get("acme", "demo", "u2"));
      expect(member).toMatchObject({ workspaceSlug: "acme", projectSlug: "demo", uid: "u2", role: "member" });
      await harness.query("UPDATE $schema.workspace_project_members SET role = 'owner' WHERE uid = 'u2'");
      expect((await members.get("acme", "demo", "u2"))!.revision).not.toBe(member!.revision);
      await expect(harness.query("UPDATE $schema.workspace_project_members SET role = 'invalid' WHERE uid = 'u2'")).rejects.toThrow();
      await harness.store.workspaces.projects.delete("acme", "demo");
      expect(await members.get("acme", "demo", "u2")).toBeNull();
    });

    it("round-trips every field with a revision and reads a missing workspace as null", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1", { ownerActive: true, createdAt: NOW - 1_000 }));

      expect(await harness.store.workspaces.records.get("acme")).toEqual({
        slug: "acme",
        id: "acme",
        ownerUid: "u1",
        ownerActive: true,
        channelProvider: "managed",
        channelInstallation: "default",
        gitHost: "managed",
        mattermostTeamId: "team-acme",
        giteaOrgName: "acme",
        giteaRepoName: "acme-workspace",
        createdAt: NOW - 1_000,
        updatedAt: NOW,
        revision: expect.stringMatching(/^\d+$/),
      });
      expect(await harness.store.workspaces.records.get("missing")).toBeNull();
    });

    it("keeps an absent ownerActive distinct from false", async () => {
      await harness.store.workspaces.records.put(workspace("live", "u1", { ownerActive: false }));
      await harness.store.workspaces.records.put(workspace("unknown", "u1"));

      expect((await harness.store.workspaces.records.get("live"))?.ownerActive).toBe(false);
      expect((await harness.store.workspaces.records.get("unknown"))?.ownerActive).toBeNull();
    });

    it("writes a server updatedAt and no createdAt", async () => {
      const before = Date.now();
      await harness.store.workspaces.records.put(workspace("fresh", "u1", { createdAt: null, updatedAt: { serverNow: true } }));

      const stored = await harness.store.workspaces.records.get("fresh");
      expect(stored?.createdAt).toBeNull();
      expect(stored?.updatedAt).toBeGreaterThanOrEqual(before - 5_000);
    });

    it("merges a put over the stored workspace and leaves null fields untouched", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1", { ownerActive: true, createdAt: NOW - 1_000 }));

      await harness.store.workspaces.records.put(
        workspace("acme", "u1", {
          ownerActive: null,
          mattermostTeamId: "team-2",
          giteaOrgName: null,
          giteaRepoName: null,
          createdAt: null,
          updatedAt: NOW + 5,
        }),
      );

      expect(await harness.store.workspaces.records.get("acme")).toMatchObject({
        ownerActive: true,
        mattermostTeamId: "team-2",
        giteaOrgName: "acme",
        giteaRepoName: "acme-workspace",
        createdAt: NOW - 1_000,
        updatedAt: NOW + 5,
      });
    });

    it("patches identity fields, clears ownerActive and refuses to change the id", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1", { ownerActive: false }));

      await harness.store.workspaces.records.patch("acme", {
        mattermostTeamId: "team-2",
        giteaRepoName: "acme-renamed",
        ownerActive: { clear: true },
        createdAt: { clear: true },
        updatedAt: NOW + 1,
      });

      expect(await harness.store.workspaces.records.get("acme")).toMatchObject({
        ownerActive: null,
        mattermostTeamId: "team-2",
        giteaOrgName: "acme",
        giteaRepoName: "acme-renamed",
        createdAt: null,
        updatedAt: NOW + 1,
      });
      await expect(harness.store.workspaces.records.patch("acme", { id: "other" } as never)).rejects.toBeInstanceOf(TypeError);
    });

    it("fences a patch on the revision and refuses a missing workspace", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      const before = (await harness.store.workspaces.records.get("acme"))!;
      await harness.store.workspaces.records.patch("acme", { ownerActive: true });

      await expect(
        harness.store.workspaces.records.patch("acme", { ownerActive: false }, { revision: before.revision }),
      ).rejects.toMatchObject({ constructor: FenceMismatchError, fence: "revision", expected: before.revision });
      await expect(harness.store.workspaces.records.patch("missing", { ownerActive: true })).rejects.toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "workspace", key: "missing" },
      });
      const current = (await harness.store.workspaces.records.get("acme"))!;
      await harness.store.workspaces.records.patch("acme", { ownerActive: false }, { revision: current.revision });
      expect((await harness.store.workspaces.records.get("acme"))?.ownerActive).toBe(false);
    });

    it("lists workspaces by owner", async () => {
      await harness.store.workspaces.records.put(workspace("beta", "u1"));
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.records.put(workspace("other", "u2"));

      expect((await harness.store.workspaces.records.listByOwner("u1")).map((record) => record.slug)).toEqual(["acme", "beta"]);
      expect(await harness.store.workspaces.records.listByOwner("nobody")).toEqual([]);
    });

    it("deletes a workspace with its members, projects and channels, inside a transaction too", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.records.put(workspace("acme-x", "u1"));
      await harness.store.workspaces.members.put(member("acme", "u1", { role: "owner" }));
      await harness.store.workspaces.projects.put(project("acme", "site"));
      await harness.store.workspaces.channels.put(channel("acme", "site", "c1"));
      await harness.store.workspaces.channels.put(channel("acme", null, "general"));
      await harness.store.workspaces.members.put(member("acme-x", "u1"));

      await harness.store.transaction({ label: "drop-workspace" }, (tx) => tx.workspaces.records.delete("acme"));

      expect(await harness.store.workspaces.records.get("acme")).toBeNull();
      expect(await harness.store.workspaces.members.list("acme")).toEqual([]);
      expect(await harness.store.workspaces.projects.list("acme")).toEqual([]);
      expect(await harness.store.workspaces.channels.list({ workspaceSlug: "acme", projectSlug: "site" })).toEqual([]);
      expect(await harness.store.workspaces.channels.list({ workspaceSlug: "acme", projectSlug: null })).toEqual([]);
      expect(await harness.store.workspaces.records.get("acme-x")).not.toBeNull();
      expect(await harness.store.workspaces.members.list("acme-x")).toHaveLength(1);
      await harness.store.workspaces.records.delete("acme");
    });

    it("refuses members, projects and channels of a workspace that does not exist", async () => {
      const missingWorkspace = { constructor: MissingRecordError, record: { aggregate: "workspace", key: "ghost" } };

      await expect(harness.store.workspaces.members.put(member("ghost", "u1"))).rejects.toMatchObject(missingWorkspace);
      await expect(harness.store.workspaces.projects.put(project("ghost", "site"))).rejects.toMatchObject(missingWorkspace);
      await expect(harness.store.workspaces.channels.put(channel("ghost", null, "general"))).rejects.toMatchObject(missingWorkspace);
    });
  });

  describe("members", () => {
    beforeEach(async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.records.put(workspace("beta", "u2"));
    });

    it("round-trips canonical membership fields through all readers and preserves them on unrelated puts", async () => {
      const canonical = { mattermostChannelId: "channel-general", canonicalSource: "mattermost", canonicalState: "active" };
      const members = harness.store.workspaces.members;
      await members.put(member("acme", "u1", canonical));
      const initial = await members.get("acme", "u1");
      expect(initial).toMatchObject(canonical);
      await members.put(member("acme", "u1", { role: "owner" }));
      expect(await members.get("acme", "u1")).toMatchObject({ ...canonical, role: "owner" });
      expect((await members.get("acme", "u1"))!.revision).not.toBe(initial!.revision);
      expect(await members.list("acme")).toEqual([expect.objectContaining(canonical)]);
      expect(await members.listForUid("u1")).toEqual([expect.objectContaining(canonical)]);
    });

    it("writes a member with a server joinedAt and reads it back", async () => {
      const before = Date.now();
      await harness.store.workspaces.members.put(member("acme", "u1", { role: "owner", joinedAt: { serverNow: true } }));

      expect(await harness.store.workspaces.members.get("acme", "u1")).toEqual({
        workspaceSlug: "acme",
        uid: "u1",
        role: "owner",
        joinedAt: expect.any(Number),
        mattermostUserId: null,
        mattermostChannelId: null,
        canonicalSource: null,
        canonicalState: null,
        revision: expect.any(String),
      });
      expect((await harness.store.workspaces.members.get("acme", "u1"))!.joinedAt).toBeGreaterThanOrEqual(before - 5_000);
      expect(await harness.store.workspaces.members.get("acme", "u9")).toBeNull();
    });

    it("merges a member put and keeps the stored join time when the put carries none", async () => {
      await harness.store.workspaces.members.put(member("acme", "u2", { joinedAt: NOW - 10 }));

      await harness.store.workspaces.members.put(member("acme", "u2", { joinedAt: null, mattermostUserId: "mm-u2" }));

      expect(await harness.store.workspaces.members.get("acme", "u2")).toMatchObject({
        role: "member",
        joinedAt: NOW - 10,
        mattermostUserId: "mm-u2",
      });
    });

    it("lists a workspace's members and a uid's memberships", async () => {
      await harness.store.workspaces.members.put(member("acme", "u1", { role: "owner" }));
      await harness.store.workspaces.members.put(member("beta", "u1"));
      await harness.store.workspaces.members.put(member("beta", "u2", { role: "owner" }));

      const memberships = await harness.store.workspaces.members.listForUid("u1");

      expect(memberships.map((record) => `${record.workspaceSlug}:${record.role}`)).toEqual(["acme:owner", "beta:member"]);
      expect((await harness.store.workspaces.members.list("beta")).map((record) => record.uid)).toEqual(["u1", "u2"]);
    });

    it("deletes a membership", async () => {
      await harness.store.workspaces.members.put(member("acme", "u1"));

      await harness.store.workspaces.members.delete("acme", "u1");
      await harness.store.workspaces.members.delete("acme", "u1");

      expect(await harness.store.workspaces.members.get("acme", "u1")).toBeNull();
    });
  });

  describe("projects", () => {
    beforeEach(async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.records.put(workspace("beta", "u1"));
    });

    it("round-trips every project field", async () => {
      const full = project("acme", "site", {
        ownerActive: true,
        gitHost: "github.com",
        provisioningError: "repo missing",
        pendingVisibility: "public",
        checkoutEnabled: false,
        archived: false,
        archivedAt: NOW - 7,
        commercialLifecycleStatus: "active",
        repoSource: { provider: "github", owner: "ada", repo: "site" },
        agent: { model: "anthropic/claude", persona: "Builder", updatedAt: NOW - 50 },
      });
      await harness.store.workspaces.projects.put(full);

      expect(await harness.store.workspaces.projects.get("acme", "site")).toEqual({ ...full, revision: expect.any(String) });
      expect(await harness.store.workspaces.projects.get("acme", "missing")).toBeNull();
    });

    it("merges a put, deep-merging the agent map and leaving null fields untouched", async () => {
      await harness.store.workspaces.projects.put(
        project("acme", "site", {
          ownerActive: true,
          checkoutEnabled: false,
          agent: { model: "anthropic/claude", persona: "Builder", tools: { web: true, shell: false }, updatedAt: NOW - 50 },
          repoSource: { provider: "github", owner: "ada", repo: "site" },
        }),
      );

      await harness.store.workspaces.projects.put(
        project("acme", "site", {
          provisioningState: "provisioning",
          visibility: null,
          agent: { model: "openai/gpt", tools: { shell: true, browser: { clear: true } }, persona: { clear: true }, updatedAt: { serverNow: true } },
          repoSource: {},
          commercialLifecycleStatus: "archived",
          updatedAt: NOW,
        }),
      );

      const stored = await harness.store.workspaces.projects.get("acme", "site");
      expect(stored).toMatchObject({
        ownerActive: true,
        checkoutEnabled: false,
        provisioningState: "provisioning",
        visibility: "private",
        commercialLifecycleStatus: "archived",
        repoSource: { provider: "github", owner: "ada", repo: "site" },
        agent: { model: "openai/gpt", tools: { web: true, shell: true }, updatedAt: expect.any(Number) },
        updatedAt: NOW,
      });
      expect(stored?.agent).not.toHaveProperty("persona");
      expect((stored?.agent as { updatedAt: number }).updatedAt).toBeGreaterThan(NOW);
    });

    it("writes a new project with an archive time and a server updatedAt", async () => {
      await harness.store.workspaces.projects.put(project("acme", "fresh", { archived: false, archivedAt: NOW, updatedAt: { serverNow: true } }));

      expect(await harness.store.workspaces.projects.get("acme", "fresh")).toMatchObject({
        archived: false,
        archivedAt: NOW,
        ownerActive: null,
        repoSource: null,
        agent: null,
        updatedAt: expect.any(Number),
      });
    });

    it("patches fields, replaces the agent map whole and clears archivedAt", async () => {
      await harness.store.workspaces.projects.put(project("acme", "site", { agent: { model: "a", persona: "p" } }));

      await harness.store.workspaces.projects.patch("acme", "site", {
        commercialLifecycleStatus: "archived",
        provisioningError: "repo missing",
        archivedAt: NOW,
        agent: { model: "b" },
        updatedAt: NOW + 1,
      });
      const archived = await harness.store.workspaces.projects.get("acme", "site");
      await harness.store.workspaces.projects.patch("acme", "site", { archivedAt: { clear: true }, agent: null });

      expect(archived).toMatchObject({
        commercialLifecycleStatus: "archived",
        provisioningError: "repo missing",
        archivedAt: NOW,
        agent: { model: "b" },
        updatedAt: NOW + 1,
      });
      expect(await harness.store.workspaces.projects.get("acme", "site")).toMatchObject({ archivedAt: null, agent: null });
      await expect(harness.store.workspaces.projects.patch("acme", "missing", { status: "x" })).rejects.toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "workspace-project", key: "acme/missing" },
      });
    });

    it("fences a project patch on the revision", async () => {
      await harness.store.workspaces.projects.put(project("acme", "site"));
      const before = (await harness.store.workspaces.projects.get("acme", "site"))!;
      await harness.store.workspaces.projects.patch("acme", "site", { status: "paused" });

      await expect(
        harness.store.workspaces.projects.patch("acme", "site", { status: "active" }, { revision: before.revision }),
      ).rejects.toBeInstanceOf(FenceMismatchError);
      expect((await harness.store.workspaces.projects.get("acme", "site"))?.status).toBe("paused");
    });

    it("lists projects by workspace, by owner and across workspaces", async () => {
      await harness.store.workspaces.projects.put(project("acme", "site", { ownerUid: "u1" }));
      await harness.store.workspaces.projects.put(project("acme", "app", { ownerUid: "u2" }));
      await harness.store.workspaces.projects.put(project("beta", "docs", { ownerUid: "u1" }));
      const labels = (records: readonly { workspaceSlug: string; projectSlug: string }[]) =>
        records.map((record) => `${record.workspaceSlug}/${record.projectSlug}`);

      expect(labels(await harness.store.workspaces.projects.list("acme"))).toEqual(["acme/app", "acme/site"]);
      expect(labels(await harness.store.workspaces.projects.listByOwner("u1"))).toEqual(["acme/site", "beta/docs"]);
      expect(labels(await harness.store.workspaces.projects.listByOwner("u1", "acme"))).toEqual(["acme/site"]);
      expect(labels(await harness.store.workspaces.projects.listAll())).toEqual(["acme/app", "acme/site", "beta/docs"]);
    });

    it("deletes only the project, leaving its channels", async () => {
      await harness.store.workspaces.projects.put(project("acme", "site"));
      await harness.store.workspaces.channels.put(channel("acme", "site", "c1"));

      await harness.store.workspaces.projects.delete("acme", "site");

      expect(await harness.store.workspaces.projects.get("acme", "site")).toBeNull();
      expect(await harness.store.workspaces.channels.get({ workspaceSlug: "acme", projectSlug: "site" }, "c1")).not.toBeNull();
    });
  });

  describe("channels", () => {
    beforeEach(async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.records.put(workspace("beta", "u1"));
    });

    it("round-trips workspace-scope and project-scope channels and a channel without a kind", async () => {
      await harness.store.workspaces.channels.put(channel("acme", null, "general", { mattermostChannelId: "mm-general" }));
      await harness.store.workspaces.channels.put(
        channel("acme", "site", "legacy", { kind: null, mattermostChannelId: "mm-legacy", createdAt: null, createdBy: "u1", archivedAt: NOW }),
      );

      expect(await harness.store.workspaces.channels.get({ workspaceSlug: "acme", projectSlug: null }, "general")).toEqual({
        scope: { workspaceSlug: "acme", projectSlug: null },
        channelId: "general",
        kind: "general",
        channelProvider: "managed",
        channelInstallation: "default",
        mattermostChannelId: "mm-general",
        archivedAt: null,
        createdBy: null,
        createdAt: NOW,
        revision: expect.any(String),
      });
      expect(await harness.store.workspaces.channels.get({ workspaceSlug: "acme", projectSlug: "site" }, "legacy")).toMatchObject({
        scope: { workspaceSlug: "acme", projectSlug: "site" },
        kind: null,
        createdAt: null,
        createdBy: "u1",
        archivedAt: NOW,
      });
      expect(await harness.store.workspaces.channels.get({ workspaceSlug: "acme", projectSlug: "site" }, "general")).toBeNull();
    });

    it("merges a channel put and keeps the stored kind when the put carries none", async () => {
      await harness.store.workspaces.channels.put(channel("acme", null, "coach-dm", { kind: "coach-dm", mattermostChannelId: null }));

      await harness.store.workspaces.channels.put(
        channel("acme", null, "coach-dm", { kind: null, mattermostChannelId: "mm-coach", createdAt: { serverNow: true } }),
      );

      expect(await harness.store.workspaces.channels.get({ workspaceSlug: "acme", projectSlug: null }, "coach-dm")).toMatchObject({
        kind: "coach-dm",
        mattermostChannelId: "mm-coach",
        createdAt: expect.any(Number),
      });
    });

    it("patches the Mattermost channel id and archive time, and refuses a missing channel by its scoped key", async () => {
      await harness.store.workspaces.channels.put(channel("acme", null, "general", { mattermostChannelId: "old" }));

      await harness.store.workspaces.channels.patch({ workspaceSlug: "acme", projectSlug: null }, "general", {
        mattermostChannelId: "new",
        archivedAt: NOW,
      });
      const archived = await harness.store.workspaces.channels.get({ workspaceSlug: "acme", projectSlug: null }, "general");
      await harness.store.workspaces.channels.patch({ workspaceSlug: "acme", projectSlug: null }, "general", { archivedAt: { clear: true } });

      expect(archived).toMatchObject({ kind: "general", mattermostChannelId: "new", archivedAt: NOW });
      expect((await harness.store.workspaces.channels.get({ workspaceSlug: "acme", projectSlug: null }, "general"))?.archivedAt).toBeNull();
      await expect(
        harness.store.workspaces.channels.patch({ workspaceSlug: "acme", projectSlug: null }, "missing", { archivedAt: NOW }),
      ).rejects.toMatchObject({ constructor: MissingRecordError, record: { aggregate: "workspace-channel", key: "acme/missing" } });
      await expect(
        harness.store.workspaces.channels.patch({ workspaceSlug: "acme", projectSlug: "site" }, "missing", { archivedAt: NOW }),
      ).rejects.toMatchObject({ constructor: MissingRecordError, record: { aggregate: "workspace-channel", key: "acme/site/missing" } });
    });

    it("finds a channel by Mattermost id with its scope", async () => {
      await harness.store.workspaces.channels.put(channel("acme", null, "general", { mattermostChannelId: "mm-ws" }));
      await harness.store.workspaces.channels.put(channel("acme", "site", "c1", { mattermostChannelId: "mm-project" }));

      expect(await harness.store.workspaces.channels.findByMattermostChannelId("mm-ws")).toMatchObject({
        scope: { workspaceSlug: "acme", projectSlug: null },
        channelId: "general",
      });
      expect(await harness.store.workspaces.channels.findByMattermostChannelId("mm-project")).toMatchObject({
        scope: { workspaceSlug: "acme", projectSlug: "site" },
        channelId: "c1",
      });
      expect(await harness.store.workspaces.channels.findByMattermostChannelId("mm-unknown")).toBeNull();
    });

    it("refuses a second channel with the same Mattermost id at write time", async () => {
      await harness.store.workspaces.channels.put(channel("acme", null, "general", { mattermostChannelId: "mm-shared" }));

      const failure = await harness.store.workspaces.channels
        .put(channel("beta", "site", "c1", { mattermostChannelId: "mm-shared" }))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DuplicateRecordError);
      expect(failure).toMatchObject({
        aggregate: "workspace-channel",
        lookup: "channel_provider, channel_installation, channel_host_channel_id",
        value: "managed, default, mm-shared",
      });
      expect(await harness.store.workspaces.channels.findByMattermostChannelId("mm-shared")).toMatchObject({ channelId: "general" });
    });

    it("lists channels per scope and deletes one", async () => {
      await harness.store.workspaces.channels.put(channel("acme", null, "general"));
      await harness.store.workspaces.channels.put(channel("acme", null, "coach-dm"));
      await harness.store.workspaces.channels.put(channel("acme", "site", "c1"));

      await harness.store.workspaces.channels.delete({ workspaceSlug: "acme", projectSlug: null }, "coach-dm");

      expect((await harness.store.workspaces.channels.list({ workspaceSlug: "acme", projectSlug: null })).map(channelLabel)).toEqual([
        "acme/-/general",
      ]);
      expect((await harness.store.workspaces.channels.list({ workspaceSlug: "acme", projectSlug: "site" })).map(channelLabel)).toEqual([
        "acme/site/c1",
      ]);
    });
  });

  describe("agent identities", () => {
    it("writes both times from the put and merges a later put over the stored Mattermost user", async () => {
      await harness.store.workspaces.agentIdentities.put({ uid: "u1", mattermostUserId: "mm-coach", at: NOW - 100 });
      await harness.store.workspaces.agentIdentities.put({ uid: "u1", mattermostUserId: null, at: NOW });
      await harness.store.workspaces.agentIdentities.put({ uid: "u2", mattermostUserId: null, at: { serverNow: true } });

      expect(await harness.store.workspaces.agentIdentities.get("u1")).toEqual({
        uid: "u1",
        mattermostUserId: "mm-coach",
        createdAt: NOW,
        updatedAt: NOW,
        revision: expect.any(String),
      });
      expect(await harness.store.workspaces.agentIdentities.get("u2")).toMatchObject({
        mattermostUserId: null,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      expect((await harness.store.workspaces.agentIdentities.listAll()).map((identity) => identity.uid)).toEqual(["u1", "u2"]);
    });

    it("refuses a Mattermost user already bound to another agent", async () => {
      await harness.store.workspaces.agentIdentities.put({ uid: "u1", mattermostUserId: "mm-coach", at: NOW });

      await expect(
        harness.store.workspaces.agentIdentities.put({ uid: "u2", mattermostUserId: "mm-coach", at: NOW }),
      ).rejects.toMatchObject({ constructor: DuplicateRecordError, aggregate: "builder-agent-identity" });
    });

    it("deletes an identity", async () => {
      await harness.store.workspaces.agentIdentities.put({ uid: "u1", mattermostUserId: "mm-coach", at: NOW });

      await harness.store.workspaces.agentIdentities.delete("u1");

      expect(await harness.store.workspaces.agentIdentities.get("u1")).toBeNull();
    });
  });

  describe("watches", () => {
    it("watches a Builder's workspaces: snapshot, then additions, modifications and removals", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.records.put(workspace("beta", "u2"));
      const listener = await watch({ aggregate: "workspaces", filter: { ownerUid: "u1" } });
      expect(snapshotOf(listener)?.map((record) => record.slug)).toEqual(["acme"]);

      await harness.store.workspaces.records.put(workspace("gamma", "u1"));
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:gamma"]), WAIT);
      await harness.store.workspaces.records.patch("acme", { mattermostTeamId: "team-2" });
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:gamma", "modified:acme"]), WAIT);
      await harness.store.workspaces.records.delete("gamma");
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:gamma", "modified:acme", "removed:gamma"]), WAIT);
      await harness.store.workspaces.records.patch("acme", { ownerUid: "u2" });
      await harness.store.workspaces.records.patch("beta", { ownerUid: "u1" });
      await vi.waitFor(
        () => expect(changeLog(listener)).toEqual(["added:gamma", "modified:acme", "removed:gamma", "removed:acme", "added:beta"]),
        WAIT,
      );

      expect(changesOf(listener)[1].record).toMatchObject({ slug: "acme", mattermostTeamId: "team-2" });
      expect(listener.errors).toEqual([]);
    });

    it("watches one uid's memberships, including removal by a workspace delete", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.records.put(workspace("beta", "u2"));
      await harness.store.workspaces.members.put(member("acme", "u1", { role: "owner" }));
      await harness.store.workspaces.members.put(member("acme", "u2"));
      const listener = await watch({ aggregate: "workspaceMembers", filter: { uid: "u1" } });
      expect(snapshotOf(listener)?.map((record) => `${record.workspaceSlug}/${record.uid}`)).toEqual(["acme/u1"]);

      await harness.store.workspaces.members.put(member("beta", "u1"));
      await harness.store.workspaces.members.put(member("beta", "u3"));
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:beta/u1"]), WAIT);
      await harness.store.workspaces.members.put(member("acme", "u1", { role: "owner", joinedAt: null, mattermostUserId: "mm-u1" }));
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:beta/u1", "modified:acme/u1"]), WAIT);
      await harness.store.workspaces.members.delete("beta", "u1");
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:beta/u1", "modified:acme/u1", "removed:beta/u1"]), WAIT);
      await harness.store.workspaces.records.delete("acme");
      await vi.waitFor(
        () => expect(changeLog(listener)).toEqual(["added:beta/u1", "modified:acme/u1", "removed:beta/u1", "removed:acme/u1"]),
        WAIT,
      );

      expect(changesOf(listener)[1].record).toMatchObject({ mattermostUserId: "mm-u1", joinedAt: NOW });
      expect(listener.errors).toEqual([]);
    });

    it("follows a single membership from absent through added and removed", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      const listener = await watch({ aggregate: "workspaceMembers", filter: { workspaceSlug: "acme", uid: "u1" } });
      expect(snapshotOf(listener)).toEqual([]);

      await harness.store.workspaces.members.put(member("acme", "u2"));
      await harness.store.workspaces.members.put(member("acme", "u1"));
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:acme/u1"]), WAIT);
      await harness.store.workspaces.members.delete("acme", "u1");
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:acme/u1", "removed:acme/u1"]), WAIT);
    });

    it("watches one workspace's projects", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.records.put(workspace("beta", "u1"));
      await harness.store.workspaces.projects.put(project("acme", "site"));
      await harness.store.workspaces.projects.put(project("beta", "docs"));
      const listener = await watch({ aggregate: "workspaceProjects", filter: { workspaceSlug: "acme" } });
      expect(snapshotOf(listener)?.map((record) => record.projectSlug)).toEqual(["site"]);

      await harness.store.workspaces.projects.put(project("beta", "api"));
      await harness.store.workspaces.projects.put(project("acme", "app"));
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:acme/app"]), WAIT);
      await harness.store.workspaces.projects.patch("acme", "site", { status: "paused" });
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:acme/app", "modified:acme/site"]), WAIT);
      await harness.store.workspaces.projects.delete("acme", "app");
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:acme/app", "modified:acme/site", "removed:acme/app"]), WAIT);

      expect(changesOf(listener)[1].record).toMatchObject({ projectSlug: "site", status: "paused" });
      expect(listener.errors).toEqual([]);
    });

    it("watches one workspace's channels at both scopes under scoped keys and ignores a workspace whose slug extends it", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.records.put(workspace("acme-x", "u1"));
      await harness.store.workspaces.channels.put(channel("acme", null, "general"));
      await harness.store.workspaces.channels.put(channel("acme", "site", "c1"));
      await harness.store.workspaces.channels.put(channel("acme-x", null, "general"));
      const listener = await watch({ aggregate: "workspaceChannels", filter: { workspaceSlug: "acme" } });
      expect(snapshotOf(listener)?.map(channelLabel)).toEqual(["acme/-/general", "acme/site/c1"]);

      await harness.store.workspaces.channels.put(channel("acme-x", "site", "c2"));
      await harness.store.workspaces.channels.put(channel("acme", null, "coach-dm"));
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:acme/coach-dm"]), WAIT);
      await harness.store.workspaces.channels.patch({ workspaceSlug: "acme", projectSlug: "site" }, "c1", { archivedAt: NOW });
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:acme/coach-dm", "modified:acme/site/c1"]), WAIT);
      await harness.store.workspaces.channels.delete({ workspaceSlug: "acme", projectSlug: null }, "general");
      await vi.waitFor(
        () => expect(changeLog(listener)).toEqual(["added:acme/coach-dm", "modified:acme/site/c1", "removed:acme/general"]),
        WAIT,
      );

      expect(changesOf(listener)[1].record).toMatchObject({ scope: { workspaceSlug: "acme", projectSlug: "site" }, archivedAt: NOW });
      expect(listener.errors).toEqual([]);
    });

    it("watches every workspace's channels", async () => {
      await harness.store.workspaces.records.put(workspace("acme", "u1"));
      await harness.store.workspaces.records.put(workspace("beta", "u1"));
      await harness.store.workspaces.channels.put(channel("acme", null, "general"));
      const listener = await watch({ aggregate: "workspaceChannels", filter: {} });
      expect(snapshotOf(listener)?.map(channelLabel)).toEqual(["acme/-/general"]);

      await harness.store.workspaces.channels.put(channel("beta", "docs", "c9"));
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:beta/docs/c9"]), WAIT);
    });

    it("follows one Builder's agent identity", async () => {
      const listener = await watch({ aggregate: "agentIdentities", filter: { uid: "u1" } });
      expect(snapshotOf(listener)).toEqual([]);

      await harness.store.workspaces.agentIdentities.put({ uid: "u2", mattermostUserId: "mm-other", at: NOW });
      await harness.store.workspaces.agentIdentities.put({ uid: "u1", mattermostUserId: "mm-1", at: NOW });
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:u1"]), WAIT);
      await harness.store.workspaces.agentIdentities.put({ uid: "u1", mattermostUserId: "mm-2", at: NOW + 1 });
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:u1", "modified:u1"]), WAIT);
      await harness.store.workspaces.agentIdentities.delete("u1");
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:u1", "modified:u1", "removed:u1"]), WAIT);

      expect(changesOf(listener)[1].record).toMatchObject({ uid: "u1", mattermostUserId: "mm-2" });
    });

    it("watches every agent identity", async () => {
      await harness.store.workspaces.agentIdentities.put({ uid: "u1", mattermostUserId: "mm-1", at: NOW });
      const listener = await watch({ aggregate: "agentIdentities", filter: {} });
      expect(snapshotOf(listener)?.map((record) => record.uid)).toEqual(["u1"]);

      await harness.store.workspaces.agentIdentities.put({ uid: "u2", mattermostUserId: "mm-2", at: NOW });
      await vi.waitFor(() => expect(changeLog(listener)).toEqual(["added:u2"]), WAIT);
    });
  });
});
