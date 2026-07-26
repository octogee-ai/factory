import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const gatewayImageBundle = resolve(import.meta.dirname, "../lib/gateway-image-bundle.sh");
const verifyEnv = readFileSync(resolve(import.meta.dirname, "../verify-env.sh"), "utf8");

function releaseSha(image: string) {
  return spawnSync(
    "bash",
    ["-c", 'source "$1"; octogee_gateway_image_release_sha "$2"', "--", gatewayImageBundle, image],
    { encoding: "utf8" },
  );
}

describe("verify-env gateway image release SHA", () => {
  it("uses the release-tag SHA rather than the digest for a digest-pinned gateway image", () => {
    expect(verifyEnv).toContain('GW_SHA=$(octogee_gateway_image_release_sha "$GW_IMAGE" || echo "")');

    const result = releaseSha(
      `us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway:d6672b6-oc2026.7.1@sha256:${"a".repeat(64)}`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("d6672b6");
  });
});
