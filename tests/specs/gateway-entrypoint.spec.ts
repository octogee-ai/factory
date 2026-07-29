

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

  it("hydrates the configured builder credential after restore and before config repair", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const hydrateIdx = entrypoint.indexOf("configured-builder-bootstrap.ts");
    const doctorIdx = entrypoint.indexOf("run_openclaw_doctor");
    expect(hydrateIdx).toBeGreaterThan(restoreIdx);
    expect(doctorIdx).toBeGreaterThan(hydrateIdx);
  });

  it("gates system_config restore on non-shared class and explicit builder slug", () => {
    const restoreBlock = entrypoint.slice(
      entrypoint.indexOf("Owner-bound runtime system_config restore"),
      entrypoint.indexOf("apply-gateway-class-policy.mjs"),
    );
    expect(restoreBlock).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(restoreBlock).toMatch(/!= "shared"/);
    expect(restoreBlock).toMatch(/GATEWAY_BUILDER_SLUG/);
  });

  it("requires a builder slug for every owner-bound runtime", () => {
    const identityBlock = entrypoint.slice(
      entrypoint.indexOf("GATEWAY_ID is set by the deployment's env block"),
      entrypoint.indexOf("BuilderShell comes up before the durable restore"),
    );
    expect(identityBlock).toMatch(
      /FATAL: GATEWAY_BUILDER_SLUG is required for \$\{GATEWAY_CLASS_EFFECTIVE\} durable config/,
    );
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

  it("starts the entitled repair shell before restore so the operator can intervene while boot waits", () => {
    const configPathIdx = entrypoint.indexOf(
      'export OPENCLAW_CONFIG_PATH="$OPENCLAW_DIR/system_config/openclaw.json"',
    );
    const shellIdx = entrypoint.indexOf("supervise_runner builder-shell");
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    expect(configPathIdx).toBeGreaterThan(-1);
    expect(configPathIdx).toBeLessThan(shellIdx);
    expect(shellIdx).toBeLessThan(restoreIdx);
  });

  it("keeps the probed runner plane behind repair and bounds each startup attempt", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const checkpointIdx = entrypoint.indexOf("system-config-checkpoint.ts");
    const fleetControllerIdx = entrypoint.indexOf("supervise_runner fleet-controller");

    expect(fleetControllerIdx).toBeGreaterThan(restoreIdx);
    expect(fleetControllerIdx).toBeGreaterThan(checkpointIdx);
    expect(gatewayDeployment).toMatch(/startupProbe:[\s\S]*?path:\s*\/health[\s\S]*?port:\s*\{\{ \.Values\.env\.fleetControllerPort/);
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

  it("keeps one supervised config watcher for non-shared gateways", () => {
    expect(entrypoint).toMatch(/supervise_runner\s+system-config-watch\s+5000\b/);
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const guard = entrypoint.slice(entrypoint.lastIndexOf("if [", watcherIdx), watcherIdx);
    expect(guard).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(guard).toMatch(/!= "shared"/);
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

  it("normalizes legacy config before Doctor validates a durable gateway", () => {
    const repairLoop = entrypoint.slice(
      entrypoint.indexOf("OPENCLAW_SERVICE_REPAIR_POLICY=external"),
      entrypoint.indexOf("# ── In-pod runners"),
    );
    expect(repairLoop.indexOf('"$TSX" /octogee/scripts/entrypoints/pre-boot-config.ts'))
      .toBeLessThan(repairLoop.indexOf("run_openclaw_doctor"));
  });

  it("retries the whole repair unit level-triggered without exiting", () => {
    const repairLoop = entrypoint.slice(
      entrypoint.indexOf("OPENCLAW_SERVICE_REPAIR_POLICY=external"),
      entrypoint.indexOf("# ── In-pod runners"),
    );
    expect(repairLoop).toMatch(/while true/);
    expect(repairLoop).toMatch(/sleep 5/);
    expect(repairLoop).toContain("system-config-checkpoint.ts");
    expect(repairLoop).toContain('"$TSX" /octogee/scripts/entrypoints/pre-boot-config.ts');
    expect(repairLoop).toMatch(/if \[ -f "\$CLASS_POLICY" \] && ! node "\$CLASS_POLICY"/);
    expect(repairLoop).not.toMatch(/exit\s+[1-9]/);
  });

  it("supports an explicit Doctor no-op without reporting a successful Doctor run", () => {
    expect(entrypoint).toMatch(/OPENCLAW_DOCTOR_MODE:-run/);
    expect(entrypoint).toMatch(/skip\)[\s\S]*unset OPENCLAW_DOCTOR_RESULT[\s\S]*return 0/);
    expect(entrypoint).toMatch(/run\)[\s\S]*openclaw doctor --fix --non-interactive/);
    expect(entrypoint).toMatch(/invalid OPENCLAW_DOCTOR_MODE/);
  });

  it("runs beta session-SQLite migration and validation after durable state is restored but before Gateway owns the lock", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const migrationIdx = entrypoint.indexOf("run_session_sqlite_migration");
    const gatewayIdx = entrypoint.indexOf("openclaw gateway run");
    expect(migrationIdx).toBeGreaterThan(restoreIdx);
    expect(migrationIdx).toBeLessThan(gatewayIdx);
    const migrationBlock = entrypoint.slice(migrationIdx, entrypoint.indexOf("# ── Repair + accept", migrationIdx));
    expect(migrationBlock).toContain("--session-sqlite dry-run --session-sqlite-all-agents --json");
    expect(migrationBlock).toContain("--session-sqlite import --session-sqlite-all-agents --json");
    expect(migrationBlock).toContain("--session-sqlite validate --session-sqlite-all-agents --json");
    expect(migrationBlock).toContain("OPENCLAW_SESSION_SQLITE_MIGRATION_MODE");
  });

  it("makes a requested beta session-SQLite migration part of the retrying repair unit", () => {
    const repairLoop = entrypoint.slice(
      entrypoint.indexOf("OPENCLAW_SERVICE_REPAIR_POLICY=external"),
      entrypoint.indexOf("# ── In-pod runners"),
    );
    expect(repairLoop).toContain("run_session_sqlite_migration");
    expect(repairLoop).toMatch(/session SQLite migration failed; retrying/);
  });

  it("hardens the active config unconditionally — no role-dependent permission arms", () => {
    const hardenBlock = entrypoint.slice(
      entrypoint.indexOf("# ── Harden file permissions"),
      entrypoint.indexOf("# ── Install plugin extensions"),
    );
    expect(hardenBlock).toMatch(/chmod 600 "\$OPENCLAW_CONFIG_PATH"/);
    expect(hardenBlock).not.toMatch(/SYSTEM_CONFIG_BOOT_ROLE/);
    expect(hardenBlock).not.toMatch(/FATAL/);
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
  it("invokes the Claude first-run stamper for a tenant-bound operator when the script exists", () => {

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

  it("applies the codex YOLO sandbox for a tenant-bound operator when the script exists", () => {
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
      entrypoint.indexOf("supervise_runner builder-shell"),
    );
    expect(fnRegion).toMatch(/while true/);
    expect(fnRegion).toMatch(/\$SUPERVISE/);
    expect(fnRegion).toMatch(/--restart-delay-ms=\$\{_restart_delay_ms\}/);
    expect(entrypoint).toMatch(/SUPERVISE=[^\n]*supervise-runner\.ts/);
  });

  it("forwards SIGTERM to the whole process group so a pod restart is clean", () => {
    const shutdownIdx = entrypoint.indexOf("shutdown() {");
    const trapIdx = entrypoint.indexOf("trap shutdown TERM INT");
    const shellIdx = entrypoint.indexOf("supervise_runner builder-shell");
    const shutdown = entrypoint.slice(shutdownIdx, trapIdx);
    expect(shutdown).toMatch(/kill -TERM 0/);
    expect(shutdown).toMatch(/exit 0/);
    expect(trapIdx).toBeLessThan(shellIdx);
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

  it("publishes durable-config runtime health to the broker in place of the retired status server", () => {
    expect(fleetController).toMatch(/createSystemConfigStatusPublisher/);
    expect(fleetController).toMatch(/refreshSystemConfigRuntimeHealth/);
    expect(fleetController).toMatch(/recordSystemConfigStatus/);
  });
});
