import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isValidGatewayInternalAuth,
  resolveGatewayInternalAuthSecret,
} from "../gateway-internal-auth.js";
import type { Reviewer } from "../kubernetes-token-review.js";

function withTokenFile<T>(body: string, fn: (tokenPath: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gateway-internal-auth-"));
  try {
    const tokenPath = path.join(dir, "token");
    writeFileSync(tokenPath, body);
    return fn(tokenPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gateway internal auth", () => {
  it("uses INTERNAL_SERVICE_KEY when present", () => {
    expect(
      resolveGatewayInternalAuthSecret({
        INTERNAL_SERVICE_KEY: "platform-key",
        GATEWAY_PROFILE: "builder",
      }),
    ).toEqual({
      value: "platform-key",
      mode: "platform",
      headerName: "x-internal-service-key",
    });
  });

  it("uses a Builder gateway projected service-account token when the platform key is absent", () => {
    withTokenFile("projected-sa-token\n", (tokenPath) => {
      expect(
        resolveGatewayInternalAuthSecret({
          GATEWAY_CLASS: "builder",
          GATEWAY_PROFILE: "builder",
          OCTOGEE_API_SA_TOKEN_PATH: tokenPath,
        }),
      ).toEqual({
        value: "projected-sa-token",
        mode: "gateway-service-account",
        headerName: "x-k8s-sa-token",
      });
    });
  });

  it("does not use a projected token outside the Builder runtime", () => {
    withTokenFile("projected-sa-token\n", (tokenPath) => {
      expect(
        resolveGatewayInternalAuthSecret({
          GATEWAY_CLASS: "shared",
          GATEWAY_PROFILE: "standard",
          OCTOGEE_API_SA_TOKEN_PATH: tokenPath,
        }),
      ).toBeNull();
    });
  });

  it("compares a platform key exactly", async () => {
    const env = { INTERNAL_SERVICE_KEY: "platform-key", GATEWAY_PROFILE: "standard" };
    await expect(isValidGatewayInternalAuth("platform-key", env)).resolves.toBe(true);
    await expect(isValidGatewayInternalAuth("wrong-token", env)).resolves.toBe(false);
  });

  it("validates a projected service-account caller through TokenReview", async () => {
    const reviewer: Reviewer = async (jwt) => jwt === "caller-jwt"
      ? {
          authenticated: true,
          namespace: "octogee-test",
          saName: "octogee-gw-bender",
          audiences: ["octogee-api"],
        }
      : { authenticated: false };
    await withTokenFile("projected-sa-token\n", async (tokenPath) => {
      const env = {
        GATEWAY_CLASS: "builder",
        GATEWAY_PROFILE: "builder",
        GATEWAY_ID: "bender",
        K8S_NAMESPACE: "octogee-test",
        OCTOGEE_API_SA_TOKEN_PATH: tokenPath,
      };
      await expect(isValidGatewayInternalAuth("caller-jwt", env, { reviewer })).resolves.toBe(true);
      await expect(isValidGatewayInternalAuth("wrong-token", env, { reviewer })).resolves.toBe(false);
    });
  });
});
