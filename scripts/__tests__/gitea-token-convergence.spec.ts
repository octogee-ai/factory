import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const helper = path.join(repoRoot, "scripts/lib/gitea-token-convergence.sh");

function executable(file: string, source: string): void {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function run(
  functionCall: string,
  options: { issueStatus?: number; recordingFail?: boolean } = {},
) {
  const temp = mkdtempSync(path.join(tmpdir(), "gitea-token-convergence-"));
  const log = path.join(temp, "kubectl.log");
  executable(path.join(temp, "kubectl"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_KUBECTL_LOG"

if [[ "$*" == *"get pods"* ]]; then
  if [[ "$*" == *"app=octogee-api"* ]]; then
    app='octogee-api'
  else
    app='glm-controller'
  fi
  printf '{"items":['
  printf '{"metadata":{"name":"%s-old","deletionTimestamp":"2026-07-26T18:00:00Z"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},' "$app"
  printf '{"metadata":{"name":"%s-unready"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"False"}]}},' "$app"
  printf '{"metadata":{"name":"%s-current"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}' "$app"
  printf ']}\\n'
  exit 0
fi

if [[ "$*" == *"exec "* ]]; then
  args=("$@")
  env_args=()
  script=""
  for ((i=0; i<\${#args[@]}; i++)); do
    if [[ "\${args[$i]}" == "env" ]]; then
      for ((j=i+1; j<\${#args[@]}; j++)); do
        [[ "\${args[$j]}" == "node" ]] && break
        env_args+=("\${args[$j]}")
      done
    fi
    if [[ "\${args[$i]}" == "-e" ]]; then
      script="\${args[$((i+1))]}"
      break
    fi
  done
  mock_fetch='globalThis.fetch=async(url)=>{const actual=String(url);if(actual===process.env.EXPECTED_GITEA_IDENTITY_URL)return {ok:true,status:200,json:async()=>({login:"octogee-admin"})};if(actual===process.env.EXPECTED_GITEA_ISSUE_URL){const status=Number(process.env.GITEA_ISSUE_STATUS);return {ok:status===200,status,json:async()=>({})}}throw new Error("unexpected URL "+url)};'
  env "\${env_args[@]}" node --input-type=module -e "$mock_fetch$script"
  exit 0
fi

exit 0
`);

  const result = spawnSync("bash", ["-euo", "pipefail", "-c", [
    "fail() { printf '%s\\n' \"$1\" >&2; [[ \"${FAKE_RECORDING_FAIL:-false}\" == \"true\" ]] && return 0; return 1; }",
    "info() { :; }",
    "ok() { :; }",
    `source ${JSON.stringify(helper)}`,
    'K8S_CONTEXT="test-context"',
    'K8S_NAMESPACE="octogee-test-west"',
    functionCall,
  ].join("\n")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_KUBECTL_LOG: log,
      GITEA_TOKEN: "platform-token",
      GITEA_URL: "",
      GIT_API_TOKEN: "controller-token",
      GIT_API_URL: "http://octogee-gitea-http.octogee-test-west.svc.cluster.local:3000/api/v1",
      K8S_NAMESPACE: "octogee-test-west",
      EXPECTED_GITEA_IDENTITY_URL:
        "http://octogee-gitea-http.octogee-test-west.svc.cluster.local:3000/api/v1/user",
      EXPECTED_GITEA_ISSUE_URL:
        "http://octogee-gitea-http.octogee-test-west.svc.cluster.local:3000/api/v1/repos/issues/search?limit=1",
      GITEA_ISSUE_STATUS: String(options.issueStatus ?? 200),
      FAKE_RECORDING_FAIL: String(options.recordingFail ?? false),
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter((call) => call.includes("rollout ") || call.startsWith("get pods") || call.startsWith("exec "))
    : [];
  rmSync(temp, { recursive: true, force: true });
  return { ...result, calls };
}

describe("Gitea platform-token convergence", () => {
  it("authenticates octogee-api through its runtime namespace fallback when GITEA_URL is blank", () => {
    const result = run(
      'validate_gitea_token_consumer octogee-api GITEA_TOKEN GITEA_URL "api/v1/user"',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]).toContain("exec");
  });

  it("authenticates only the current Ready non-terminating pod after a consumer restart", () => {
    const result = run(
      'validate_gitea_token_consumer octogee-api GITEA_TOKEN GITEA_URL "api/v1/user"',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("exec "))).toEqual([
      expect.stringContaining(" octogee-api-current "),
    ]);
    expect(result.calls.join("\n")).not.toContain("octogee-api-old");
    expect(result.calls.join("\n")).not.toContain("octogee-api-unready");
  });

  it("rejects an authenticated consumer whose token cannot access issue routes", () => {
    const result = run(
      'validate_gitea_token_consumer octogee-api GITEA_TOKEN GITEA_URL "api/v1/user"',
      { issueStatus: 403, recordingFail: true },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Gitea issue access returned HTTP 403");
    expect(result.stderr).toContain("Gitea token consumer validation failed");
  });

  it("restarts, waits for, and authenticates each real platform-token consumer serially", () => {
    const result = run("restart_gitea_token_consumers");

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.map((call) => {
      if (call.includes("rollout restart")) return `restart:${call.match(/deployment\/(\S+)/)?.[1]}`;
      if (call.includes("rollout status")) return `status:${call.match(/deployment\/(\S+)/)?.[1]}`;
      if (call.includes("get pods")) return `pods:${call.match(/app=(\S+)/)?.[1]}`;
      if (call.includes("exec ")) return `exec:${call.match(/ (octogee-api|glm-controller)-current /)?.[1]}`;
      return call;
    })).toEqual([
      "restart:octogee-api",
      "status:octogee-api",
      "pods:octogee-api",
      "exec:octogee-api",
      "restart:glm-controller",
      "status:glm-controller",
      "pods:glm-controller",
      "exec:glm-controller",
    ]);
    expect(result.calls.join("\n")).not.toContain("octogee-gateway");
  });

  it("authenticates both restored consumers without restarting them", () => {
    const result = run("validate_gitea_token_consumers");

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.map((call) => {
      if (call.includes("get pods")) return `pods:${call.match(/app=(\S+)/)?.[1]}`;
      if (call.includes("exec ")) return `exec:${call.match(/ (octogee-api|glm-controller)-current /)?.[1]}`;
      return call;
    })).toEqual([
      "pods:octogee-api",
      "exec:octogee-api",
      "pods:glm-controller",
      "exec:glm-controller",
    ]);
    expect(result.calls.join("\n")).not.toContain("rollout");
  });
});
