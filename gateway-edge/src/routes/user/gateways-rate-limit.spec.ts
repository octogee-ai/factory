import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";

vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.uid = req.get("authorization");
    next();
  },
}));

import { createIsolatedGatewayRoutes } from "./gateways.js";

it("limits workspace Gateway status requests independently for each verified user", async () => {
  const app = express();
  app.use(createIsolatedGatewayRoutes());
  const path = "/workspaces/gateway-status";
  for (let index = 0; index < 120; index++) {
    await request(app).get(path).set("authorization", "alice").expect(200, { workspaces: [] });
  }
  await request(app).get(path).set("authorization", "alice").expect(429);
  await request(app).get(path).set("authorization", "bob").expect(200, { workspaces: [] });
});
