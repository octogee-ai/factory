

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
const repairContainerRestart = readFileSync(
  path.join(repoRoot, "scripts/lib/repair-container-restart.ts"),
  "utf8",
);
const gatewayDeployment = readFileSync(
  path.join(repoRoot, "helm/octogee-gateway/templates/deployment.yaml"),
  "utf8",
);

describe("infra/gateway/entrypoint.sh — no permanent platform persona", () => {
  it("does not bootstrap a bot, PAT, operator agent id, or ops workspace", () => {
    expect(entrypoint).not.toMatch(/bootstrap-mac-ops|MAC_OPS|MM_BOT_USERNAME/);
    expect(entrypoint).not.toMatch(/OPERATOR_AGENT_(?:ID|SLUG)|octogee-ops-/);
    expect(entrypoint).not.toMatch(/workspace\/ops/);
  });
});

describe("infra/gateway/entrypoint.sh — system_config restore", () => {
  it("restores dedicated gateway system_config before OpenClaw starts", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    expect(restoreIdx).toBeGreaterThan(-1);
    const openclawStartIdx = entrypoint.indexOf("openclaw gateway run");
    expect(openclawStartIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeLessThan(openclawStartIdx);
  });

  it("hydrates the configured builder credential after restore and before config repair", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const hydrateIdx = entrypoint.indexOf("configured-builder-bootstrap.ts");
    const doctorIdx = entrypoint.indexOf("run_openclaw_doctor");
    expect(hydrateIdx).toBeGreaterThan(restoreIdx);
    expect(doctorIdx).toBeGreaterThan(hydrateIdx);
  });

  it("gates system_config restore on non-shared class and explicit builder slug", () => {
    const restoreBlock = entrypoint.slice(
      entrypoint.indexOf("Dedicated gateway system_config restore"),
      entrypoint.indexOf("apply-gateway-class-policy.mjs"),
    );
    expect(restoreBlock).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(restoreBlock).toMatch(/!= "shared"/);
    expect(restoreBlock).toMatch(/GATEWAY_BUILDER_SLUG/);
  });

  it("makes the tracked system_config active and resolves its remote role before runtime boot", () => {
    expect(entrypoint).toMatch(
      /export OPENCLAW_CONFIG_PATH="\$OPENCLAW_DIR\/system_config\/openclaw\.json"/,
    );
    const restoreLine = entrypoint.split("\n").find((line) => line.includes("system-config-restore.ts"));
    expect(restoreLine).toBeTruthy();
    expect(entrypoint).toMatch(/until "\$TSX" \/octogee\/scripts\/entrypoints\/system-config-restore\.ts/);
    const statusIdx = entrypoint.indexOf("supervise_runner system-config-status");
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const roleIdx = entrypoint.indexOf("system-config-roll-boot.ts resolve");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    expect(statusIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeLessThan(restoreIdx);
    expect(roleIdx).toBeGreaterThan(restoreIdx);
    expect(openclawIdx).toBeGreaterThan(roleIdx);
    expect(entrypoint).not.toMatch(/gateway\.auth\.token re-synced/);
  });

  it("exposes image-staged plugin roots beside the nested durable config", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const hydrateIdx = entrypoint.indexOf("configured-builder-bootstrap.ts");
    const roleIdx = entrypoint.indexOf("system-config-roll-boot.ts resolve");
    const pluginRootsIdx = entrypoint.indexOf(
      "Expose staged plugin roots beside the active config",
    );
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");

    expect(pluginRootsIdx).toBeGreaterThan(restoreIdx);
    expect(pluginRootsIdx).toBeGreaterThan(hydrateIdx);
    expect(pluginRootsIdx).toBeLessThan(roleIdx);
    expect(pluginRootsIdx).toBeLessThan(watcherIdx);
    expect(pluginRootsIdx).toBeLessThan(openclawIdx);
    expect(entrypoint.slice(roleIdx)).not.toContain("OPENCLAW_CONFIG_DIR");
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

  it("starts a repair liveness/status server before isolated restore", () => {
    const statusIdx = entrypoint.indexOf("supervise_runner system-config-status");
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    expect(statusIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeLessThan(restoreIdx);
  });

  it("starts the entitled repair shell before restore under the boot transaction fence", () => {
    const configPathIdx = entrypoint.indexOf(
      'export OPENCLAW_CONFIG_PATH="$OPENCLAW_DIR/system_config/openclaw.json"',
    );
    const shellIdx = entrypoint.indexOf("supervise_runner builder-shell");
    const retryIdx = entrypoint.indexOf("until \"$TSX\" /octogee/scripts/entrypoints/system-config-restore.ts");
    const cleanupIdx = entrypoint.indexOf("system-config-boot-transaction.ts cleanup");
    const beginIdx = entrypoint.indexOf("\n  begin_system_config_boot_transaction", shellIdx);
    expect(configPathIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(configPathIdx);
    expect(cleanupIdx).toBeLessThan(shellIdx);
    expect(shellIdx).toBeLessThan(beginIdx);
    expect(beginIdx).toBeLessThan(retryIdx);
    const retryBlock = entrypoint.slice(retryIdx, entrypoint.indexOf("else", retryIdx));
    expect(retryBlock).toMatch(
      /end_system_config_boot_transaction[\s\S]*sleep 5[\s\S]*begin_system_config_boot_transaction/,
    );
    expect(retryBlock).not.toMatch(/exit\s+[1-9]/);
  });

  it("keeps boot coordination inactive on shared gateways", () => {
    const cleanupIdx = entrypoint.indexOf("system-config-boot-transaction.ts cleanup");
    const cleanupGuard = entrypoint.slice(entrypoint.lastIndexOf("if [", cleanupIdx), cleanupIdx);
    expect(cleanupGuard).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(cleanupGuard).toMatch(/!= "shared"/);
    const finalEndIdx = entrypoint.lastIndexOf("end_system_config_boot_transaction");
    const finalEndGuard = entrypoint.slice(entrypoint.lastIndexOf("if [", finalEndIdx), finalEndIdx);
    expect(finalEndGuard).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(finalEndGuard).toMatch(/!= "shared"/);
  });

  it("keeps one supervised config watcher alive across isolated boot roles", () => {
    expect(entrypoint).toMatch(/supervise_runner\s+system-config-watch\s+5000\b/);
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const guard = entrypoint.slice(entrypoint.lastIndexOf("if [", watcherIdx), watcherIdx);
    expect(guard).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(guard).toMatch(/!= "shared"/);
    expect(guard).not.toMatch(/SYSTEM_CONFIG_BOOT_ROLE/);
  });

  it("rehydrates source and target fences inside the transaction before Doctor or OpenClaw", () => {
    const roleIdx = entrypoint.indexOf("system-config-roll-boot.ts resolve");
    const shellIdx = entrypoint.indexOf("supervise_runner builder-shell");
    const beginIdx = entrypoint.indexOf("\n  begin_system_config_boot_transaction", shellIdx);
    const doctorIdx = entrypoint.indexOf("run_openclaw_doctor", roleIdx);
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    expect(roleIdx).toBeGreaterThan(-1);
    expect(shellIdx).toBeLessThan(beginIdx);
    expect(beginIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(doctorIdx);
    expect(roleIdx).toBeLessThan(openclawIdx);
  });

  it("never adds config write permission after a frozen role is resolved", () => {
    const hardenBlock = entrypoint.slice(
      entrypoint.indexOf("# ── Harden file permissions"),
      entrypoint.indexOf("# ── Install plugin extensions"),
    );
    expect(hardenBlock).toMatch(/SYSTEM_CONFIG_BOOT_ROLE.*normal/);
    expect(hardenBlock).toMatch(/find .*OPENCLAW_CONFIG_PATH.*-perm \/222/);
    const chmodIdx = hardenBlock.indexOf('chmod 600 "$OPENCLAW_CONFIG_PATH"');
    const normalIdx = hardenBlock.indexOf('SYSTEM_CONFIG_BOOT_ROLE" = "normal"');
    expect(chmodIdx).toBeGreaterThan(normalIdx);
  });

  it("skips mutation repair for frozen sources and existing candidates", () => {
    const roleBlock = entrypoint.slice(
      entrypoint.indexOf('case "$SYSTEM_CONFIG_BOOT_ROLE"'),
      entrypoint.indexOf("# ── Boot sync"),
    );
    expect(roleBlock).toMatch(/source-frozen\)[\s\S]*skipping config mutation repair/);
    expect(roleBlock).toMatch(/target-candidate\)[\s\S]*print-candidate-state/);
    expect(roleBlock).toMatch(/CANDIDATE_STATE.*pending[\s\S]*run_openclaw_doctor/);
    expect(roleBlock).toMatch(/CANDIDATE_STATE.*pending[\s\S]*system-config-roll-boot\.ts migrate-target/);
    expect(roleBlock).toMatch(/run_openclaw_doctor[\s\S]*system-config-roll-boot\.ts candidate/);
    const resolveIdx = entrypoint.indexOf("system-config-roll-boot.ts resolve");
    const migrateIdx = entrypoint.indexOf("system-config-roll-boot.ts migrate-target");
    const doctorIdx = entrypoint.indexOf("run_openclaw_doctor", migrateIdx);
    const candidateIdx = entrypoint.indexOf("system-config-roll-boot.ts candidate", migrateIdx);
    expect(resolveIdx).toBeLessThan(migrateIdx);
    expect(migrateIdx).toBeLessThan(doctorIdx);
    expect(doctorIdx).toBeLessThan(candidateIdx);
  });

  it("repairs and checkpoints durable config before watcher and OpenClaw while shell starts early", () => {
    const doctorIdx = entrypoint.indexOf("run_openclaw_doctor");
    const checkpointIdx = entrypoint.indexOf("system-config-checkpoint.ts");
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    const shellIdx = entrypoint.indexOf("supervise_runner builder-shell");
    expect(doctorIdx).toBeGreaterThan(-1);
    expect(checkpointIdx).toBeGreaterThan(doctorIdx);
    expect(watcherIdx).toBeGreaterThan(checkpointIdx);
    expect(openclawIdx).toBeGreaterThan(watcherIdx);
    expect(shellIdx).toBeLessThan(doctorIdx);
    expect(entrypoint).toMatch(/OPENCLAW_SERVICE_REPAIR_POLICY=external/);
    expect(entrypoint).toMatch(/OPENCLAW_DOCTOR_RESULT=ok/);
    expect(entrypoint).toMatch(/OPENCLAW_DOCTOR_RESULT=error/);
  });

  it("supports an explicit Doctor no-op without reporting a successful Doctor run", () => {
    expect(entrypoint).toMatch(/OPENCLAW_DOCTOR_MODE:-run/);
    expect(entrypoint).toMatch(/skip\)[\s\S]*unset OPENCLAW_DOCTOR_RESULT[\s\S]*return 0/);
    expect(entrypoint).toMatch(/run\)[\s\S]*openclaw doctor --fix --non-interactive/);
    expect(entrypoint).toMatch(/invalid OPENCLAW_DOCTOR_MODE/);
  });

  it("switches liveness to OpenClaw only after boot acceptance", () => {
    const markerResetIdx = entrypoint.indexOf('rm -f "$OPENCLAW_DIR/system_config.boot-accepted"');
    const statusIdx = entrypoint.indexOf("supervise_runner system-config-status");
    const markerAcceptIdx = entrypoint.indexOf('touch "$OPENCLAW_DIR/system_config.boot-accepted"');
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");

    expect(markerResetIdx).toBeGreaterThan(-1);
    expect(markerResetIdx).toBeLessThan(statusIdx);
    expect(markerAcceptIdx).toBeGreaterThan(statusIdx);
    expect(markerAcceptIdx).toBeLessThan(openclawIdx);
  });

  it("retries class policy and isolated pre-boot reconciliation without losing repair access", () => {
    expect(entrypoint).toMatch(/if \[ -f "\$CLASS_POLICY" \] && ! node "\$CLASS_POLICY"/);
    expect(entrypoint).toMatch(/if ! "\$TSX" \/octogee\/scripts\/entrypoints\/pre-boot-config\.ts/);
    const repairLoop = entrypoint.slice(
      entrypoint.indexOf("OPENCLAW_SERVICE_REPAIR_POLICY=external"),
      entrypoint.indexOf("# ── Boot sync"),
    );
    expect(repairLoop).toMatch(/while true/);
    expect(repairLoop).toMatch(
      /end_system_config_boot_transaction[\s\S]*sleep 5[\s\S]*begin_system_config_boot_transaction/,
    );
    expect(repairLoop).toContain("system-config-checkpoint.ts");

    expect(repairLoop).toContain('"$TSX" /octogee/scripts/entrypoints/pre-boot-config.ts');
  });

  it("runs pre-boot env patches without requiring the removed Firebase SA key", () => {
    const prebootBlock = entrypoint.slice(
      entrypoint.indexOf("Pre-boot: sync env/runtime config"),
      entrypoint.indexOf("Pre-boot: hydrating native GitHub CLI auth"),
    );
    expect(prebootBlock).toMatch(/OPENCLAW_CONFIG_PATH/);
    expect(prebootBlock).not.toMatch(/SA_KEY_PATH/);
    expect(prebootBlock).not.toMatch(/octogee-test-sa-key\.json/);
  });
});

describe("infra/gateway/entrypoint.sh — operator-profile boot hooks", () => {
  it("invokes the Claude first-run stamper when GATEWAY_PROFILE=operator AND the script exists", () => {

expect(entrypoint).toMatch(/GATEWAY_PROFILE[^\n]*=[^\n]*"?operator"?/);
    
    expect(entrypoint).toMatch(
      /\/octogee\/infra\/gateway\/stamp-claude-first-run\.mjs/,
    );
    
    expect(entrypoint).toMatch(/node\s+[^\n]*stamp-claude-first-run/);
  });

  it("the stamper is gated by BOTH the env guard AND the file-exists guard (defense in depth — single-guard removal must trip this)", () => {

const stamperRegion = entrypoint.match(
      /[\s\S]{0,400}stamp-claude-first-run\.mjs[\s\S]{0,200}/,
    )?.[0];
    expect(stamperRegion).toBeDefined();
    expect(stamperRegion).toMatch(/GATEWAY_PROFILE[\s\S]*operator/);

expect(stamperRegion).toMatch(/\[\s*-f\s+/);
  });

  it("applies the codex YOLO sandbox when GATEWAY_PROFILE=operator AND the script exists", () => {
    expect(entrypoint).toMatch(/\/octogee\/infra\/gateway\/apply-operator-codex-sandbox\.mjs/);
    expect(entrypoint).toMatch(/node\s+[^\n]*apply-operator-codex-sandbox/);
  });

  it("the codex-sandbox applier is gated by BOTH the env guard AND the file-exists guard", () => {
    const region = entrypoint.match(
      /[\s\S]{0,400}apply-operator-codex-sandbox\.mjs[\s\S]{0,200}/,
    )?.[0];
    expect(region).toBeDefined();
    expect(region).toMatch(/GATEWAY_PROFILE[\s\S]*operator/);
    expect(region).toMatch(/\[\s*-f\s+/);
  });
});

describe("infra/gateway/entrypoint.sh — supervised in-pod runners + metrics", () => {
  it("routes the db-less fleet controller and cattle side runners through supervise-runner", () => {
    const runners: Record<string, string> = {
      "fleet-controller": "5000",
      "site-build": "5000",
      "preview-proxy": "5000",
      "byosub-syncback": "30000",
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

  it("skips site-build-api on operator-class gateways", () => {
    const siteBuildIdx = entrypoint.indexOf("supervise_runner site-build");
    expect(siteBuildIdx).toBeGreaterThan(0);
    const guardBlock = entrypoint.slice(
      entrypoint.lastIndexOf("if [", siteBuildIdx),
      siteBuildIdx,
    );
    expect(guardBlock).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(guardBlock).toMatch(/!= "operator"/);
  });

  it("gates builder-shell behind runtime class and explicit shell unlock", () => {
    expect(entrypoint).toMatch(/supervise_runner\s+builder-shell\s+5000\b/);
    expect(entrypoint.match(/supervise_runner\s+builder-shell\s+5000\b/g)).toHaveLength(1);
    const builderIdx = entrypoint.indexOf("supervise_runner builder-shell");
    const guardBlock = entrypoint.slice(
      entrypoint.lastIndexOf("if [", builderIdx),
      builderIdx,
    );
    expect(guardBlock).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(guardBlock).toMatch(/!= "shared"/);
    expect(guardBlock).toMatch(/OPERATOR_SHELLS_ENABLED/);
    expect(guardBlock).toMatch(/true/);
    expect(entrypoint).toMatch(/export BUILDER_SHELL_REQUIRE_KEY/);
    expect(entrypoint).toMatch(
      /Builder-shell disabled: runtime shell access is not enabled/,
    );
  });

  it("does not run the Firestore-backed shell reconciler inside operator pods", () => {
    expect(entrypoint).not.toMatch(/supervise_runner\s+shell-reconciler\b/);
    expect(entrypoint).not.toMatch(/reconcile-shells-runner\.ts/);
  });

  it("starts the always-on runner-metrics-exporter", () => {
    expect(entrypoint).toMatch(/runner-metrics-exporter\.ts/);
  });

  it("supervise_runner keeps a thin shell guard so a dead supervisor restarts", () => {
    const fnRegion = entrypoint.slice(
      entrypoint.indexOf("supervise_runner() {"),
      entrypoint.indexOf("supervise_runner system-config-status"),
    );
    expect(fnRegion).toMatch(/while true/);
    expect(fnRegion).toMatch(/\$SUPERVISE/);
    expect(fnRegion).toMatch(/--restart-delay-ms=\$\{_restart_delay_ms\}/);
    expect(entrypoint).toMatch(/SUPERVISE=[^\n]*supervise-runner\.ts/);
  });

  it("holds the transaction through watcher, boot acceptance, and OpenClaw launch", () => {
    const shellIdx = entrypoint.indexOf("supervise_runner builder-shell");
    const beginIdx = entrypoint.indexOf("\n  begin_system_config_boot_transaction", shellIdx);
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const resolveIdx = entrypoint.indexOf("system-config-roll-boot.ts resolve");
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const acceptIdx = entrypoint.indexOf("system-config-roll-boot.ts accept");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    const endIdx = entrypoint.lastIndexOf("\n  end_system_config_boot_transaction");
    expect(shellIdx).toBeLessThan(beginIdx);
    expect(beginIdx).toBeLessThan(restoreIdx);
    expect(restoreIdx).toBeLessThan(resolveIdx);
    expect(resolveIdx).toBeLessThan(watcherIdx);
    expect(watcherIdx).toBeLessThan(acceptIdx);
    expect(acceptIdx).toBeLessThan(openclawIdx);
    expect(openclawIdx).toBeLessThan(endIdx);
  });

  it("boot-accepts the revalidated frozen role before OpenClaw and transaction release", () => {
    const acceptIdx = entrypoint.indexOf("system-config-roll-boot.ts accept");
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    const endIdx = entrypoint.lastIndexOf("\n  end_system_config_boot_transaction");
    expect(acceptIdx).toBeGreaterThan(entrypoint.indexOf("system-config-roll-boot.ts candidate"));
    expect(acceptIdx).toBeGreaterThan(watcherIdx);
    expect(acceptIdx).toBeLessThan(openclawIdx);
    expect(acceptIdx).toBeLessThan(endIdx);
  });

  it("turns repair-shell teardown into a restart of the full gateway container", () => {
    expect(repairContainerRestart).toMatch(/process\.kill\(0,\s*signal\)/);
    const shutdownIdx = entrypoint.indexOf("shutdown() {");
    const trapIdx = entrypoint.indexOf("trap shutdown TERM INT");
    const shellIdx = entrypoint.indexOf("supervise_runner builder-shell");
    const beginIdx = entrypoint.indexOf("\n  begin_system_config_boot_transaction");
    const shutdown = entrypoint.slice(shutdownIdx, trapIdx);
    expect(shutdown).toMatch(/kill -TERM 0/);
    expect(shutdown).toMatch(/exit 0/);
    expect(trapIdx).toBeLessThan(shellIdx);
    expect(trapIdx).toBeLessThan(beginIdx);
    expect(entrypoint.match(/trap shutdown TERM INT/g)).toHaveLength(1);
    expect(gatewayDeployment).toMatch(/kind:\s*Deployment/);
    expect(gatewayDeployment).not.toMatch(/restartPolicy:\s*(?:Never|OnFailure)/);
  });
});

describe("scripts/entrypoints/fleet-controller.ts — db-less local persistence loops", () => {
  it("keeps credential-free workspace git autosave wired into the live gateway controller", () => {
    expect(fleetController).toMatch(/startWorkspaceAutosaveLoop/);
    expect(fleetController).toMatch(/syncAllWorkspaces/);
    expect(fleetController).toMatch(/GIT_SYNC_INTERVAL_MS/);
  });

  it("keeps brokered GCS blob sync wired into the live gateway controller", () => {
    expect(fleetController).toMatch(/blobSyncAllWithOptions/);
    expect(fleetController).toMatch(/createBrokeredBlobStore/);
  });
});
