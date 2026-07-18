import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  uid: "caller-uid",
  liveUserId: "a".repeat(26),
  postUserId: "a".repeat(26),
  postError: null as Error | null,
  membershipError: null as Error | null,
  docs: new Map<string, Record<string, unknown>>(),
  channelPath: "workspaces/alice/channels/coach-dm",
  channelCount: 1,
  posts: [] as Array<{ segments: readonly string[]; body: unknown }>,
  auditSets: [] as Record<string, unknown>[],
  auditUpdates: [] as Record<string, unknown>[],
  logs: [] as Array<{ message: string; context: Record<string, unknown> }>,
  threadPosts: {} as Record<string, unknown>,
}));

function snap(path: string) {
  return { exists: h.docs.has(path), data: () => h.docs.get(path) };
}

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: { uid?: string }, _res: unknown, next: () => void) => { req.uid = h.uid; next(); },
}));
vi.mock("../middleware/security.js", () => ({ strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../middleware/logging.js", () => ({
  logger: { error: (message: string, context: Record<string, unknown>) => h.logs.push({ message, context }) },
}));
vi.mock("../lib/workspace-resolution.js", () => ({ resolveWorkspaceUid: async () => "owner-uid" }));
vi.mock("../lib/db.js", () => ({
  db: {
    collectionGroup: () => ({ where: () => ({ get: async () => ({ docs: Array.from({ length: h.channelCount }, () => ({ ref: { path: h.channelPath }, data: () => ({ mattermost: { channelId: "c".repeat(26) } }) })) }) }) }),
    doc: (path: string) => ({ get: async () => snap(path) }),
    collection: () => ({ doc: () => ({ id: "audit-1", set: async (data: Record<string, unknown>) => h.auditSets.push(data), update: async (data: Record<string, unknown>) => h.auditUpdates.push(data) }) }),
  },
  FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" },
}));
vi.mock("../lib/channel-session-model-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/channel-session-model-control.js")>();
  return {
    ...actual,
    createChannelSessionMattermostClient: () => ({
      getCurrentUserId: async () => h.liveUserId,
      getJson: async (segments: readonly string[]) => {
        if (segments[0] === "channels" && segments[2] === "members") {
          if (h.membershipError) throw h.membershipError;
          return { channel_id: segments[1], user_id: segments[3] };
        }
        return { posts: h.threadPosts };
      },
      postJson: async (segments: readonly string[], body: unknown) => {
        if (h.postError) throw h.postError;
        h.posts.push({ segments, body });
        return { id: "p".repeat(26), root_id: "", channel_id: "c".repeat(26), user_id: h.postUserId, create_at: 100, message: (body as { message: string }).message };
      },
    }),
  };
});

const { ChannelSessionMattermostError } = await import("../lib/channel-session-model-control.js");
const { default: routes } = await import("../routes/channel-session-models.js");

function app() {
  const value = express();
  value.use(express.json());
  value.use("/api/channel-session-models", routes);
  value.use((error: Error, _req: unknown, res: express.Response, _next: unknown) => res.status(500).json({ error: error.message }));
  return value;
}

beforeEach(() => {
  h.liveUserId = "a".repeat(26);
  h.postUserId = "a".repeat(26);
  h.postError = null;
  h.membershipError = null;
  h.channelPath = "workspaces/alice/channels/coach-dm";
  h.channelCount = 1;
  h.posts.length = 0;
  h.auditSets.length = 0;
  h.auditUpdates.length = 0;
  h.logs.length = 0;
  h.threadPosts = {
    ["r".repeat(26)]: { id: "r".repeat(26), root_id: "p".repeat(26), channel_id: "c".repeat(26), user_id: "g".repeat(26), create_at: 101, message: "Model set to platform-openrouter/z-ai/glm-5.2 for this session." },
  };
  h.docs = new Map([
    ["users/caller-uid", { mattermost: { userId: "a".repeat(26) } }],
    ["users/caller-uid/secrets/mattermost", { personalToken: "t".repeat(32) }],
    ["users/owner-uid/secrets/coachMattermost", { coachMmUserId: "g".repeat(26) }],
    ["users/owner-uid/system/config", { agentModels: { "octogee-alice-coach": { primary: "openai/gpt-5", fallbacks: [] } } }],
  ]);
});

describe("channel session model routes", () => {
  it("returns the bound Agent default only after proving live PAT identity and exact membership", async () => {
    const response = await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(200);
    expect(response.body).toMatchObject({ agentId: "octogee-alice-coach", defaultModel: { primary: "openai/gpt-5" } });
  });

  it("rejects a stored Mattermost identity that does not match the PAT", async () => {
    h.liveUserId = "z".repeat(26);
    await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(403);
  });

  it("maps missing exact-channel membership to 403", async () => {
    h.membershipError = new ChannelSessionMattermostError("Mattermost HTTP 404", 404);
    await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(403);
  });

  it("audits before posting the exact native command and returns parsed native choices", async () => {
    const response = await request(app()).post(`/api/channel-session-models/${"c".repeat(26)}`).send({ operation: "setSessionModel", agentId: "octogee-alice-coach", modelRef: "platform-openrouter/z-ai/glm-5.2" }).expect(200);
    expect(h.auditSets).toHaveLength(1);
    expect(h.posts).toEqual([{ segments: ["posts"], body: { channel_id: "c".repeat(26), message: "/model platform-openrouter/z-ai/glm-5.2" } }]);
    expect(response.body).toMatchObject({ outcome: "applied", currentModel: "platform-openrouter/z-ai/glm-5.2" });
    expect(h.auditUpdates).toHaveLength(1);
  });

  it("uses a project Agent only when enabled with a complete minted credential", async () => {
    h.channelPath = "workspaces/alice/projects/orbit/channels/general";
    h.docs.set("workspaces/alice/projects/orbit", { agent: { enabled: true } });
    h.docs.set("users/owner-uid/secrets/projectAgentMattermost-orbit", { mmUserId: "q".repeat(26) });
    const coach = await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(200);
    expect(coach.body.agentId).toBe("octogee-alice-coach");
    h.docs.set("users/owner-uid/secrets/projectAgentMattermost-orbit", { mmUserId: "q".repeat(26), personalToken: "u".repeat(32) });
    const project = await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(200);
    expect(project.body.agentId).toBe("octogee-alice-proj-orbit-coach");
  });

  it("fails closed on duplicate channel bindings and stale Agent preconditions", async () => {
    h.channelCount = 2;
    await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(404);
    h.channelCount = 1;
    await request(app()).post(`/api/channel-session-models/${"c".repeat(26)}`).send({
      operation: "resetSessionModel",
      agentId: "octogee-bob-coach",
    }).expect(409);
    expect(h.posts).toHaveLength(0);
  });

  it("rejects command injection before Mattermost or audit writes", async () => {
    await request(app()).post(`/api/channel-session-models/${"c".repeat(26)}`).send({
      operation: "setSessionModel",
      agentId: "octogee-alice-coach",
      modelRef: "openai/gpt-5\n/stop",
    }).expect(400);
    expect(h.posts).toHaveLength(0);
    expect(h.auditSets).toHaveLength(0);
  });

  it("rejects a command post not authored by the proven caller identity", async () => {
    h.postUserId = "x".repeat(26);
    await request(app()).post(`/api/channel-session-models/${"c".repeat(26)}`).send({
      operation: "resetSessionModel",
      agentId: "octogee-alice-coach",
    }).expect(502);
  });

  it("finishes and correlates the audit when native command dispatch fails", async () => {
    h.postError = new ChannelSessionMattermostError("Mattermost HTTP 503", 503);
    await request(app()).post(`/api/channel-session-models/${"c".repeat(26)}`).send({
      operation: "resetSessionModel",
      agentId: "octogee-alice-coach",
    }).expect(502);
    expect(h.auditSets).toHaveLength(1);
    expect(h.auditUpdates).toContainEqual({ outcome: "failed", completedAt: "SERVER_TIMESTAMP" });
    expect(h.logs).toContainEqual({
      message: "channel session model command failed",
      context: expect.objectContaining({ auditId: "audit-1", channelId: "c".repeat(26), operation: "resetSessionModel" }),
    });
  });
});
