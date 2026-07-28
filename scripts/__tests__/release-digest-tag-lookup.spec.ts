import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(
  import.meta.dirname,
  "../../.github/actions/release-digest-manifest/resolve-tag-digest.sh",
);
const temporaryDirectories: string[] = [];

function runLookup(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), "release-digest-tag-lookup-"));
  temporaryDirectories.push(directory);
  const calls = join(directory, "calls");
  const gcloud = join(directory, "gcloud");
  writeFileSync(gcloud, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "$GCLOUD_CALLS"
case "$FAKE_GCLOUD_MODE" in
  found) printf '%s\\n' 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  absent) ;;
  multiple) printf '%s\\n%s\\n' 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ;;
  invalid) printf '%s\\n' 'not-a-digest' ;;
  error) printf '%s\\n' 'permission denied' >&2; exit 42 ;;
esac
`);
  chmodSync(gcloud, 0o755);
  const result = spawnSync(
    helper,
    [
      "us-central1-docker.pkg.dev/octogee/octogee",
      "octogee",
      "us-central1-docker.pkg.dev/octogee/octogee/release-digest-manifest:deadbeef",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GCLOUD_MODE: mode,
        GCLOUD_CALLS: calls,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
      },
    },
  );
  return {
    ...result,
    calls: readFileSync(calls, "utf8"),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe("release digest tag lookup", () => {
  it("returns the immutable digest for one exact tag", () => {
    const result = runLookup("found");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(result.calls).toContain(
      "artifacts docker tags list us-central1-docker.pkg.dev/octogee/octogee",
    );
    expect(result.calls).toContain(
      "--filter=tag=projects/octogee/locations/us-central1/repositories/octogee/packages/release-digest-manifest/tags/deadbeef",
    );
    expect(result.calls).toContain("--limit=2");
    expect(result.calls).toContain("--format=value(version)");
  });

  it("returns status 3 only for an empty successful lookup", () => {
    const result = runLookup("absent");

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("fails loudly when Artifact Registry lookup fails", () => {
    const result = runLookup("error");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("permission denied");
  });

  it.each(["multiple", "invalid"])("rejects %s lookup output", (mode) => {
    const result = runLookup(mode);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid digest lookup result");
  });
});
