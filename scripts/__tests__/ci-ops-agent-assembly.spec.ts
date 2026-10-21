import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const assemble = resolve(import.meta.dirname, "../ci/ops-agent.sh");
const repository = "us-central1-docker.pkg.dev/octogee/octogee";
const forkSha = "a".repeat(40);
const runtimeDigest = `sha256:${"b".repeat(64)}`;
const evidenceDigest = `sha256:${"c".repeat(64)}`;
const evidenceTagPattern = new RegExp(`^resolve ${repository}/octogee-ops-agent-openclaw-evidence:${"b".repeat(64)}-${forkSha}-([0-9a-f]{12})$`);
const evidenceTag = (calls: string[]) => calls.find(call => evidenceTagPattern.test(call))?.slice("resolve ".length);

const script = (root: string, path: string, body: string) => {
  const file = resolve(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(file, 0o755);
};

function run(lookups: number[], { evidenceRevision = "" } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "octogee-ops-agent-assembly-"));
  const calls = resolve(root, "calls.log");
  mkdirSync(resolve(root, "scripts/ci"), { recursive: true });
  copyFileSync(assemble, resolve(root, "scripts/ci/ops-agent.sh"));
  mkdirSync(resolve(root, "infra/gateway/openclaw-tarball"), { recursive: true });
  writeFileSync(resolve(root, "infra/gateway/openclaw-tarball/current.json"), JSON.stringify({ sourceSha: forkSha }));
  writeFileSync(resolve(root, "lookups"), lookups.join("\n") + "\n");
  script(root, "scripts/lib/ops-agent-evidence.sh", `echo "evidence $1 $2" >> "$CALLS"; mkdir -p "$3"${evidenceRevision}`);
  script(root, "scripts/lib/ops-agent-evidence-layer.sh", `echo "layer $2" >> "$CALLS"; touch "$3"`);
  script(root, ".github/actions/release-digest-manifest/resolve-tag-digest.sh", [
    `echo "resolve $3" >> "${calls}"`,
    `status="$(head -n 1 "${root}/lookups")"; sed -i.bak 1d "${root}/lookups"`,
    `[ "$status" = 0 ] && echo "${evidenceDigest}"`,
    `exit "$status"`,
  ].join("\n"));
  script(root, "bin/crane", [
    `echo "crane $*" >> "${calls}"`,
    `if [ "$1" = digest ]; then echo "${runtimeDigest}"; fi`,
  ].join("\n"));
  const result = spawnSync("bash", ["scripts/ci/ops-agent.sh"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${resolve(root, "bin")}:${process.env.PATH}`,
      AR_REPOSITORY: repository,
      GCP_PROJECT: "octogee",
      SHORT_SHA: "1234567",
      OCTOGEE_SOURCE_COMMIT: "d".repeat(40),
      CI_REPO_ROOT: root,
      RUNNER_TEMP: root,
      CALLS: calls,
    },
  });
  return { root, result, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [] };
}

describe("ops-agent image assembly", () => {
  it("reuses the OpenClaw evidence base for an unchanged runtime and fork commit without fetching the fork", () => {
    const { result, calls, root } = run([0]);

    expect(result.status, result.stderr).toBe(0);
    expect(evidenceTag(calls)).toBeDefined();
    expect(calls.some(call => call.includes("ceckert/openclaw"))).toBe(false);
    expect(calls).toContain(`evidence file://${root} ${"d".repeat(40)}`);
    const append = calls.filter(call => call.startsWith("crane append"));
    expect(append).toHaveLength(1);
    expect(append[0]).toContain(`--base ${repository}/octogee-ops-agent-openclaw-evidence@${evidenceDigest}`);
    expect(append[0]).toContain("ops-agent-octogee-evidence.tar.gz");
    expect(append[0]).toContain(`--new_tag ${repository}/octogee-ops-agent:1234567`);
  });

  it("builds the OpenClaw evidence base once from the pinned fork commit when it is missing", () => {
    const { result, calls } = run([3, 0]);

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain(`evidence https://github.com/ceckert/openclaw.git ${forkSha}`);
    const append = calls.filter(call => call.startsWith("crane append"));
    expect(append).toHaveLength(2);
    expect(append[0]).toContain(`--base ${repository}/octogee-ops-agent-runtime:1234567`);
    expect(append[0]).toContain("ops-agent-openclaw-evidence.tar.gz");
    expect(append[0]).toContain(`--new_tag ${evidenceTag(calls)}`);
    expect(append[1]).toContain(`--base ${repository}/octogee-ops-agent-openclaw-evidence@${evidenceDigest}`);
    expect(append[1]).toContain("ops-agent-octogee-evidence.tar.gz");
  });

  it("keys the evidence base on the evidence-generation scripts", () => {
    const current = evidenceTag(run([0]).calls);
    const revised = evidenceTag(run([0], { evidenceRevision: "\n# sanitization revision" }).calls);

    expect(current).toBe(evidenceTag(run([0]).calls));
    expect(revised).toBeDefined();
    expect(revised).not.toBe(current);
  });

  it("fails without assembling when the evidence base lookup errors", () => {
    const { result, calls } = run([1]);

    expect(result.status).not.toBe(0);
    expect(calls.some(call => call.startsWith("crane append"))).toBe(false);
  });
});
