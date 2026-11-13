import request from "supertest";
import { describe, expect, it } from "vitest";

const { createApp } = await import("../index.js");

describe("gateway-edge app trust proxy — express-rate-limit must key on the real client behind GCLB + gateway-router", () => {
  it("trusts exactly 2 hops (router socket + GCLB entry) so req.ip is the GCLB-appended client, never client-supplied XFF junk", async () => {
    const app = createApp();
    expect(app.get("trust proxy")).toBe(2);

    app.get("/__test/trust-proxy-ip", (req, res) => {
      res.json({ ip: req.ip });
    });

    const res = await request(app)
      .get("/__test/trust-proxy-ip")
      .set("X-Forwarded-For", "6.6.6.6, 203.0.113.9, 130.211.0.10");

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe("203.0.113.9");
  });
});
