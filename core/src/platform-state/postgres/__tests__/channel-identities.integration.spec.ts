import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED_CHANNEL_INSTALLATION, type ChannelInstallation } from "../../channel-identities.js";
import { DuplicateRecordError } from "../../errors.js";
import { createHarness, dsn, recordingListener, type PlatformStateHarness, type RecordingListener } from "./fixtures/harness.js";

const NOW = 1_700_000_000_000;
const WAIT = { timeout: 20_000, interval: 20 };
const SLACK_ONE: ChannelInstallation = { provider: "slack", installation: "T-one" };
const SLACK_TWO: ChannelInstallation = { provider: "slack", installation: "T-two" };

function changedUserIds(listener: RecordingListener<"builders">): (string | null | undefined)[] {
  return listener.events.flatMap((event) => (event.kind === "changes" ? event.changes.map((change) => change.record?.mattermostUserId) : []));
}

describe.skipIf(!dsn)("channel identities", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function identity(owner: string, externalUserId: string, installation: ChannelInstallation = SLACK_ONE, ownerKind: "user" | "agent" = "user") {
    return { ...installation, externalUserId, ownerKind, ownerId: owner };
  }

  it("lets one owner hold identities on several providers and installations", async () => {
    const { channelIdentities } = harness.store;
    await channelIdentities.link(identity("owner-1", "U1", SLACK_ONE));
    await channelIdentities.link(identity("owner-1", "U2", SLACK_TWO));
    await channelIdentities.link(identity("owner-1", "mm-1", MANAGED_CHANNEL_INSTALLATION));

    const held = await channelIdentities.listForOwner("owner-1");

    expect(held.map((row) => [row.provider, row.installation, row.externalUserId])).toEqual([
      ["managed", "default", "mm-1"],
      ["slack", "T-one", "U1"],
      ["slack", "T-two", "U2"],
    ]);
  });

  it("keeps identical external IDs in different installations apart", async () => {
    const { channelIdentities } = harness.store;
    await channelIdentities.link(identity("owner-1", "U-same", SLACK_ONE));
    await channelIdentities.link(identity("owner-2", "U-same", SLACK_TWO));

    expect((await channelIdentities.find(SLACK_ONE, "U-same"))?.ownerId).toBe("owner-1");
    expect((await channelIdentities.find(SLACK_TWO, "U-same"))?.ownerId).toBe("owner-2");
  });

  it("refuses an external ID another owner already holds on that installation", async () => {
    const { channelIdentities } = harness.store;
    await channelIdentities.link(identity("owner-1", "U-taken"));

    await expect(channelIdentities.link(identity("owner-2", "U-taken"))).rejects.toMatchObject({
      constructor: DuplicateRecordError, aggregate: "channel-identity", value: "U-taken", keysFound: ["owner-1"],
    });
    expect((await channelIdentities.find(SLACK_ONE, "U-taken"))?.ownerId).toBe("owner-1");
  });

  it("moves an owner to a new account on the same installation", async () => {
    const { channelIdentities } = harness.store;
    await channelIdentities.link(identity("owner-1", "U-old"));
    await channelIdentities.link(identity("owner-1", "U-new"));

    expect(await channelIdentities.find(SLACK_ONE, "U-old")).toBeNull();
    expect((await channelIdentities.find(SLACK_ONE, "U-new"))?.ownerId).toBe("owner-1");
  });

  it("keeps a person's and their agent's accounts on one installation side by side", async () => {
    const { channelIdentities } = harness.store;
    await channelIdentities.link(identity("owner-1", "U-person", SLACK_ONE, "user"));
    await channelIdentities.link(identity("owner-1", "U-bot", SLACK_ONE, "agent"));

    expect((await channelIdentities.listForOwner("owner-1")).map((row) => row.ownerKind).sort()).toEqual(["agent", "user"]);
  });

  it("unlinks one identity and leaves the owner's others", async () => {
    const { channelIdentities } = harness.store;
    await channelIdentities.link(identity("owner-1", "U1", SLACK_ONE));
    await channelIdentities.link(identity("owner-1", "U2", SLACK_TWO));

    await channelIdentities.unlink(SLACK_ONE, "U1");

    expect((await channelIdentities.listForOwner("owner-1")).map((row) => row.externalUserId)).toEqual(["U2"]);
  });

  describe("the managed installation behind the record fields", () => {
    it("stores a builder's user ID as an identity and resolves it back", async () => {
      const { builders, channelIdentities } = harness.store;
      await builders.records.create({ uid: "alice", createdAt: NOW });

      await builders.records.patch("alice", { mattermostUserId: "mm-alice" });

      expect((await builders.records.get("alice"))?.mattermostUserId).toBe("mm-alice");
      expect((await builders.records.findByMattermostUserId("mm-alice"))?.uid).toBe("alice");
      expect(await channelIdentities.find(MANAGED_CHANNEL_INSTALLATION, "mm-alice")).toMatchObject({ ownerKind: "user", ownerId: "alice" });
    });

    it("bumps the builder's revision when only the user ID changes", async () => {
      const { builders } = harness.store;
      await builders.records.create({ uid: "alice", createdAt: NOW });
      const before = (await builders.records.get("alice"))?.revision;

      await builders.records.patch("alice", { mattermostUserId: "mm-alice" });

      expect((await builders.records.get("alice"))?.revision).not.toBe(before);
    });

    it("changes the builder's revision and tells its watchers when the identity changes through the repository", async () => {
      const { builders, channelIdentities } = harness.store;
      await builders.records.create({ uid: "alice", createdAt: NOW });
      const created = (await builders.records.get("alice"))?.revision;
      const listener = recordingListener<"builders">();
      harness.store.watch({ aggregate: "builders", filter: { uid: "alice" } }, listener);
      await vi.waitFor(() => expect(listener.events.some((event) => event.kind === "snapshot")).toBe(true), WAIT);

      await channelIdentities.link(identity("alice", "mm-alice", MANAGED_CHANNEL_INSTALLATION));

      const linked = await builders.records.get("alice");
      expect(linked).toMatchObject({ mattermostUserId: "mm-alice" });
      expect(linked?.revision).not.toBe(created);
      await vi.waitFor(() => expect(changedUserIds(listener)).toEqual(["mm-alice"]), WAIT);

      await channelIdentities.unlink(MANAGED_CHANNEL_INSTALLATION, "mm-alice");

      const unlinked = await builders.records.get("alice");
      expect(unlinked).toMatchObject({ mattermostUserId: null });
      expect(unlinked?.revision).not.toBe(linked?.revision);
      await vi.waitFor(() => expect(changedUserIds(listener)).toEqual(["mm-alice", null]), WAIT);
    });

    it("changes the agent identity's revision when its managed account changes through the repository", async () => {
      const { workspaces, channelIdentities } = harness.store;
      await workspaces.agentIdentities.put({ uid: "alice", mattermostUserId: null, at: NOW });
      const before = (await workspaces.agentIdentities.get("alice"))?.revision;

      await channelIdentities.link(identity("alice", "mm-coach", MANAGED_CHANNEL_INSTALLATION, "agent"));

      const after = await workspaces.agentIdentities.get("alice");
      expect(after).toMatchObject({ mattermostUserId: "mm-coach" });
      expect(after?.revision).not.toBe(before);
    });

    it("leaves the builder alone when an identity on another installation changes", async () => {
      const { builders, channelIdentities } = harness.store;
      await builders.records.create({ uid: "alice", createdAt: NOW });
      const before = (await builders.records.get("alice"))?.revision;

      await channelIdentities.link(identity("alice", "U-alice", SLACK_ONE));

      expect((await builders.records.get("alice"))?.revision).toBe(before);
    });

    it("rolls back the rest of a patch when the user ID is taken", async () => {
      const { builders } = harness.store;
      await builders.records.create({ uid: "alice", createdAt: NOW });
      await builders.records.create({ uid: "eve", createdAt: NOW });
      await builders.records.patch("alice", { mattermostUserId: "mm-alice" });

      await expect(builders.records.patch("eve", { slug: "eve", mattermostUserId: "mm-alice" })).rejects.toBeInstanceOf(DuplicateRecordError);

      expect((await builders.records.get("eve"))?.slug).toBeNull();
    });

    it("never resolves an agent's account to a builder", async () => {
      const { builders, workspaces } = harness.store;
      await builders.records.create({ uid: "alice", createdAt: NOW });
      await workspaces.agentIdentities.put({ uid: "alice", mattermostUserId: "mm-coach", at: NOW });

      expect(await builders.records.findByMattermostUserId("mm-coach")).toBeNull();
      expect((await builders.records.get("alice"))?.mattermostUserId).toBeNull();
      expect((await workspaces.agentIdentities.get("alice"))?.mattermostUserId).toBe("mm-coach");
    });

    it("forgets a builder's identities with the builder and keeps their agent's", async () => {
      const { builders, workspaces, channelIdentities } = harness.store;
      await builders.records.create({ uid: "alice", createdAt: NOW });
      await builders.records.patch("alice", { mattermostUserId: "mm-alice" });
      await channelIdentities.link(identity("alice", "U-alice", SLACK_ONE));
      await workspaces.agentIdentities.put({ uid: "alice", mattermostUserId: "mm-coach", at: NOW });

      await builders.records.delete("alice");

      expect((await channelIdentities.listForOwner("alice")).map((row) => row.externalUserId)).toEqual(["mm-coach"]);
    });

    it("forgets an agent's identity with the agent", async () => {
      const { workspaces, channelIdentities } = harness.store;
      await workspaces.agentIdentities.put({ uid: "alice", mattermostUserId: "mm-coach", at: NOW });

      await workspaces.agentIdentities.delete("alice");

      expect(await channelIdentities.find(MANAGED_CHANNEL_INSTALLATION, "mm-coach")).toBeNull();
    });
  });

  describe("workspace references", () => {
    function workspace(slug: string, fields: Record<string, unknown> = {}) {
      return {
        slug, id: `id-${slug}`, ownerUid: "owner-1", ownerActive: true, mattermostTeamId: null,
        giteaOrgName: null, giteaRepoName: null, createdAt: NOW, updatedAt: NOW, ...fields,
      };
    }
    function channel(workspaceSlug: string, externalChannelId: string, installation: ChannelInstallation) {
      return {
        scope: { workspaceSlug, projectSlug: null }, channelId: "general", kind: "general",
        mattermostChannelId: externalChannelId, channelProvider: installation.provider, channelInstallation: installation.installation,
        archivedAt: null, createdBy: null, createdAt: NOW,
      };
    }

    it("resolves the same external channel ID per installation", async () => {
      const { workspaces } = harness.store;
      await workspaces.records.put(workspace("one"));
      await workspaces.records.put(workspace("two"));
      await workspaces.channels.put(channel("one", "C-same", SLACK_ONE));
      await workspaces.channels.put(channel("two", "C-same", SLACK_TWO));

      expect((await workspaces.channels.findByHostChannelId(SLACK_ONE, "C-same"))?.scope.workspaceSlug).toBe("one");
      expect((await workspaces.channels.findByHostChannelId(SLACK_TWO, "C-same"))?.scope.workspaceSlug).toBe("two");
      expect(await workspaces.channels.findByMattermostChannelId("C-same")).toBeNull();
    });

    it("refuses one external channel ID twice on an installation", async () => {
      const { workspaces } = harness.store;
      await workspaces.records.put(workspace("one"));
      await workspaces.records.put(workspace("two"));
      await workspaces.channels.put(channel("one", "C-taken", SLACK_ONE));

      await expect(workspaces.channels.put(channel("two", "C-taken", SLACK_ONE))).rejects.toBeInstanceOf(DuplicateRecordError);
    });

    it("resolves the same external team ID per installation", async () => {
      const { workspaces } = harness.store;
      await workspaces.records.put(workspace("one", { mattermostTeamId: "T-same", channelProvider: SLACK_ONE.provider, channelInstallation: SLACK_ONE.installation }));
      await workspaces.records.put(workspace("two", { mattermostTeamId: "T-same" }));

      expect((await workspaces.records.findByChannelTeamId(SLACK_ONE, "T-same"))?.slug).toBe("one");
      expect((await workspaces.records.findByMattermostTeamId("T-same"))?.slug).toBe("two");
    });

    it("carries the git host beside the owner and repository and defaults to the managed host", async () => {
      const { workspaces } = harness.store;
      await workspaces.records.put(workspace("connected", { giteaOrgName: "acme", giteaRepoName: "site", gitHost: "github.com" }));
      await workspaces.records.put(workspace("managed", { giteaOrgName: "acme", giteaRepoName: "site" }));

      expect(await workspaces.records.get("connected")).toMatchObject({ gitHost: "github.com", giteaOrgName: "acme" });
      expect(await workspaces.records.get("managed")).toMatchObject({ gitHost: "managed", giteaOrgName: "acme" });
    });
  });
});
