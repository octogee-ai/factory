import { beforeEach, describe, expect, it, vi } from "vitest";

const channelId = "c".repeat(26);

const h = vi.hoisted(() => ({
  activeProjectReads: 0,
  maxActiveProjectReads: 0,
  projectReadsStarted: 0,
  holdProjectReads: false,
  releaseProjectReads: (() => undefined) as () => void,
  projectReadGate: Promise.resolve() as Promise<void>,
  projects: [] as Array<{ id: string; archived?: boolean }>,
  projectChannelCounts: new Map<string, number>(),
  documents: new Map<string, Record<string, unknown>>(),
  channelLedger: {
    id: "general",
    path: "workspaces/alice/channels/general",
    data: { kind: "general", mattermost: { channelId: "c".repeat(26) } },
  },
  createClientCalls: 0,
  channelLookupLimit: 0,
}));

function resetProjectGate(): void {
  h.projectReadGate = new Promise<void>((resolve) => {
    h.releaseProjectReads = () => {
      h.holdProjectReads = false;
      resolve();
    };
  });
}

function query(docs: unknown[]) {
  return {
    limit: () => ({ get: async () => ({ docs }) }),
  };
}

vi.mock("../lib/workspace-resolution.js", () => ({
  resolveWorkspaceUid: async () => "owner-uid",
}));

vi.mock("../lib/channel-session-model-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/channel-session-model-control.js")>();
  return {
    ...actual,
    createChannelSessionMattermostClient: () => {
      h.createClientCalls += 1;
      return {
        getCurrentUserId: async () => "u".repeat(26),
        getJson: async () => ({}),
      };
    },
  };
});

vi.mock("../lib/db.js", () => ({
  db: {
    collectionGroup: () => ({
      where: () => ({
        limit: (value: number) => {
          h.channelLookupLimit = value;
          return {
            get: async () => ({
              docs: [{
                id: h.channelLedger.id,
                ref: { path: h.channelLedger.path },
                data: () => h.channelLedger.data,
              }],
            }),
          };
        },
      }),
    }),
    doc: (path: string) => {
      if (path === "workspaces/alice") {
        return {
          collection: (name: string) => name === "channels"
            ? query([])
            : query(h.projects.map(({ id, archived }) => ({
              id,
              data: () => archived
                ? { commercialLifecycle: { status: "archived" } }
                : {},
              ref: {
                collection: () => ({
                  limit: () => ({
                    get: async () => {
                      h.activeProjectReads += 1;
                      h.projectReadsStarted += 1;
                      h.maxActiveProjectReads = Math.max(
                        h.maxActiveProjectReads,
                        h.activeProjectReads,
                      );
                      if (h.holdProjectReads) await h.projectReadGate;
                      h.activeProjectReads -= 1;
                      return {
                        docs: Array.from(
                          { length: h.projectChannelCounts.get(id) ?? 0 },
                          () => ({}),
                        ),
                      };
                    },
                  }),
                }),
              },
            }))),
        };
      }
      return { get: async () => ({ data: () => h.documents.get(path) }) };
    },
  },
}));

const {
  authorizeChannel,
  listWorkspaceChannelCandidates,
} = await import("../lib/channel-session-authorization.js");

beforeEach(() => {
  h.activeProjectReads = 0;
  h.maxActiveProjectReads = 0;
  h.projectReadsStarted = 0;
  h.holdProjectReads = false;
  h.projects = [];
  h.projectChannelCounts.clear();
  h.documents = new Map([
    ["users/caller", { mattermost: { userId: "u".repeat(26) } }],
    ["users/caller/secrets/mattermost", { personalToken: "t".repeat(32) }],
    ["users/owner-uid/secrets/coachMattermost", { coachMmUserId: "a".repeat(26) }],
  ]);
  h.channelLedger = {
    id: "general",
    path: "workspaces/alice/channels/general",
    data: { kind: "general", mattermost: { channelId } },
  };
  h.createClientCalls = 0;
  h.channelLookupLimit = 0;
  resetProjectGate();
});

describe("channel session authorization discovery", () => {
  it("bounds project channel ledger reads and stops launching work after cancellation", async () => {
    h.projects = Array.from({ length: 24 }, (_, index) => ({ id: `project-${index}` }));
    h.holdProjectReads = true;
    const controller = new AbortController();
    const discovery = listWorkspaceChannelCandidates("alice", controller.signal);

    await vi.waitFor(() => expect(h.projectReadsStarted).toBe(8));
    expect(h.maxActiveProjectReads).toBe(8);

    controller.abort(new Error("RPC deadline expired"));
    await expect(discovery).rejects.toThrow("RPC deadline expired");
    expect(h.projectReadsStarted).toBe(8);
    h.releaseProjectReads();
  });

  it("rejects an archived ledger binding when active discovery is required", async () => {
    h.channelLedger = {
      ...h.channelLedger,
      data: {
        kind: "general",
        archivedAt: 100,
        mattermost: { channelId },
      },
    };

    await expect(authorizeChannel(
      "caller",
      channelId,
      "alice",
      { requireActiveLedger: true },
    )).resolves.toBeNull();
    expect(h.createClientCalls).toBe(0);
    expect(h.channelLookupLimit).toBe(2);
  });

  it("rejects reserved and malformed ledger bindings when active discovery is required", async () => {
    h.channelLedger = {
      id: "coach-dm",
      path: "workspaces/alice/channels/coach-dm",
      data: { kind: "session", mattermost: { channelId } },
    };
    await expect(authorizeChannel(
      "caller",
      channelId,
      "alice",
      { requireActiveLedger: true },
    )).resolves.toBeNull();

    h.channelLedger = {
      id: "general",
      path: "workspaces/alice/channels/general",
      data: { kind: "session", mattermost: { channelId } },
    };
    await expect(authorizeChannel(
      "caller",
      channelId,
      "alice",
      { requireActiveLedger: true },
    )).rejects.toThrow("Workspace channel ledger was invalid");
    expect(h.createClientCalls).toBe(0);
  });

  it("stops reading later project ledgers as soon as the global channel bound is exceeded", async () => {
    h.projects = Array.from({ length: 24 }, (_, index) => ({ id: `project-${index}` }));
    h.projectChannelCounts.set("project-0", 513);

    await expect(listWorkspaceChannelCandidates("alice")).rejects.toThrow(
      "Workspace channel directory exceeded its limit",
    );
    expect(h.projectReadsStarted).toBe(8);
  });

  it("rejects an archived parent project for an otherwise active channel binding", async () => {
    h.channelLedger = {
      id: "general",
      path: "workspaces/alice/projects/orbit/channels/general",
      data: { kind: "general", mattermost: { channelId } },
    };
    h.documents.set("workspaces/alice/projects/orbit", {
      commercialLifecycle: { status: "archived" },
      agent: { mode: "scoped", enabled: true },
    });
    h.documents.set("users/owner-uid/secrets/projectAgentMattermost-orbit", {
      mmUserId: "a".repeat(26),
      personalToken: "t".repeat(32),
    });

    await expect(authorizeChannel(
      "caller",
      channelId,
      "alice",
      { requireActiveLedger: true },
    )).resolves.toBeNull();
    expect(h.createClientCalls).toBe(0);
  });
});


describe("workspace conversation channel authority", () => {
  it.each([["general", "general"], ["coach-dm", "coach-dm"], ["planning", "session"]])("accepts workspace %s with its exact channel identity", async (id, kind) => {
    h.channelLedger = { id, path: `workspaces/alice/channels/${id}`, data: { kind, mattermost: { channelId } } };
    await expect(authorizeChannel("caller", channelId, "alice", { workspaceConversation: true })).resolves.toMatchObject({ target: { workspaceSlug: "alice", agentId: "octogee-alice-coach" } });
  });
  it.each([
    ["admin", "workspaces/alice/channels/admin", "admin"],
    ["general", "workspaces/alice/projects/project/channels/general", "general"],
    ["general", "community/channels/general", "general"],
    ["coach-dm", "workspaces/alice/channels/coach-dm", "session"],
  ])("rejects unrelated or malformed workspace conversations %s %s", async (id, path, kind) => {
    h.channelLedger = { id, path, data: { kind, mattermost: { channelId } } };
    await expect(authorizeChannel("caller", channelId, "alice", { workspaceConversation: true })).resolves.toBeNull();
    expect(h.createClientCalls).toBe(0);
  });
  it("rejects archived workspace conversation ledgers", async () => {
    Object.assign(h.channelLedger.data, { archivedAt: 100 });
    await expect(authorizeChannel("caller", channelId, "alice", { workspaceConversation: true })).resolves.toBeNull();
  });
});
