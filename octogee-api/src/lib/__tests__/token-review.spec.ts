import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TENANT_BINDING_AUDIENCE,
  createKubernetesTokenReviewer,
  type TokenReviewHttpRequest,
} from "../token-review.js";

const tempDirs: string[] = [];

async function tempFile(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-review-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, body);
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function authenticatedBody(
  saName = "octogee-gw-bender",
  audiences: string[] = [TENANT_BINDING_AUDIENCE],
) {
  return {
    status: {
      authenticated: true,
      audiences,
      user: { username: `system:serviceaccount:octogee:${saName}` },
    },
  };
}

describe("createKubernetesTokenReviewer", () => {
  it("submits TokenReview with octogee-api audience and parses the SA identity", async () => {
    const reviewerTokenPath = await tempFile("reviewer-token", "reviewer-jwt\n");
    const caPath = await tempFile("ca.crt", "ca-data");
    const calls: TokenReviewHttpRequest[] = [];
    const reviewer = createKubernetesTokenReviewer({
      apiHost: "kubernetes.local",
      apiPort: "6443",
      reviewerTokenPath,
      caPath,
      transport: async (req) => {
        calls.push(req);
        return { status: 201, body: authenticatedBody() };
      },
    });

    await expect(reviewer("caller-jwt")).resolves.toEqual({
      authenticated: true,
      namespace: "octogee",
      saName: "octogee-gw-bender",
      audiences: [TENANT_BINDING_AUDIENCE],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://kubernetes.local:6443/apis/authentication.k8s.io/v1/tokenreviews",
    );
    expect(calls[0].bearerToken).toBe("reviewer-jwt");
    expect(calls[0].ca).toBe("ca-data");
    expect(calls[0].body).toMatchObject({
      spec: { token: "caller-jwt", audiences: [TENANT_BINDING_AUDIENCE] },
    });
  });

  it("rejects unauthenticated, malformed, or wrong-audience TokenReview responses", async () => {
    const reviewerTokenPath = await tempFile("reviewer-token", "reviewer-jwt");
    const caPath = await tempFile("ca.crt", "ca-data");
    const bodies = [
      { status: { authenticated: false } },
      authenticatedBody("octogee-gw-bender", ["wrong-audience"]),
      { status: { authenticated: true, audiences: [TENANT_BINDING_AUDIENCE], user: {} } },
    ];
    const reviewer = createKubernetesTokenReviewer({
      reviewerTokenPath,
      caPath,
      transport: async () => ({ status: 200, body: bodies.shift() }),
    });

    await expect(reviewer("one")).resolves.toEqual({ authenticated: false });
    await expect(reviewer("two")).resolves.toEqual({ authenticated: false });
    await expect(reviewer("three")).resolves.toEqual({ authenticated: false });
  });

  it("throws on TokenReview HTTP errors", async () => {
    const reviewerTokenPath = await tempFile("reviewer-token", "reviewer-jwt");
    const caPath = await tempFile("ca.crt", "ca-data");
    const reviewer = createKubernetesTokenReviewer({
      reviewerTokenPath,
      caPath,
      transport: async () => ({ status: 503, body: {} }),
    });

    await expect(reviewer("caller-jwt")).rejects.toThrow("TokenReview HTTP 503");
  });

  it("caches successful token reviews for the configured TTL", async () => {
    const reviewerTokenPath = await tempFile("reviewer-token", "reviewer-jwt");
    const caPath = await tempFile("ca.crt", "ca-data");
    let now = 1_000;
    let transportCalls = 0;
    const reviewer = createKubernetesTokenReviewer({
      reviewerTokenPath,
      caPath,
      now: () => now,
      cacheTtlMs: 10_000,
      transport: async () => {
        transportCalls += 1;
        return { status: 200, body: authenticatedBody() };
      },
    });

    await reviewer("caller-jwt");
    await reviewer("caller-jwt");
    now += 11_000;
    await reviewer("caller-jwt");

    expect(transportCalls).toBe(2);
  });
});
