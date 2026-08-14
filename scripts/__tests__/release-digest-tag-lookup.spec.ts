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
case "$FAKE_GCLOUD_MODE" in
  found) printf '%s\\n' 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  absent) ;;
  multiple) printf '%s\\n%s\\n' 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ;;
  invalid) printf '%s\\n' 'not-a-digest' ;;
  error) printf '%s\\n' 'permission denied' >&2; exit 42 ;;
  unavailable_then_found)
    if [ "$attempt" -lt 3 ]; then printf '%s\\n' 'UNAVAILABLE: The service is currently unavailable.' >&2; exit 1; fi
    printf '%s\\n' 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ;;
  rate_limited_then_absent)
    if [ "$attempt" -eq 1 ]; then printf '%s\\n' 'RESOURCE_EXHAUSTED: HTTP 429 Too Many Requests' >&2; exit 1; fi
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

  it.each(["multiple", "invalid"])("rejects %s lookup output", (mode) => {
    const result = runLookup(mode);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid digest lookup result");
  });
});
