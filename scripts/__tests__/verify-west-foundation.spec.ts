import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(repoRoot, "scripts/verify-west-foundation.sh");

type RunOptions = {
  network?: string;
  networkIdentity?: string;
  invalidNat?: boolean;
  invalidSql?: boolean;
  externalNodeIp?: boolean;
  invalidSmsChannel?: boolean;
  execFailures?: number;
  execMaxAttempts?: number;
};

function executable(file: string, source: string): void {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function runVerifier(options: RunOptions = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-west-foundation-verifier-"));
  const execCountFile = path.join(temp, "exec-count");
  writeFileSync(execCountFile, "0\n");

  executable(path.join(temp, "gcloud"), `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "container clusters describe "*)
    printf '{"network":"%s","networkConfig":{"network":"%s"},"controlPlaneEndpointsConfig":{"dnsEndpointConfig":{"allowExternalTraffic":true,"enableK8sCertsViaDns":false,"enableK8sTokensViaDns":false},"ipEndpointsConfig":{"enabled":false}},"privateClusterConfig":{"enablePrivateNodes":true}}\n' "$FAKE_NETWORK" "$FAKE_NETWORK_IDENTITY"
    ;;
  "container clusters get-credentials "*) ;;
  "compute routers nats describe "*)
    if [[ "$FAKE_INVALID_NAT" == "true" ]]; then
      printf '%s\n' '{"enableDynamicPortAllocation":false}'
    else
      printf '%s\n' '{"enableDynamicPortAllocation":true,"enableEndpointIndependentMapping":false,"minPortsPerVm":64,"maxPortsPerVm":2048,"natIpAllocateOption":"AUTO_ONLY","sourceSubnetworkIpRangesToNat":"LIST_OF_SUBNETWORKS","subnetworks":[{},{}]}'
    fi
    ;;
  "sql instances describe "*)
    if [[ "$FAKE_INVALID_SQL" == "true" ]]; then
      printf '%s\n' '{"region":"us-west1","settings":{"backupConfiguration":{"enabled":false}}}'
    else
      printf '%s\n' '{"region":"us-west1","settings":{"backupConfiguration":{"enabled":true,"pointInTimeRecoveryEnabled":true,"transactionLogRetentionDays":7,"backupRetentionSettings":{"retainedBackups":7}},"retainBackupsOnDelete":true,"deletionProtectionEnabled":true,"ipConfiguration":{"ipv4Enabled":false,"privateNetwork":"projects/octogee/global/networks/octogee-west"}},"ipAddresses":[{"type":"PRIVATE"}]}'
    fi
    ;;
  "beta monitoring channels list "*)
    if [[ "$*" == *'type="sms"'* && "$FAKE_INVALID_SMS_CHANNEL" == "true" ]]; then
      printf '%s\n' '[]'
    elif [[ "$*" == *'type="sms"'* ]]; then
      printf '%s\n' '[{"displayName":"Octogee Ops","type":"sms","enabled":true,"verificationStatus":"VERIFIED"}]'
    else
      printf '%s\n' '[{"type":"email","enabled":true,"verificationStatus":"VERIFIED"}]'
    fi
    ;;
  *)
    printf 'unexpected gcloud call: %s\n' "$*" >&2
    exit 2
    ;;
esac
`);

  executable(path.join(temp, "kubectl"), `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "cluster-info "*|"delete pod "*|"run octogee-west-foundation-smoke "*|"wait "*) ;;
  "exec "*)
    if [[ " $* " != *" --request-timeout=45s "* ]]; then
      printf '%s\n' 'kubectl exec requires a bounded request timeout' >&2
      exit 2
    fi
    count="$(cat "$FAKE_EXEC_COUNT_FILE")"
    if (( count < FAKE_EXEC_FAILURES )); then
      printf '%s\n' "$((count + 1))" >"$FAKE_EXEC_COUNT_FILE"
      printf '%s\n' 'No agent available' >&2
      exit 1
    fi
    ;;
  "get pod octogee-west-foundation-smoke "*) printf '%s' 'gk3-node-1' ;;
  "get node gk3-node-1 "*)
    if [[ "$FAKE_EXTERNAL_NODE_IP" == "true" ]]; then
      printf '%s\n' '{"status":{"addresses":[{"type":"InternalIP"},{"type":"ExternalIP"}]}}'
    else
      printf '%s\n' '{"status":{"addresses":[{"type":"InternalIP"}]}}'
    fi
    ;;
  *)
    printf 'unexpected kubectl call: %s\n' "$*" >&2
    exit 2
    ;;
esac
`);

  const result = spawnSync("bash", [script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_NETWORK: options.network ?? "octogee-west",
      FAKE_NETWORK_IDENTITY: options.networkIdentity ?? "projects/octogee/global/networks/octogee-west",
      FAKE_INVALID_NAT: options.invalidNat ? "true" : "false",
      FAKE_INVALID_SQL: options.invalidSql ? "true" : "false",
      FAKE_EXTERNAL_NODE_IP: options.externalNodeIp ? "true" : "false",
      FAKE_INVALID_SMS_CHANNEL: options.invalidSmsChannel ? "true" : "false",
      FAKE_EXEC_FAILURES: String(options.execFailures ?? 0),
      FAKE_EXEC_COUNT_FILE: execCountFile,
      WEST_SMOKE_EXEC_MAX_ATTEMPTS: String(options.execMaxAttempts ?? 3),
      WEST_SMOKE_EXEC_RETRY_SECONDS: "0",
    },
    encoding: "utf8",
  });
  rmSync(temp, { recursive: true, force: true });
  return result;
}

describe("WEST foundation runtime verifier", () => {
  it.each([
    "octogee-west",
    "projects/octogee/global/networks/octogee-west",
  ])("accepts the exact GKE network identity %s", (network) => {
    const result = runVerifier({ network });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("WEST foundation verified");
  });

  it("names an invalid GKE cluster invariant", () => {
    const result = runVerifier({ network: "projects/other-project/global/networks/octogee-west" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GKE cluster foundation invariants failed");
  });

  it("rejects a same-named GKE network owned by another project", () => {
    const result = runVerifier({
      network: "octogee-west",
      networkIdentity: "projects/other-project/global/networks/octogee-west",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GKE cluster foundation invariants failed");
  });

  it("names an invalid Cloud NAT invariant", () => {
    const result = runVerifier({ invalidNat: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cloud NAT foundation invariants failed");
  });

  it("names an invalid Cloud SQL invariant", () => {
    const result = runVerifier({ invalidSql: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cloud SQL foundation invariants failed");
  });

  it("names an external GKE node address", () => {
    const result = runVerifier({ externalNodeIp: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GKE smoke node has an external IP address");
  });

  it("requires the verified Octogee Ops SMS channel", () => {
    const result = runVerifier({ invalidSmsChannel: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Verify the Octogee Ops SMS Cloud Monitoring notification channel");
  });

  it("retries transient new-node exec tunnel failures", () => {
    const result = runVerifier({ execFailures: 2, execMaxAttempts: 3 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("WEST smoke exec attempt 2 of 3 failed");
    expect(result.stdout).toContain("WEST foundation verified");
  });

  it("names a smoke egress failure after the bounded exec retry", () => {
    const result = runVerifier({ execFailures: 3, execMaxAttempts: 2 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("WEST foundation smoke egress failed after 2 attempts");
  });
});
