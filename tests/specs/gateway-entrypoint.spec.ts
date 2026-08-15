

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

  it("starts the entitled repair shell before restore so the Builder can intervene while boot waits", () => {
    const configPathIdx = entrypoint.indexOf(
      'export OPENCLAW_CONFIG_PATH="$OPENCLAW_DIR/system_config/openclaw.json"',
    );
    const shellIdx = entrypoint.indexOf("supervise_runner builder-shell");
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    expect(configPathIdx).toBeGreaterThan(-1);
    expect(configPathIdx).toBeLessThan(shellIdx);
    expect(shellIdx).toBeLessThan(restoreIdx);
  });

  it("starts the probed runner plane only after the actual OpenClaw process", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    const fleetControllerIdx = entrypoint.indexOf("supervise_runner fleet-controller");

    expect(fleetControllerIdx).toBeGreaterThan(restoreIdx);
    expect(fleetControllerIdx).toBeGreaterThan(openclawIdx);
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

  it("starts OpenClaw before the durable watcher and auxiliary runners", () => {
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const fleetIdx = entrypoint.indexOf("supervise_runner fleet-controller");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    const shellIdx = entrypoint.indexOf("supervise_runner builder-shell");
    expect(openclawIdx).toBeGreaterThan(shellIdx);
    expect(watcherIdx).toBeGreaterThan(openclawIdx);
    expect(fleetIdx).toBeGreaterThan(openclawIdx);
    expect(entrypoint).toContain("OpenClaw gateway healthy; starting auxiliary runners");
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

  it("never hydrates GitHub auth into the Builder runtime and defers native runtime stamping", () => {
    const healthyIdx = entrypoint.indexOf("OpenClaw gateway healthy");
    const fleetIdx = entrypoint.indexOf("supervise_runner fleet-controller");
    const stamperIdx = entrypoint.indexOf("stamp-claude-first-run.mjs");
    expect(entrypoint).not.toContain("github-cli-auth-hydrate");
    expect(entrypoint).not.toContain("github-cli-auth-convergence");
    expect(fleetIdx).toBeGreaterThan(healthyIdx);
    expect(stamperIdx).toBeGreaterThan(healthyIdx);
  });
});

describe("infra/gateway/entrypoint.sh — supervised in-pod runners + metrics", () => {
  it("routes only non-code auxiliary runners through supervise-runner on customer gateways", () => {
    const runners: Record<string, string> = {
      "fleet-controller": "5000",
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

  it("never starts site-build-api inside the credential-bearing gateway container", () => {
    expect(entrypoint).not.toMatch(/supervise_runner\s+site-build\b/);
    expect(entrypoint).toContain("site-build-api disabled");
  });

  it("never starts the retired in-gateway preview proxy", () => {
    expect(entrypoint).not.toMatch(/supervise_runner\s+preview-proxy\b/);
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
    expect(guardBlock).toMatch(/= "builder"/);
    expect(guardBlock).toMatch(/BUILDER_SHELLS_ENABLED/);
    expect(guardBlock).toMatch(/true/);
    expect(entrypoint).toMatch(/export BUILDER_SHELL_REQUIRE_KEY/);
    expect(entrypoint).toMatch(
      /Builder-shell disabled: runtime shell access is not enabled/,
    );
  });

  it("does not run the Firestore-backed shell reconciler inside Builder pods", () => {
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
  it("keeps autosave and non-committing push recovery wired into the live gateway controller", () => {
    expect(fleetController).toMatch(/startWorkspaceAutosaveLoop/);
    expect(fleetController).toMatch(/startWorkspacePushRecoveryLoop/);
    expect(fleetController).toMatch(/syncAllCustomerRepositories/);
    expect(fleetController).toMatch(/retryAllCustomerRepositoryPushes/);
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
