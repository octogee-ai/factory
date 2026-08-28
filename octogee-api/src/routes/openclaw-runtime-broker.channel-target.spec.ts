import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const assignedSlugs = vi.hoisted(() => vi.fn());

vi.mock("@octogee/core/assigned-roster", () => ({
  readAssignedSlugsForGateway: (...args: unknown[]) => assignedSlugs(...args),
}));

import { createOpenClawRuntimeBrokerRoutes } from "./openclaw-runtime-broker.js";

type ChannelDoc = { path: string; channelId: string };

let channels: ChannelDoc[] = [];

const db = {
  collectionGroup: () => {
    let channelId = "";
    const query = {
      where: (_field: string, _operator: string, value: unknown) => {
        channelId = typeof value === "string" ? value : "";
        return query;
      },
      limit: () => query,
      get: async () => ({
        docs: channels
          .filter((channel) => channel.channelId === channelId)
          .map((channel) => ({ ref: { path: channel.path }, data: () => ({}) })),
      }),
    };
    return query;
  },
} as never;

function app() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: "gw-alice", ownerUid: "uid-alice" };
    next();
  });
  app.use("/internal/openclaw", createOpenClawRuntimeBrokerRoutes({ db }));
  return app;
}

beforeEach(() => {
  channels = [{ path: "workspaces/alice/channels/coach-dm", channelId: "primary" }];
  assignedSlugs.mockReset().mockResolvedValue(["alice"]);
});

describe("activity channel target", () => {
  it("returns the primary as the activity target without a stored sibling", async () => {
    const response = await request(app())
      .post("/internal/openclaw/activity/channel-target")
      .send({ primaryChannelId: "primary" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      target: {
        primaryChannelId: "primary",
        activityChannelId: "primary",
        channelDocPath: "workspaces/alice/channels/coach-dm",
      },
    });
  });

  it("does not expose the removed channel-pair route", async () => {
    const response = await request(app())
      .post("/internal/openclaw/activity/channel-pair")
      .send({ primaryChannelId: "primary" });

    expect(response.status).toBe(404);
  });

  it("does not resolve a legacy sibling as a primary target", async () => {
    const response = await request(app())
      .post("/internal/openclaw/activity/channel-target")
      .send({ primaryChannelId: "legacy-sibling" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
  });
});
