import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../lib/assert-artifact-image-size.sh");
const buildConfig = readFileSync(
  resolve(import.meta.dirname, "../../cloudbuild-operator-final.yaml"),
  "utf8",
);
const temporaryDirectories: string[] = [];

function runCheck(imageSize: string, maximumBytes = "1250000000") {
  const directory = mkdtempSync(join(tmpdir(), "builder-image-size-"));
  temporaryDirectories.push(directory);
  const gcloud = join(directory, "gcloud");
  writeFileSync(
    gcloud,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$FAKE_IMAGE_SIZE"
`,
  );
  chmodSync(gcloud, 0o755);

  return spawnSync(
    helper,
    [
      "us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder:deadbee",
      maximumBytes,
      "octogee",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_IMAGE_SIZE: imageSize,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
      },
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

describe("Builder compressed image budget", () => {
  it("accepts an image at the byte budget", () => {
    const result = runCheck("1250000000");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1250000000 / 1250000000 bytes");
  });

  it("fails when the compressed image exceeds the budget", () => {
    const result = runCheck("1250000001");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("exceeds compressed size budget");
    expect(result.stderr).toContain("1250000001 > 1250000000");
  });

  it.each(["", "unknown", "123\\n456"])("rejects invalid registry size %j", (size) => {
    const result = runCheck(size);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid Artifact Registry imageSizeBytes");
  });

  it("runs the budget against the pushed Builder image", () => {
    expect(buildConfig).toContain('_MAX_COMPRESSED_IMAGE_BYTES: "1250000000"');
    expect(buildConfig).toContain('_PROFILE_IMAGE: "octogee-gateway-builder"');
    expect(buildConfig).toContain("scripts/lib/assert-artifact-image-size.sh");
    expect(buildConfig).toContain('${_PROFILE_IMAGE}:${_IMAGE_TAG}');
  });
});
