import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const validator = resolve(import.meta.dirname, "../lib/gateway-image-bundle.sh");
const verifyEnv = readFileSync(resolve(import.meta.dirname, "../verify-env.sh"), "utf8");

function validate(gateway: string, edge: string) {
  return spawnSync("bash", [validator, gateway, edge], { encoding: "utf8" });
}

const gatewayDigest = "a".repeat(64);
const edgeDigest = "b".repeat(64);

describe("gateway image bundle identity", () => {
  it("is the verifier contract instead of comparing package digests", () => {
    expect(verifyEnv).toContain(
      'octogee_gateway_image_bundle_identity "$GW_IMG" "$GE_IMG"',
    );
    expect(verifyEnv).toContain("independent package digests");
    expect(verifyEnv).not.toContain("image SHA drift");
  });

  it("accepts the same build tag with independently pinned package digests", () => {
    const result = validate(
      `us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway:be348ca-oc2026.7.26@sha256:${gatewayDigest}`,
      `us-central1-docker.pkg.dev/octogee/octogee/gateway-edge:be348ca-oc2026.7.26@sha256:${edgeDigest}`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("be348ca-oc2026.7.26");
  });

  it("rejects a partial roll whose build tags differ", () => {
    const result = validate(
      `repo/octogee-gateway:be348ca-oc2026.7.26@sha256:${gatewayDigest}`,
      `repo/gateway-edge:deadbee-oc2026.7.26@sha256:${edgeDigest}`,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bundle identity mismatch");
  });

  it("rejects either image when it is not digest pinned", () => {
    const result = validate(
      "repo/octogee-gateway:be348ca-oc2026.7.26",
      `repo/gateway-edge:be348ca-oc2026.7.26@sha256:${edgeDigest}`,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not an immutable image reference");
  });
});
