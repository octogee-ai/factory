import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createKubernetesTokenReviewer,
  type TokenReviewHttpRequest,
} from "../kubernetes-token-review.js";

async function withTokenFiles<T>(
  fn: (paths: { tokenPath: string; caPath: string }) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gateway-edge-token-review-"));
  try {
    const tokenPath = path.join(dir, "token");
    const caPath = path.join(dir, "ca.crt");
    writeFileSync(tokenPath, "reviewer-jwt\n");
    writeFileSync(caPath, "test-ca");
    return await fn({ tokenPath, caPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gateway-edge Kubernetes TokenReview", () => {
  it("submits TokenReview with octogee-api audience and parses service-account identity", async () => {
    await withTokenFiles(async ({ tokenPath, caPath }) => {
      const calls: TokenReviewHttpRequest[] = [];
      const reviewer = createKubernetesTokenReviewer({
        apiHost: "kubernetes.local",
        apiPort: "6443",
        reviewerTokenPath: tokenPath,
        caPath,
        transport: async (req) => {
          calls.push(req);
          return {
            status: 201,
            body: {
              status: {
                authenticated: true,
                audiences: ["octogee-api"],
                user: {
                  username: "system:serviceaccount:octogee-test:octogee-gw-bender",
                },
              },
            },
          };
        },
      });

      await expect(reviewer("caller-jwt")).resolves.toEqual({
        authenticated: true,
        namespace: "octogee-test",
        saName: "octogee-gw-bender",
        audiences: ["octogee-api"],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        "https://kubernetes.local:6443/apis/authentication.k8s.io/v1/tokenreviews",
      );
      expect(calls[0].bearerToken).toBe("reviewer-jwt");
      expect(calls[0].ca).toBe("test-ca");
      expect(calls[0].body).toMatchObject({
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenReview",
        spec: { token: "caller-jwt", audiences: ["octogee-api"] },
      });
    });
  });

  it("rejects unauthenticated, wrong-audience, or malformed service-account responses", async () => {
    const responses = [
      { status: { authenticated: false } },
      {
        status: {
          authenticated: true,
          audiences: ["other"],
          user: { username: "system:serviceaccount:octogee-test:octogee-gw-bender" },
        },
      },
      {
        status: {
          authenticated: true,
          audiences: ["octogee-api"],
          user: { username: "plain-user" },
        },
      },
    ];

    for (const body of responses) {
      await withTokenFiles(async ({ tokenPath, caPath }) => {
        const reviewer = createKubernetesTokenReviewer({
          reviewerTokenPath: tokenPath,
          caPath,
          transport: async () => ({ status: 200, body }),
        });
        await expect(reviewer("caller-jwt")).resolves.toEqual({ authenticated: false });
      });
    }
  });

  it("throws on TokenReview HTTP errors", async () => {
    await withTokenFiles(async ({ tokenPath, caPath }) => {
      const reviewer = createKubernetesTokenReviewer({
        reviewerTokenPath: tokenPath,
        caPath,
        transport: async () => ({ status: 503, body: { error: "unavailable" } }),
      });
      await expect(reviewer("caller-jwt")).rejects.toThrow("TokenReview HTTP 503");
    });
  });
});
