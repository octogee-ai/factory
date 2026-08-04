import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, it } from "vitest";

import { FeaturePolicy } from "../lib/feature-policy.js";
import { createFeatureRoutes } from "./features.js";

const auth: RequestHandler = (req, _res, next) => {
  req.uid = "uid-alice";
  req.user = { selectedTier: "personal" };
  next();
};

describe("GET /api/features", () => {
  it("returns only the registered user-visible snapshot", async () => {
    const api = express();
    api.use("/api/features", createFeatureRoutes({
      auth,
      featurePolicy: new FeaturePolicy({
        evaluate: async () => ({
          isEnabled: (key) => key === "release-agent-import",
        }),
      }),
    }));

    await request(api).get("/api/features").expect(200, {
      flags: {
        "release-openclaw-dashboard": false,
        "release-agent-import": true,
        "release-agent-export": false,
        "release-builder-gateway": false,
        "release-obsidian-connection": false,
      },
    });
  });

  it("fails closed when the provider cannot evaluate the snapshot", async () => {
    const api = express();
    api.use("/api/features", createFeatureRoutes({
      auth,
      featurePolicy: new FeaturePolicy({
        evaluate: async () => { throw new Error("provider unavailable"); },
      }),
    }));

    await request(api).get("/api/features")
      .expect(503, { error: "feature_evaluation_unavailable" });
  });
});
