

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");
const entrypoint = readFileSync(
  path.join(repoRoot, "infra/gateway/entrypoint.sh"),
  "utf8",
);
const fleetController = readFileSync(
  path.join(repoRoot, "scripts/entrypoints/fleet-controller.ts"),
  "utf8",
);
const gatewayDeployment = readFileSync(
  path.join(repoRoot, "helm/octogee-gateway/templates/deployment.yaml"),
  "utf8",
);
const gatewayValues = readFileSync(
  path.join(repoRoot, "helm/octogee-gateway/values.yaml"),
  "utf8",
);

describe("infra/gateway/entrypoint.sh — no permanent platform persona", () => {
  it("does not bootstrap a bot, PAT, operator agent id, or ops workspace", () => {
    expect(entrypoint).not.toMatch(/bootstrap-mac-ops|MAC_OPS|MM_BOT_USERNAME/);
    expect(entrypoint).not.toMatch(/OPERATOR_AGENT_(?:ID|SLUG)|octogee-ops-/);
    expect(entrypoint).not.toMatch(/workspace\/ops/);
  });
});

describe("infra/gateway/entrypoint.sh — identity-pure boot (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
  it("consults no roll, fleet, or boot-transaction state anywhere in boot", () => {
    expect(entrypoint).not.toMatch(/system-config-roll-boot/);
    expect(entrypoint).not.toMatch(/system-config-boot-transaction/);
    expect(entrypoint).not.toMatch(/system-config-status-server/);
    expect(entrypoint).not.toMatch(/SYSTEM_CONFIG_BOOT_ROLE/);
    expect(entrypoint).not.toMatch(/boot-accepted/);
    expect(entrypoint).not.toMatch(/source-frozen|target-candidate/);
    expect(entrypoint).not.toMatch(/GATEWAY_REVISION_ID/);
  });

  it("restores owner-bound runtime system_config before OpenClaw starts", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    expect(restoreIdx).toBeGreaterThan(-1);
    const openclawStartIdx = entrypoint.indexOf("openclaw gateway run");
    expect(openclawStartIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeLessThan(openclawStartIdx);
  });

  it("hydrates the configured builder credential after restore and before OpenClaw", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const hydrateIdx = entrypoint.indexOf("configured-builder-bootstrap.ts");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    expect(hydrateIdx).toBeGreaterThan(restoreIdx);
    expect(openclawIdx).toBeGreaterThan(hydrateIdx);
  });

  it("quarantines persisted Barn customer cron host-execution rows before OpenClaw starts", () => {
    const quarantineIdx = entrypoint.indexOf("quarantine-customer-cron-jobs.mjs");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    expect(quarantineIdx).toBeGreaterThan(-1);
    expect(quarantineIdx).toBeLessThan(openclawIdx);
    const block = entrypoint.slice(entrypoint.indexOf("if [", quarantineIdx), openclawIdx);
    expect(block).toMatch(/GATEWAY_CLASS_EFFECTIVE[^\n]*= "shared"/);
    expect(block).toMatch(/node "\$CUSTOMER_CRON_QUARANTINE"/);
  });

  it("gates system_config restore on non-shared class and explicit builder slug", () => {
    const restoreBlock = entrypoint.slice(
      entrypoint.indexOf("Owner-bound runtime system_config restore"),
      entrypoint.indexOf("apply-gateway-class-policy.mjs"),
    );
    expect(restoreBlock).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(restoreBlock).toMatch(/!= "shared"/);
    expect(restoreBlock).toMatch(/\$\{BUILDER_SLUG\}/);
  });

  it("reads the Builder identity from the broker before any owner-scoped pre-boot step", () => {
    const identityIdx = entrypoint.indexOf("/octogee/scripts/entrypoints/builder-identity.ts");
    const identityBlock = entrypoint.slice(entrypoint.indexOf("# ── Builder identity"), entrypoint.indexOf('GIT_SSH_HOST="'));
    expect(identityIdx).toBeGreaterThan(-1);
    expect(identityIdx).toBeLessThan(entrypoint.indexOf("IdentityFile"));
    expect(identityIdx).toBeLessThan(entrypoint.indexOf("system-config-restore.ts"));
    expect(identityBlock).toMatch(/BUILDER_SLUG=\$\("\$TSX" \/octogee\/scripts\/entrypoints\/builder-identity\.ts\)/);
    expect(identityBlock).toMatch(/identity_status" -eq 2[\s\S]*?exit 2/);
    expect(identityBlock).toMatch(/sleep 5/);
    expect(entrypoint).not.toMatch(/GATEWAY_BUILDER_SLUG|GATEWAY_OWNER_UID/);
    expect(entrypoint).not.toMatch(/UNOWNED_OPERATOR_PREWARM/);
  });

  it("retries restore and hydration against the data plane without exiting", () => {
    expect(entrypoint).toMatch(/until "\$TSX" \/octogee\/scripts\/entrypoints\/system-config-restore\.ts/);
    expect(entrypoint).toMatch(/until "\$TSX" \/octogee\/scripts\/entrypoints\/configured-builder-bootstrap\.ts/);
    const retryIdx = entrypoint.indexOf("until \"$TSX\" /octogee/scripts/entrypoints/system-config-restore.ts");
    const retryBlock = entrypoint.slice(retryIdx, entrypoint.indexOf("else", retryIdx));
    expect(retryBlock).toMatch(/sleep 5/);
    expect(retryBlock).not.toMatch(/exit\s+[1-9]/);
  });

  it("restores builder-global SQLite before OpenClaw and supervises its periodic snapshotter", () => {
    const hydrateIdx = entrypoint.indexOf("configured-builder-bootstrap.ts");
    const runtimeRestoreIdx = entrypoint.indexOf("builder-runtime-state-restore.ts");
    const supervisorIdx = entrypoint.indexOf("supervise_runner surge-openclaw-supervisor");
    const snapshotterIdx = entrypoint.indexOf("builder-runtime-state-snapshotter.ts");

    expect(runtimeRestoreIdx).toBeGreaterThan(hydrateIdx);
    expect(runtimeRestoreIdx).toBeLessThan(supervisorIdx);
    expect(snapshotterIdx).toBeGreaterThan(supervisorIdx);
    expect(entrypoint.slice(entrypoint.lastIndexOf("\n", snapshotterIdx), snapshotterIdx))
      .toMatch(/\$BUILDER_OVERLAY_GATE "\$TSX"/);
  });

  it("starts the probed runner plane only after the actual OpenClaw process", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    const fleetControllerIdx = entrypoint.indexOf("supervise_runner fleet-controller");

    expect(fleetControllerIdx).toBeGreaterThan(restoreIdx);
    expect(fleetControllerIdx).toBeGreaterThan(openclawIdx);
    expect(gatewayDeployment).toMatch(/startupProbe:[\s\S]*?path:\s*\/startup-ready[\s\S]*?port:\s*\{\{ \.Values\.env\.fleetControllerPort/);
    expect(gatewayValues).toMatch(
      /startup:\s+initialDelaySeconds:\s*15\s+periodSeconds:\s*10\s+failureThreshold:\s*60/,
    );
  });

  it("exposes image-staged plugin roots beside the nested durable config", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const hydrateIdx = entrypoint.indexOf("configured-builder-bootstrap.ts");
    const pluginRootsIdx = entrypoint.indexOf(
      "Expose staged plugin roots beside the active config",
    );
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");

    expect(pluginRootsIdx).toBeGreaterThan(restoreIdx);
    expect(pluginRootsIdx).toBeGreaterThan(hydrateIdx);
    expect(pluginRootsIdx).toBeLessThan(watcherIdx);
    expect(pluginRootsIdx).toBeLessThan(openclawIdx);
    expect(entrypoint).toMatch(/for runtime_name in npm extensions/);
    expect(entrypoint).toMatch(
      /ln -s "\$OPENCLAW_DIR\/\$runtime_name" "\$runtime_root"/,
    );
    expect(entrypoint).toMatch(/\.git\/info\/exclude/);
    expect(entrypoint).toMatch(/git -C "\$OPENCLAW_CONFIG_DIR" ls-files/);
    expect(entrypoint).toMatch(/mktemp -d/);
    expect(entrypoint).toMatch(/mv "\$runtime_root" "\$RUNTIME_ROOT_QUARANTINE\//);
    expect(entrypoint).not.toMatch(/rm -rf "\$OPENCLAW_CONFIG_DIR\//);
  });

  it("keeps one supervised config watcher for Builder gateways, held until the claim overlay applies", () => {
    expect(entrypoint).toMatch(/supervise_runner\s+system-config-watch\s+5000\s+\$BUILDER_OVERLAY_GATE\s+"\$TSX"/);
    expect(entrypoint.match(/supervise_runner\s+system-config-watch/g)).toHaveLength(1);
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const guard = entrypoint.slice(entrypoint.lastIndexOf("if [", watcherIdx), watcherIdx);
    expect(guard).toMatch(/"\$GATEWAY_CLASS_EFFECTIVE" = "builder"/);
  });

  it("boots an unclaimed standby with the standby config and no customer pre-boot or runners", () => {
    const identityBlock = entrypoint.slice(entrypoint.indexOf("# ── Builder identity"), entrypoint.indexOf('GIT_SSH_HOST="'));
    expect(identityBlock).toMatch(/unset OCTOGEE_BUILDER_STANDBY_BOOT/);
    expect(identityBlock).toMatch(/identity_status" -eq 3 \]; then\s+export OCTOGEE_BUILDER_STANDBY_BOOT=1\s+break/);
    expect(identityBlock).toMatch(/BUILDER_CLAIMED=1/);
    const standbyIdx = entrypoint.indexOf("standby-builder-config.ts");
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    expect(standbyIdx).toBeGreaterThan(-1);
    expect(standbyIdx).toBeLessThan(restoreIdx);
    expect(entrypoint.slice(standbyIdx, restoreIdx)).toMatch(/elif \[ "\$GATEWAY_CLASS_EFFECTIVE" != "shared" \]/);
    expect(entrypoint.slice(entrypoint.lastIndexOf("if [", standbyIdx), standbyIdx))
      .toMatch(/OCTOGEE_BUILDER_STANDBY_BOOT:-0\}" = 1/);
    for (const claimedOnly of ["clean-builder-project-placeholders.ts", "IdentityFile", "mark-overlay-applied"]) {
      const idx = entrypoint.indexOf(claimedOnly);
      expect(entrypoint.slice(entrypoint.lastIndexOf("if [", idx), idx), claimedOnly).toMatch(/"\$BUILDER_CLAIMED" = 1/);
    }
    const gateIdx = entrypoint.indexOf('BUILDER_OVERLAY_GATE="$TSX /octogee/scripts/entrypoints/builder-claim.ts await-overlay"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(entrypoint.slice(entrypoint.lastIndexOf("if [", gateIdx), gateIdx)).toMatch(/OCTOGEE_BUILDER_STANDBY_BOOT:-0\}" = 1/);
    for (const overlayRunner of [
      "github-cli-auth-hydrate.ts",
      "builder-runtime-state-snapshotter.ts",
      "builder-toolchain-hydrator.ts",
      "system-config-watch.ts",
    ]) {
      const idx = entrypoint.indexOf(`/octogee/scripts/entrypoints/${overlayRunner}`);
      expect(entrypoint.slice(entrypoint.lastIndexOf("\n", idx), idx), overlayRunner).toMatch(/\$BUILDER_OVERLAY_GATE "\$TSX" $/);
    }
  });

  it("stamps a claimed boot's overlay after its config is composed and before OpenClaw starts", () => {
    const stampIdx = entrypoint.indexOf("builder-claim.ts mark-overlay-applied");
    expect(stampIdx).toBeGreaterThan(entrypoint.lastIndexOf('node "$CLASS_POLICY"'));
    expect(stampIdx).toBeGreaterThan(entrypoint.indexOf("ensure-configured-agent-runtime-dirs.ts"));
    expect(stampIdx).toBeLessThan(entrypoint.indexOf("supervise_runner surge-openclaw-supervisor"));
  });

  it("starts OpenClaw before the durable watcher and auxiliary runners", () => {
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const fleetIdx = entrypoint.indexOf("supervise_runner fleet-controller");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    expect(watcherIdx).toBeGreaterThan(openclawIdx);
    expect(fleetIdx).toBeGreaterThan(openclawIdx);
    expect(entrypoint).toContain("OpenClaw gateway healthy; starting auxiliary runners");
  });

  it("delegates the Builder OpenClaw process to the hold-capable surge supervisor", () => {
    const supervisorIdx = entrypoint.indexOf("supervise_runner surge-openclaw-supervisor");
    const directStartIdx = entrypoint.indexOf("openclaw gateway run");
    expect(supervisorIdx).toBeGreaterThan(-1);
    const branchIdx = entrypoint.lastIndexOf('if [ "$GATEWAY_CLASS_EFFECTIVE" = "builder" ]; then', supervisorIdx);
    expect(branchIdx).toBeGreaterThan(-1);
    const nearestGuard = entrypoint.lastIndexOf("if [", supervisorIdx);
    expect(nearestGuard, "standbys start the supervisor too").toBe(branchIdx);
    expect(supervisorIdx).toBeLessThan(directStartIdx);
    const builderBranch = entrypoint.slice(supervisorIdx, directStartIdx);
    expect(builderBranch).not.toMatch(/until curl/);
    expect(entrypoint).not.toContain("OPENCLAW_SKIP_CHANNELS");
  });

  it("does not launch OpenClaw validation, Doctor, checkpoint, or session migration CLIs during boot", () => {
    expect(entrypoint).not.toContain("openclaw config validate");
    expect(entrypoint).not.toContain("openclaw secrets audit");
    expect(entrypoint).not.toContain("openclaw doctor");
    expect(entrypoint).not.toContain("system-config-checkpoint.ts");
    expect(entrypoint).not.toContain("OPENCLAW_SESSION_SQLITE_MIGRATION_MODE");
  });

  it("hardens the active config unconditionally — no role-dependent permission arms", () => {
    const hardenBlock = entrypoint.slice(
      entrypoint.indexOf("# ── Harden file permissions"),
      entrypoint.indexOf("# ── Project immutable plugin extensions"),
    );
    expect(hardenBlock).toMatch(/chmod 600 "\$OPENCLAW_CONFIG_PATH"/);
    expect(hardenBlock).not.toMatch(/SYSTEM_CONFIG_BOOT_ROLE/);
    expect(hardenBlock).not.toMatch(/FATAL/);
  });

  it("clears inherited directory special bits before OpenClaw creates private state", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-private-root-"));
    const stateDir = path.join(dir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const hardenBlock = entrypoint.slice(
      entrypoint.indexOf("# ── Harden file permissions"),
      entrypoint.indexOf("# ── Project immutable plugin extensions"),
    );
    try {
      mkdirSync(stateDir);
      chmodSync(stateDir, 0o2700);
      writeFileSync(configPath, "{}", { mode: 0o644 });
      const run = spawnSync("sh", ["-c", `log() { :; }\n${hardenBlock}`], {
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        timeout: 5_000,
      });
      expect(run.error).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(statSync(stateDir).mode & 0o7777).toBe(0o700);
      expect(statSync(configPath).mode & 0o7777).toBe(0o600);
      const controlDir = path.join(stateDir, "control");
      mkdirSync(controlDir, { mode: 0o700 });
      expect(statSync(controlDir).mode & 0o7777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs pre-boot env patches without requiring the removed Firebase SA key", () => {
    const prebootBlock = entrypoint.slice(
      entrypoint.indexOf("Pre-boot: sync env/runtime config"),
      entrypoint.indexOf("Start OpenClaw before auxiliary runners"),
    );
    expect(prebootBlock).toMatch(/OPENCLAW_CONFIG_PATH/);
    expect(prebootBlock).not.toMatch(/SA_KEY_PATH/);
    expect(prebootBlock).not.toMatch(/octogee-test-sa-key\.json/);
  });
});

describe("infra/gateway/entrypoint.sh — Builder-only customer runtime", () => {
  it("rejects retired customer gateway classes and profiles", () => {
    expect(entrypoint).toMatch(/shared\|builder/);
    expect(entrypoint).toMatch(/GATEWAY_CLASS must be shared or builder/);
    expect(entrypoint).toMatch(/GATEWAY_PROFILE must be standard or builder/);
    expect(entrypoint).not.toMatch(/shared\|builder\|operator|standard\|builder\|operator/);
  });

  it("loads the native-agent bootstrap only for Builder gateways without weakening Agent policy", () => {
    const stamperRegion = entrypoint.match(
      /[\s\S]{0,200}stamp-claude-first-run\.mjs[\s\S]{0,250}/,
    )?.[0];
    expect(stamperRegion).toMatch(/GATEWAY_CLASS_EFFECTIVE[\s\S]*= "builder"[\s\S]*-f/);
    expect(entrypoint).not.toMatch(/apply-builder-codex-sandbox\.mjs/);
    expect(entrypoint).not.toMatch(/apply-operator-codex-sandbox\.mjs/);
    expect(entrypoint).not.toMatch(/operator\.env/);
  });

  it("converges Builder GitHub auth and defers native runtime stamping", () => {
    const healthyIdx = entrypoint.indexOf("OpenClaw gateway healthy");
    const fleetIdx = entrypoint.indexOf("supervise_runner fleet-controller");
    const stamperIdx = entrypoint.indexOf("stamp-claude-first-run.mjs");
    expect(entrypoint).toContain("supervise_runner github-cli-auth");
    expect(entrypoint).toContain("github-cli-auth-hydrate.ts");
    expect(fleetIdx).toBeGreaterThan(healthyIdx);
    expect(stamperIdx).toBeGreaterThan(healthyIdx);
  });
});

describe("infra/gateway/entrypoint.sh — supervised in-pod runners + metrics", () => {
  it("routes only non-code auxiliary runners through supervise-runner on customer gateways", () => {
    const runners: Record<string, string> = {
      "fleet-controller": "5000",
      "byosub-syncback": "30000",
      "builder-toolchain-hydrator": "30000",
    };
    for (const [runner, restartDelayMs] of Object.entries(runners)) {
      expect(entrypoint).toMatch(
        new RegExp(`supervise_runner\\s+${runner}\\s+${restartDelayMs}\\b`),
      );
    }
  });

  it("does not start the Firebase-backed local provisioner in gateway pods", () => {
    expect(entrypoint).not.toMatch(/supervise_runner\s+provisioner\b/);
    expect(entrypoint).not.toMatch(/entrypoints\/local-provisioner\.ts/);
  });

  it("never starts site-build-api inside the credential-bearing gateway container", () => {
    expect(entrypoint).not.toMatch(/supervise_runner\s+site-build\b/);
    expect(entrypoint).toContain("site-build-api disabled");
  });

  it("never starts the retired in-gateway preview proxy", () => {
    expect(entrypoint).not.toMatch(/supervise_runner\s+preview-proxy\b/);
  });

  it("starts the always-on runner-metrics-exporter", () => {
    expect(entrypoint).toMatch(/runner-metrics-exporter\.ts/);
  });

  it("supervise_runner keeps a thin guard so a dead supervisor restarts", () => {
    const fnRegion = entrypoint.slice(
      entrypoint.indexOf("supervise_runner() {"),
      entrypoint.indexOf("supervise_runner fleet-controller"),
    );
    expect(fnRegion).toMatch(/while true/);
    expect(fnRegion).toMatch(/\$SUPERVISE/);
    expect(fnRegion).toMatch(/--restart-delay-ms=\$\{_restart_delay_ms\}/);
    expect(entrypoint).toMatch(/SUPERVISE=[^\n]*supervise-runner\.ts/);
  });

  it("forwards SIGTERM to the whole process group so a pod restart is clean", () => {
    const shutdownIdx = entrypoint.indexOf("shutdown() {");
    const trapIdx = entrypoint.indexOf("trap shutdown TERM INT");
    const fleetIdx = entrypoint.indexOf("supervise_runner fleet-controller");
    const shutdown = entrypoint.slice(shutdownIdx, trapIdx);
    expect(shutdown).toMatch(/kill -TERM 0/);
    expect(shutdown).toMatch(/exit 0/);
    expect(trapIdx).toBeLessThan(fleetIdx);
    expect(entrypoint.match(/trap shutdown TERM INT/g)).toHaveLength(1);
    expect(gatewayDeployment).toMatch(/kind:\s*Deployment/);
    expect(gatewayDeployment).not.toMatch(/restartPolicy:\s*(?:Never|OnFailure)/);
  });
});

describe("infra/gateway/entrypoint.sh — a dead OpenClaw process exits the shared container", () => {
  it("waits on the OpenClaw PID after the runners start and leaves Builder pods on the supervisor", () => {
    const tail = entrypoint.slice(entrypoint.indexOf("supervise_runner byosub-syncback"));
    expect(tail).toMatch(/if \[ "\$GATEWAY_CLASS_EFFECTIVE" = "shared" \]; then\s+exit_when_openclaw_dies "\$OPENCLAW_PID"\s+else\s+wait\s+fi/);
    expect(entrypoint.slice(0, entrypoint.indexOf("supervise_runner fleet-controller")))
      .toContain("exit_when_openclaw_dies() {");
  });

  it("runs the same pre-stop flush the kubelet path runs before exiting", () => {
    expect(entrypoint).toMatch(/PRESTOP_FLUSH="timeout 10s \$TSX \/octogee\/scripts\/entrypoints\/prestop-flush\.ts"/);
    expect(exitWhenOpenClawDiesFunction()).toMatch(/\$PRESTOP_FLUSH \|\| log/);
    expect(gatewayDeployment).toMatch(/timeout \{\{ \.Values\.preStopFlush\.timeoutSeconds \| default 10 \}\}s [^\n]*prestop-flush\.ts/);
  });

  describe("exit_when_openclaw_dies (POSIX sh harness)", () => {
    it("exits the container with OpenClaw's status after logging FATAL and flushing", () => {
      const run = runExitWhenOpenClawDies({ childExit: "kill -ABRT $$", flushExit: 0 });
      expect(run.status).toBe(134);
      expect(run.stdout).toContain("FATAL: OpenClaw gateway process exited (status=134)");
      expect(run.stdout).toContain("exiting container so Kubernetes restarts it");
      expect(run.stdout).toContain("flush-ran");
      expect(run.stdout.indexOf("FATAL")).toBeLessThan(run.stdout.indexOf("flush-ran"));
    });

    it("never exits 0 on a clean OpenClaw exit, so Kubernetes still records a failure", () => {
      const run = runExitWhenOpenClawDies({ childExit: "exit 0", flushExit: 0 });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("FATAL: OpenClaw gateway process exited (status=1)");
    });

    it("logs a failed flush and still exits with OpenClaw's status", () => {
      const run = runExitWhenOpenClawDies({ childExit: "exit 7", flushExit: 3 });
      expect(run.status).toBe(7);
      expect(run.stdout).toContain("prestop-flush failed (exit 3)");
    });
  });
});

function exitWhenOpenClawDiesFunction(): string {
  const start = entrypoint.indexOf("exit_when_openclaw_dies() {");
  expect(start).toBeGreaterThan(-1);
  const end = entrypoint.indexOf("\n}\n", start);
  return entrypoint.slice(start, end + 3);
}

function runExitWhenOpenClawDies(input: { childExit: string; flushExit: number }) {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-exit-"));
  const flush = path.join(dir, "flush.sh");
  writeFileSync(flush, `#!/bin/sh\necho flush-ran\nexit ${input.flushExit}\n`, { mode: 0o755 });
  const harness = path.join(dir, "harness.sh");
  writeFileSync(
    harness,
    [
      "#!/bin/sh",
      "set -e",
      'log() { echo "[entrypoint] $*"; }',
      `PRESTOP_FLUSH="${flush}"`,
      exitWhenOpenClawDiesFunction(),
      `sh -c '${input.childExit}' &`,
      "OPENCLAW_PID=$!",
      "sleep 0.2",
      'exit_when_openclaw_dies "$OPENCLAW_PID"',
      'echo "unreachable"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", 'set -m; sh "$1" & wait $!', "_", harness], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.stdout).not.toContain("unreachable");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("scripts/entrypoints/fleet-controller.ts — db-less local persistence loops", () => {

  it("keeps brokered GCS blob sync wired into the live gateway controller", () => {
    expect(fleetController).toMatch(/blobSyncAllWithOptions/);
    expect(fleetController).toMatch(/createBrokeredBlobStore/);
  });

  it("publishes durable-config runtime health to the broker in place of the retired status server", () => {
    expect(fleetController).toMatch(/createSystemConfigStatusPublisher/);
    expect(fleetController).toMatch(/refreshSystemConfigRuntimeHealth/);
    expect(fleetController).toMatch(/recordSystemConfigStatus/);
  });
});

describe("per-user control identity — pod token stays out of the OpenClaw process", () => {
  const supervisor = readFileSync(
    path.join(repoRoot, "scripts/entrypoints/surge-openclaw-supervisor.ts"),
    "utf8",
  );

  it("exports the in-pod relay credential under its own name before OpenClaw starts", () => {
    const relayExport = entrypoint.indexOf('export OCTOGEE_POD_RELAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN"');
    const openClawStart = entrypoint.indexOf("openclaw gateway run");
    expect(relayExport).toBeGreaterThan(-1);
    expect(relayExport).toBeLessThan(openClawStart);
  });

  it("spawns the Builder OpenClaw process through the identity-aware environment filter", () => {
    expect(supervisor).toMatch(/env:\s*openClawProcessEnv\(\)/);
    expect(supervisor).toMatch(/OPENCLAW_GATEWAY_TOKEN: podToken, \.\.\.rest/);
  });

  it("threads the control identity to both gateway containers from one chart value", () => {
    expect(gatewayDeployment).toMatch(/\$controlIdentity := ternary/);
    expect(gatewayDeployment.match(/name:\s*OPENCLAW_CONTROL_IDENTITY/g)).toHaveLength(2);
    expect(gatewayValues).toMatch(/controlIdentity:\s*shared-operator/);
  });
});
