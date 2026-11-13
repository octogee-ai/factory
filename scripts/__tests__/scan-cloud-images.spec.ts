import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const registry = "ghcr.io/octogee-ai/octogee-cloud";
const sha = "a".repeat(40);
const arm = `sha256:${"1".repeat(64)}`;
const amd = `sha256:${"2".repeat(64)}`;
const images = ["glm-controller", "octogee-api", "gateway-edge", "octogee-gateway"];
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "octogee-scan-images-"));
  writeFileSync(join(directory, "trivy"), `#!/usr/bin/env bash
    echo "$*" >> "$CALLS"
    while [[ "$1" != --output ]]; do shift; done
    out="$2"
    reference="\${!#}"
    if [[ -n "$FAIL_IMAGE" && "$reference" == */"$FAIL_IMAGE"@* ]]; then exit 1; fi
    printf '%s\\n' '{"Results":[{"Vulnerabilities":[{"Severity":"CRITICAL"}]}]}' > "$out"
  `, { mode: 0o755 });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run({ manifestSha = sha, include = images, failImage = "" } = {}) {
  const manifest = join(directory, "manifest.json");
  writeFileSync(manifest, JSON.stringify({
    registry, sha: manifestSha,
    images: Object.fromEntries(include.map(name => [name, { platforms: { "linux/arm64": arm, "linux/amd64": amd } }])),
  }));
  return spawnSync("bash", ["scripts/ci/scan-cloud-images.sh", manifest, sha, "linux/arm64", join(directory, "reports")], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CALLS: join(directory, "calls"),
      FAIL_IMAGE: failImage, GITHUB_STEP_SUMMARY: join(directory, "summary") },
  });
}

it("reports findings and produces an SBOM for every exact architecture digest", () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  const calls = readFileSync(join(directory, "calls"), "utf8");
  for (const name of images) {
    expect(calls).toContain(`${registry}/${name}@${arm}`);
    expect(calls).not.toContain(`${registry}/${name}@${amd}`);
    expect(readFileSync(join(directory, "summary"), "utf8")).toContain(`${name}@${arm}\` | 1 | 0 | 0 | 0 | 0 |`);
  }
  expect(readdirSync(join(directory, "reports"))).toHaveLength(11);
});

it.each([
  [{ manifestSha: "b".repeat(40) }, "Image manifest does not match"],
  [{ include: images.slice(0, -1) }, "octogee-gateway has no valid linux/arm64 digest"],
])("rejects an invalid manifest before invoking Trivy", (options, error) => {
  const result = run(options);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(error);
  expect(readdirSync(directory)).not.toContain("calls");
});

it("continues scanning other images and fails the job after a Trivy error", () => {
  const result = run({ failImage: "octogee-api" });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("Trivy could not finish reports");
  const reports = readdirSync(join(directory, "reports"));
  expect(reports).toContain("octogee-gateway.cdx.json");
  expect(reports).not.toContain("octogee-api.cdx.json");
});
