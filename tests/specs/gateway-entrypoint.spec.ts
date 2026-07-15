

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

  it("gates system_config restore on non-shared class and explicit builder slug", () => {
    const restoreBlock = entrypoint.slice(
      entrypoint.indexOf("Dedicated gateway system_config restore"),
      entrypoint.indexOf("apply-gateway-class-policy.mjs"),
    );
    expect(restoreBlock).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(restoreBlock).toMatch(/!= "shared"/);
    expect(restoreBlock).toMatch(/GATEWAY_BUILDER_SLUG/);
  });

  it("makes the tracked system_config file active and retries restore while status stays up", () => {
    expect(entrypoint).toMatch(
      /export OPENCLAW_CONFIG_PATH="\$OPENCLAW_DIR\/system_config\/openclaw\.json"/,
    );
    const restoreLine = entrypoint.split("\n").find((line) => line.includes("system-config-restore.ts"));
    expect(restoreLine).toBeTruthy();
    expect(entrypoint).toMatch(/until "\$TSX" \/octogee\/scripts\/entrypoints\/system-config-restore\.ts/);
    const statusIdx = entrypoint.indexOf("supervise_runner system-config-status");
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    expect(statusIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeLessThan(restoreIdx);
    expect(entrypoint).not.toMatch(/gateway\.auth\.token re-synced/);
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

  it("starts one supervised config watcher on isolated gateways", () => {
    expect(entrypoint).toMatch(/supervise_runner\s+system-config-watch\s+5000\b/);
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const guard = entrypoint.slice(entrypoint.lastIndexOf("if [", watcherIdx), watcherIdx);
    expect(guard).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(guard).toMatch(/!= "shared"/);
  });

  it("repairs and checkpoints durable config before watcher and OpenClaw while shell starts early", () => {
    const doctorIdx = entrypoint.indexOf("openclaw doctor --fix --non-interactive");
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
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const acceptedIdx = entrypoint.indexOf('touch "$OPENCLAW_DIR/system_config.boot-accepted"');
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    const endIdx = entrypoint.lastIndexOf("\n  end_system_config_boot_transaction");
    expect(shellIdx).toBeLessThan(beginIdx);
    expect(beginIdx).toBeLessThan(entrypoint.indexOf("system-config-restore.ts"));
    expect(watcherIdx).toBeLessThan(acceptedIdx);
    expect(acceptedIdx).toBeLessThan(openclawIdx);
    expect(openclawIdx).toBeLessThan(endIdx);
  });

  it("turns repair-shell teardown into a restart of the full gateway container", () => {
    expect(repairContainerRestart).toMatch(/process\.kill\(1,\s*signal\)/);
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
