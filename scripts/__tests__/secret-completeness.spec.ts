import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helperPath = path.join(repoRoot, "scripts/lib/secret-completeness.sh");
const setupSecretsPath = path.join(repoRoot, "scripts/setup-secrets.sh");
const teardownEnvPath = path.join(repoRoot, "scripts/teardown-env.sh");
const provisionNamespacePath = path.join(repoRoot, "scripts/provision-namespace.sh");
const rotateSecretPath = path.join(repoRoot, "scripts/rotate-secret.sh");
const setupMonitoringPath = path.join(repoRoot, "scripts/setup-monitoring.sh");

function runSummary(lifecycle: string, requirement: string, value: string, phase = "launch"): {
  status: number | null;
  stdout: string;
} {
  const script = [
    `source ${JSON.stringify(helperPath)}`,
    "RED=''; GREEN=''; YELLOW=''; NC=''",
    "OCTOGEE_SECRET_COMPLETENESS_FAILURES=0",
    `octogee_secret_completeness_entry 'example / value' ${JSON.stringify(value)} ${JSON.stringify(requirement)} ${JSON.stringify(lifecycle)} ${JSON.stringify(phase)}`,
    'printf "failures=%s\\n" "$OCTOGEE_SECRET_COMPLETENESS_FAILURES"',
  ].join("\n");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  return { status: result.status, stdout: result.stdout };
}

describe("secret completeness", () => {
  it("records missing required launch inputs as failures", () => {
    const result = runSummary("active", "required", "");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("example / value — MISSING");
    expect(result.stdout).toContain("failures=1");
  });

  it("reports disabled providers as skipped instead of failed", () => {
    const result = runSummary("active", "disabled", "");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("example / value — skipped (provider disabled)");
    expect(result.stdout).toContain("failures=0");
  });

  it("derives OAuth completeness from product provider availability", () => {
    const script = [
      `source ${JSON.stringify(helperPath)}`,
      "printf '%s %s %s' \"$(octogee_oauth_provider_requirement github)\" \"$(octogee_oauth_provider_requirement google)\" \"$(octogee_oauth_provider_requirement microsoft)\"",
    ].join("\n");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("launch launch disabled");
  });

  it("requires launch values only for active or candidate deployment targets", () => {
    const active = runSummary("active", "launch", "");
    const frozen = runSummary("frozen", "launch", "");

    expect(active.stdout).toContain("failures=1");
    expect(frozen.stdout).toContain("example / value — skipped (target is not launchable)");
    expect(frozen.stdout).toContain("failures=0");
  });

  it("defers service-generated values during bootstrap and requires them for launch", () => {
    const bootstrap = runSummary("active", "post-bootstrap", "", "bootstrap");
    const launch = runSummary("active", "post-bootstrap", "", "launch");

    expect(bootstrap.stdout).toContain("example / value — skipped (created after service bootstrap)");
    expect(bootstrap.stdout).toContain("failures=0");
    expect(launch.stdout).toContain("example / value — MISSING");
    expect(launch.stdout).toContain("failures=1");
  });

  it("makes both canonical secret phases explicit and materializes after Gitea", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");
    const teardown = readFileSync(teardownEnvPath, "utf-8");
    const provision = readFileSync(provisionNamespacePath, "utf-8");

    expect(setup).toContain("--phase=bootstrap|launch");
    expect(teardown).toContain("--phase=bootstrap");
    expect(teardown).toContain("--phase=launch");
    expect(provision.indexOf("setup-mattermost.sh")).toBeLessThan(provision.indexOf("setup-gitea.sh"));
    expect(provision.indexOf("setup-gitea.sh")).toBeLessThan(
      provision.indexOf('setup-secrets.sh" --env=custom --namespace="$NAMESPACE" --yes --deployment-target="$TARGET_ID" --phase=launch'),
    );
  });

  it("keeps the retired monitoring secret out of canonical materialization and retains only live function secrets", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");
    const rotate = readFileSync(rotateSecretPath, "utf-8");
    const monitoring = readFileSync(setupMonitoringPath, "utf-8");

    expect(setup).not.toContain("discord-ops-webhook");
    expect(setup).not.toContain("-n monitoring");
    expect(rotate).not.toContain("kubectl create secret generic discord-ops-webhook");
    expect(monitoring).not.toContain("DISCORD_OPS_WEBHOOK_URL");
    expect(monitoring).not.toContain("Managed Alertmanager (Discord)");
    expect(setup).toContain("DISCORD_OPS_WEBHOOK_URL");
    expect(setup).toContain("SOCIAL_NOTIFICATION_BEARER_TOKEN");
    for (const staleSecret of [
      "GITEA_TOKEN",
      "MICROSOFT_CLIENT_ID",
      "DISCORD_MAC_TOKEN",
      "DISCORD_COACH_TOKEN",
      "DISCORD_BOT_APP_ID",
      "DISCORD_CLIENT_SECRET",
      "OCTOGEE_GUILD_ID",
    ]) {
      expect(setup).not.toContain(`  ${staleSecret} \\\\`);
    }
  });

  it("exits before the all-complete banner whenever launch completeness has failures", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");
    const incomplete = setup.indexOf("Secret setup incomplete");
    const banner = setup.indexOf("All launch secrets materialized");

    expect(incomplete).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(incomplete);
    expect(setup.slice(incomplete, banner)).toContain("exit 1");
  });
});
