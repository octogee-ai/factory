import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(
  import.meta.dirname,
  "../../../.github/actions/release-digest-manifest/resolve-tag-digest.sh",
);
const temporaryDirectories: string[] = [];

function runLookup(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), "release-digest-tag-lookup-"));
  temporaryDirectories.push(directory);
  const calls = join(directory, "calls");
  const sleeps = join(directory, "sleeps");
  const state = join(directory, "state");
  const gcloud = join(directory, "gcloud");
  const sleep = join(directory, "sleep");
  writeFileSync(calls, "");
  writeFileSync(sleeps, "");
  writeFileSync(state, "0");
  writeFileSync(gcloud, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GCLOUD_CALLS"
attempt="$(( $(cat "$GCLOUD_STATE") + 1 ))"
printf '%s\\n' "$attempt" > "$GCLOUD_STATE"
not_found() { printf '%s\\n' 'ERROR: (gcloud.artifacts.docker.images.describe) Image not found.' >&2; exit 1; }
case "$FAKE_GCLOUD_MODE" in
  found) printf '%s\\n' 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  absent) not_found ;;
  repository_missing) printf '%s\\n' 'ERROR: (gcloud.artifacts.docker.images.describe) NOT_FOUND: Repository "octogee" not found in location "us-central1".' >&2; exit 1 ;;
  empty) ;;
  invalid) printf '%s\\n' 'not-a-digest' ;;
  error) printf '%s\\n' 'permission denied' >&2; exit 42 ;;
  unavailable_then_found)
    if [ "$attempt" -lt 3 ]; then printf '%s\\n' 'UNAVAILABLE: The service is currently unavailable.' >&2; exit 1; fi
    printf '%s\\n' 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ;;
  rate_limited_then_absent)
    if [ "$attempt" -eq 1 ]; then printf '%s\\n' 'RESOURCE_EXHAUSTED: HTTP 429 Too Many Requests' >&2; exit 1; fi
    not_found
    ;;
  server_error_then_found)
    if [ "$attempt" -eq 1 ]; then printf '%s\\n' 'ResponseError: status=[503]' >&2; exit 1; fi
    printf '%s\\n' 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ;;
  always_unavailable) printf '%s\\n' 'UNAVAILABLE: The service is currently unavailable.' >&2; exit 1 ;;
esac
`);
  writeFileSync(sleep, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GCLOUD_SLEEPS"
`);
  chmodSync(gcloud, 0o755);
  chmodSync(sleep, 0o755);
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
        GCLOUD_SLEEPS: sleeps,
        GCLOUD_STATE: state,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
      },
    },
  );
  return {
    ...result,
    calls: readFileSync(calls, "utf8"),
    sleeps: readFileSync(sleeps, "utf8"),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe("release digest tag lookup", () => {
  it("returns the immutable digest from one direct image describe of the exact tag", () => {
    const result = runLookup("found");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(result.calls.trim().split("\n")).toEqual([
      "artifacts docker images describe us-central1-docker.pkg.dev/octogee/octogee/release-digest-manifest:deadbeef --project=octogee --format=value(image_summary.digest)",
    ]);
    expect(result.calls).not.toContain("tags list");
  });

  it("returns status 3 silently when the registry reports the tag absent", () => {
    const result = runLookup("absent");

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.sleeps).toBe("");
  });

  it("fails loudly when Artifact Registry lookup fails", () => {
    const result = runLookup("error");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("permission denied");
    expect(result.calls.trim().split("\n")).toHaveLength(1);
    expect(result.sleeps).toBe("");
  });

  it("does not mistake a missing repository for an absent tag", () => {
    const result = runLookup("repository_missing");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NOT_FOUND: Repository "octogee" not found');
    expect(result.calls.trim().split("\n")).toHaveLength(1);
    expect(result.sleeps).toBe("");
  });

  it.each(["unavailable_then_found", "server_error_then_found"])(
    "retries transient %s failures before returning the digest",
    (mode) => {
      const result = runLookup(mode);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
      expect(result.stderr).toContain("transient Artifact Registry lookup failure");
      expect(result.calls.trim().split("\n")).toHaveLength(
        mode === "unavailable_then_found" ? 3 : 2,
      );
      expect(result.sleeps.trim().split("\n")).toEqual(
        mode === "unavailable_then_found" ? ["2", "4"] : ["2"],
      );
    },
  );

  it("preserves confirmed-absence status after retrying a rate limit", () => {
    const result = runLookup("rate_limited_then_absent");

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.calls.trim().split("\n")).toHaveLength(2);
    expect(result.sleeps.trim()).toBe("2");
  });

  it("fails closed after the bounded transient retry budget", () => {
    const result = runLookup("always_unavailable");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("UNAVAILABLE");
    expect(result.calls.trim().split("\n")).toHaveLength(6);
    expect(result.sleeps.trim().split("\n")).toEqual(["2", "4", "8", "16", "30"]);
  });

  it.each(["empty", "invalid"])("rejects %s describe output instead of treating it as absent", (mode) => {
    const result = runLookup(mode);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid digest lookup result");
  });

  it.each([
    ["us-central1-docker.pkg.dev/octogee/octogee/release-digest-manifest@sha256:abc", "digest references"],
    ["us-central1-docker.pkg.dev/octogee/octogee/release-digest-manifest", "untagged references"],
    ["us-central1-docker.pkg.dev/other/repo/release-digest-manifest:deadbeef", "references outside the repository"],
  ])("rejects %s (%s) before calling the registry", (reference) => {
    const directory = mkdtempSync(join(tmpdir(), "release-digest-tag-lookup-"));
    temporaryDirectories.push(directory);
    const result = spawnSync(
      helper,
      ["us-central1-docker.pkg.dev/octogee/octogee", "octogee", reference],
      { encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` } },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid tag reference");
  });
});
