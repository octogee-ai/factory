

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

describe("infra/gateway/entrypoint.sh — per-gateway Mac ops bootstrap (#998)", () => {
  it("invokes bootstrap-mac-ops.mjs BEFORE OpenClaw starts so accounts.default.botToken is patched", () => {

const bootstrapIdx = entrypoint.indexOf("bootstrap-mac-ops.mjs");
    expect(bootstrapIdx).toBeGreaterThan(-1);
    const openclawStartIdx = entrypoint.indexOf("openclaw gateway run");
    expect(openclawStartIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(openclawStartIdx);
  });

  it("guards on explicit opt-in + openclaw.json so the runtime gateway does not duplicate init bootstrap", () => {
    const bootstrapBlock = entrypoint.slice(
      entrypoint.indexOf("Pre-boot: per-gateway Mac ops"),
      entrypoint.indexOf("bootstrap-mac-ops.mjs") + 200,
    );
    expect(bootstrapBlock).toMatch(/MAC_OPS_BOOTSTRAP_ENABLED/);
    expect(bootstrapBlock).toMatch(/openclaw\.json/);
    expect(bootstrapBlock).not.toMatch(/MM_ADMIN_PAT/);
  });

  it("invocation is non-fatal so a transient MM error doesn't crash the boot", () => {
    const bootstrapLine = entrypoint
      .split("\n")
      .find((l) => l.includes("bootstrap-mac-ops.mjs"));
    expect(bootstrapLine).toBeTruthy();
    expect(bootstrapLine!).toMatch(/\|\|\s+log/);
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

  it("exports a builder-stable operator agent id before openclaw.template envsubst", () => {
    const agentSlugIdx = entrypoint.indexOf("OPERATOR_AGENT_SLUG=");
    const agentIdIdx = entrypoint.indexOf("OPERATOR_AGENT_ID=");
    const envsubstIdx = entrypoint.indexOf("envsubst < /octogee/infra/gateway/openclaw.template.json");
    expect(agentSlugIdx).toBeGreaterThan(-1);
    expect(agentIdIdx).toBeGreaterThan(-1);
    expect(envsubstIdx).toBeGreaterThan(-1);
    expect(agentSlugIdx).toBeLessThan(envsubstIdx);
    expect(agentIdIdx).toBeLessThan(envsubstIdx);

    const opsBlock = entrypoint.slice(
      entrypoint.indexOf("Provision ops-agent workspace"),
      entrypoint.indexOf("Operator-profile: Claude Code first-run stamp"),
    );
    expect(opsBlock).toMatch(/OPS_AGENT_ID="\$\{OPERATOR_AGENT_ID\}"/);
  });

  it("runs pre-boot env patches without requiring the removed Firebase SA key", () => {
    const prebootIdx = entrypoint.indexOf("entrypoints/pre-boot-config.ts");
    expect(prebootIdx).toBeGreaterThan(-1);
    const prebootBlock = entrypoint.slice(
      entrypoint.lastIndexOf("if [", prebootIdx),
      prebootIdx + 220,
    );
    expect(prebootBlock).toMatch(/openclaw\.json/);
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

  it("gates builder-shell behind operator class and explicit shell unlock", () => {
    expect(entrypoint).toMatch(/supervise_runner\s+builder-shell\s+5000\b/);
    const builderIdx = entrypoint.indexOf("supervise_runner builder-shell");
    const guardBlock = entrypoint.slice(
      entrypoint.lastIndexOf("if [", builderIdx),
      builderIdx,
    );
    expect(guardBlock).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(guardBlock).toMatch(/operator/);
    expect(guardBlock).toMatch(/OPERATOR_SHELLS_ENABLED/);
    expect(guardBlock).toMatch(/true/);
    expect(entrypoint).toMatch(/export BUILDER_SHELL_REQUIRE_KEY/);
    expect(entrypoint).toMatch(
      /Builder-shell disabled: operator trust boundary is not provisioned/,
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
