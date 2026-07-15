

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

  it("makes the tracked system_config file the active OpenClaw path and fails closed on restore", () => {
    expect(entrypoint).toMatch(
      /export OPENCLAW_CONFIG_PATH="\$OPENCLAW_DIR\/system_config\/openclaw\.json"/,
    );
    const restoreLine = entrypoint.split("\n").find((line) => line.includes("system-config-restore.ts"));
    expect(restoreLine).toBeTruthy();
    expect(restoreLine).not.toMatch(/\|\|/);
    expect(entrypoint).not.toMatch(/gateway\.auth\.token re-synced/);
  });

  it("starts one supervised config watcher on isolated gateways", () => {
    expect(entrypoint).toMatch(/supervise_runner\s+system-config-watch\s+5000\b/);
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const guard = entrypoint.slice(entrypoint.lastIndexOf("if [", watcherIdx), watcherIdx);
    expect(guard).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(guard).toMatch(/!= "shared"/);
  });

  it("repairs and checkpoints durable config before OpenClaw or the watcher starts", () => {
    const doctorIdx = entrypoint.indexOf("openclaw doctor --fix --non-interactive");
    const checkpointIdx = entrypoint.indexOf("system-config-checkpoint.ts");
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    expect(doctorIdx).toBeGreaterThan(-1);
    expect(checkpointIdx).toBeGreaterThan(doctorIdx);
    expect(watcherIdx).toBeGreaterThan(checkpointIdx);
    expect(openclawIdx).toBeGreaterThan(watcherIdx);
    expect(entrypoint).toMatch(/OPENCLAW_SERVICE_REPAIR_POLICY=external/);
  });

  it("fails boot when class policy or isolated pre-boot reconciliation fails", () => {
    const classPolicyLine = entrypoint.split("\n").find((line) =>
      line.includes('node "$CLASS_POLICY"')
    );
    expect(classPolicyLine).toBe('  node "$CLASS_POLICY"');

    const prebootBlock = entrypoint.slice(
      entrypoint.indexOf("Pre-boot: sync env/runtime config"),
      entrypoint.indexOf("Pre-boot: hydrating native GitHub CLI auth"),
    );
    expect(prebootBlock).toMatch(/GATEWAY_CLASS_EFFECTIVE[^\n]*!= "shared"/);
    expect(prebootBlock).toContain('"$TSX" /octogee/scripts/entrypoints/pre-boot-config.ts');
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
      entrypoint.indexOf("supervise_runner fleet-controller"),
    );
    expect(fnRegion).toMatch(/while true/);
    expect(fnRegion).toMatch(/\$SUPERVISE/);
    expect(fnRegion).toMatch(/--restart-delay-ms=\$\{_restart_delay_ms\}/);
    expect(entrypoint).toMatch(/SUPERVISE=[^\n]*supervise-runner\.ts/);
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
