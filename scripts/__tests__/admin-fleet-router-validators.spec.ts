import { describe, it, expect } from "vitest";
import { validateRolloutBody } from "../lib/admin-fleet-router";

describe("validateRolloutBody", () => {
  it("rejects when imageTag is missing", () => {
    const r = validateRolloutBody({});
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.status).toBe(400);
      expect(r.error.body).toMatchObject({ error: "missing imageTag" });
    }
  });

  it("rejects when imageTag isn't a 7–40 char lowercase hex SHA", () => {
    const r = validateRolloutBody({ imageTag: "NOT-A-SHA" });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.status).toBe(400);
      expect(r.error.body).toMatchObject({
        error: expect.stringContaining("hex SHA"),
        got: "NOT-A-SHA",
      });
    }
  });

  it("rejects when imageRepository is provided but not in the canonical AR", () => {
    const r = validateRolloutBody({
      imageTag: "abc1234",
      imageRepository: "docker.io/whatever/octogee-gateway",
    });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.status).toBe(400);
      expect(r.error.body).toMatchObject({
        expectedPrefix: expect.stringContaining(
          "us-central1-docker.pkg.dev/octogee/octogee/",
        ),
      });
    }
  });

  it("accepts a 7-char hex tag with no repo", () => {
    const r = validateRolloutBody({ imageTag: "abc1234" });
    expect("ok" in r).toBe(true);
    if ("ok" in r) {
      expect(r.ok).toEqual({
        imageTag: "abc1234",
        imageRepository: null,
      });
    }
  });

  it("accepts a 40-char hex tag plus the canonical AR repo", () => {
    const tag = "0123456789abcdef0123456789abcdef01234567";
    const repo = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
    const r = validateRolloutBody({
      imageTag: tag,
      imageRepository: repo,
    });
    expect("ok" in r).toBe(true);
    if ("ok" in r) {
      expect(r.ok).toEqual({ imageTag: tag, imageRepository: repo });
    }
  });
});
