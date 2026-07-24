import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const script = resolve(repoRoot, "scripts/lib/image-fingerprint-reuse.sh");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const fakeGcloud = (directory: string, body: string) => {
  const log = join(directory, "gcloud-args.log");
  const gcloud = join(directory, "gcloud");
  writeFileSync(gcloud, ["#!/usr/bin/env bash", 'printf "%s\\n" "$*" >> "$GCLOUD_ARGS_LOG"', body].join("\n"));
  chmodSync(gcloud, 0o755);
  return log;
};

const fakeNode = (directory: string, body: string) => {
  const node = join(directory, "node");
  writeFileSync(node, ["#!/usr/bin/env bash", body].join("\n"));
  chmodSync(node, 0o755);
};

const run = (args: string[], directory: string, extraEnv: Record<string, string> = {}) =>
  spawnSync("bash", [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      ...extraEnv,
    },
  });

describe("image-fingerprint-reuse.sh check", () => {
  it("reuses a matching input fingerprint: aliases the short-sha tag and reports exists=true", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-check-"));
    directories.push(directory);
    const log = fakeGcloud(
      directory,
      [
        'case "$*" in',
        '  *"images describe"*"if-deadbeef"*) echo "sha256:cafef00d"; exit 0 ;;',
        '  *"tags add"*"if-deadbeef"*"abc1234"*) exit 0 ;;',
        '  *) exit 1 ;;',
        "esac",
      ].join("\n"),
    );
    fakeNode(directory, 'echo "deadbeef"');

    const result = run(["check", "octogee-api", "us-west1-docker.pkg.dev/octogee/octogee", "abc1234", "HEAD"], directory, {
      GCLOUD_ARGS_LOG: log,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("fingerprint=deadbeef");
    expect(result.stdout).toContain("exists=true");
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("artifacts docker images describe us-west1-docker.pkg.dev/octogee/octogee/octogee-api:if-deadbeef");
    expect(calls).toContain(
      "artifacts docker tags add us-west1-docker.pkg.dev/octogee/octogee/octogee-api:if-deadbeef us-west1-docker.pkg.dev/octogee/octogee/octogee-api:abc1234",
    );
  });

  it("emits a prominent notice on reuse naming the image, digest, fingerprint tag, and the BUILD_SHA caveat", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-check-"));
    directories.push(directory);
    const log = fakeGcloud(
      directory,
      [
        'case "$*" in',
        '  *"images describe"*"if-deadbeef"*) echo "sha256:cafef00d"; exit 0 ;;',
        '  *"tags add"*"if-deadbeef"*"abc1234"*) exit 0 ;;',
        '  *) exit 1 ;;',
        "esac",
      ].join("\n"),
    );
    fakeNode(directory, 'echo "deadbeef"');

    const result = run(["check", "octogee-api", "us-west1-docker.pkg.dev/octogee/octogee", "abc1234", "HEAD"], directory, {
      GCLOUD_ARGS_LOG: log,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("::notice::");
    expect(result.stderr).toContain("octogee-api");
    expect(result.stderr).toContain("sha256:cafef00d");
    expect(result.stderr).toContain("if-deadbeef");
    expect(result.stderr).toContain("BUILD_SHA");
  });

  it("falls back to building when no image carries the input fingerprint tag", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-check-"));
    directories.push(directory);
    const log = fakeGcloud(directory, "exit 1");
    fakeNode(directory, 'echo "deadbeef"');

    const result = run(["check", "octogee-api", "us-west1-docker.pkg.dev/octogee/octogee", "abc1234", "HEAD"], directory, {
      GCLOUD_ARGS_LOG: log,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("fingerprint=deadbeef");
    expect(result.stdout).toContain("exists=false");
  });

  it("falls back to building and logs a warning when fingerprint computation fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-check-"));
    directories.push(directory);
    const log = fakeGcloud(directory, "exit 1");
    fakeNode(directory, 'echo "boom" >&2; exit 1');

    const result = run(["check", "octogee-api", "us-west1-docker.pkg.dev/octogee/octogee", "abc1234", "HEAD"], directory, {
      GCLOUD_ARGS_LOG: log,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("fingerprint=\n");
    expect(result.stdout).toContain("exists=false");
    expect(result.stderr).toContain("::warning::");
  });

  it("falls back to building when the fingerprint tag exists but aliasing it fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-check-"));
    directories.push(directory);
    const log = fakeGcloud(
      directory,
      [
        'case "$*" in',
        '  *"images describe"*"if-deadbeef"*) exit 0 ;;',
        '  *"tags add"*) exit 1 ;;',
        '  *) exit 1 ;;',
        "esac",
      ].join("\n"),
    );
    fakeNode(directory, 'echo "deadbeef"');

    const result = run(["check", "octogee-api", "us-west1-docker.pkg.dev/octogee/octogee", "abc1234", "HEAD"], directory, {
      GCLOUD_ARGS_LOG: log,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("exists=false");
    expect(result.stderr).toContain("::warning::");
  });
});

describe("image-fingerprint-reuse.sh record", () => {
  it("tags the freshly built digest with the input fingerprint when nothing is recorded yet", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-record-"));
    directories.push(directory);
    const log = fakeGcloud(
      directory,
      [
        'case "$*" in',
        '  *"images describe"*":abc1234"*) echo "sha256:new"; exit 0 ;;',
        '  *"images describe"*"if-deadbeef"*) exit 1 ;;',
        '  *"tags add"*) exit 0 ;;',
        '  *) exit 1 ;;',
        "esac",
      ].join("\n"),
    );
    fakeNode(directory, "exit 0");

    const result = run(
      ["record", "octogee-api", "us-west1-docker.pkg.dev/octogee/octogee", "abc1234", "deadbeef"],
      directory,
      { GCLOUD_ARGS_LOG: log },
    );

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(
      "artifacts docker tags add us-west1-docker.pkg.dev/octogee/octogee/octogee-api:abc1234 us-west1-docker.pkg.dev/octogee/octogee/octogee-api:if-deadbeef",
    );
  });

  it("is best-effort when resolving the just-built digest transiently fails: warns and exits 0, never tags", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-record-"));
    directories.push(directory);
    const log = fakeGcloud(directory, "exit 1");
    fakeNode(directory, "exit 0");

    const result = run(
      ["record", "octogee-api", "us-west1-docker.pkg.dev/octogee/octogee", "abc1234", "deadbeef"],
      directory,
      { GCLOUD_ARGS_LOG: log },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("::warning::");
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("tags add");
  });

  it("is best-effort when the final tag-add transiently fails: warns and exits 0", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-record-"));
    directories.push(directory);
    const log = fakeGcloud(
      directory,
      [
        'case "$*" in',
        '  *"images describe"*":abc1234"*) echo "sha256:new"; exit 0 ;;',
        '  *"images describe"*"if-deadbeef"*) exit 1 ;;',
        '  *"tags add"*) exit 1 ;;',
        '  *) exit 1 ;;',
        "esac",
      ].join("\n"),
    );
    fakeNode(directory, "exit 0");

    const result = run(
      ["record", "octogee-api", "us-west1-docker.pkg.dev/octogee/octogee", "abc1234", "deadbeef"],
      directory,
      { GCLOUD_ARGS_LOG: log },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("::warning::");
  });

  it("is a no-op when the fingerprint tag already matches the freshly built digest", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-record-"));
    directories.push(directory);
    const log = fakeGcloud(directory, 'echo "sha256:same"');
    fakeNode(directory, "exit 0");

    const result = run(
      ["record", "octogee-api", "us-west1-docker.pkg.dev/octogee/octogee", "abc1234", "deadbeef"],
      directory,
      { GCLOUD_ARGS_LOG: log },
    );

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("tags add");
  });

  it("fails closed when the fingerprint tag already points at a different digest", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-record-"));
    directories.push(directory);
    const log = fakeGcloud(
      directory,
      [
        'case "$*" in',
        '  *"images describe"*":abc1234"*) echo "sha256:new"; exit 0 ;;',
        '  *"images describe"*"if-deadbeef"*) echo "sha256:old"; exit 0 ;;',
        '  *) exit 1 ;;',
        "esac",
      ].join("\n"),
    );
    fakeNode(directory, 'echo "collision" >&2; exit 1');

    const result = run(
      ["record", "octogee-api", "us-west1-docker.pkg.dev/octogee/octogee", "abc1234", "deadbeef"],
      directory,
      { GCLOUD_ARGS_LOG: log },
    );

    expect(result.status).toBe(2);
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("tags add");
  });
});

describe("image-fingerprint-reuse.sh usage", () => {
  it("exits 1 with usage on an unknown subcommand", () => {
    const directory = mkdtempSync(join(tmpdir(), "octogee-image-fingerprint-usage-"));
    directories.push(directory);
    const result = run(["bogus"], directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });
});
