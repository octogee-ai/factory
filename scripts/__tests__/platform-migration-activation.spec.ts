import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertPlatformMigrationActivationReceipt,
  executePlatformMigrationActivation,
  parsePlatformMigrationActivationArgs,
  platformMigrationActivationConfirmation,
} from "../lib/platform-migration-activation.js";
import { discoverActivationServices } from "../ops/activate-platform-migration-services.js";

const migrationId = "west-cutover-20260724";
const revision = "a".repeat(40);

function args(apply = true) {
  return parsePlatformMigrationActivationArgs([
    "--source=test-central",
    "--target=test-west",
    `--migration-id=${migrationId}`,
    ...(apply ? ["--apply", `--confirm=${platformMigrationActivationConfirmation("test-central", "test-west", migrationId)}`] : []),
  ]);
}

function dependencies(overrides: Partial<Parameters<typeof executePlatformMigrationActivation>[1]> = {}) {
  let receipt: unknown = null;
  let services = [
    { service: "mattermost" as const, kind: "Deployment" as const, name: "mattermost", replicas: 0, readyReplicas: 0, pods: 0 },
    { service: "gitea" as const, kind: "Deployment" as const, name: "octogee-gitea", replicas: 0, readyReplicas: 0, pods: 0 },
  ];
  const events: string[] = [];
  return {
    dependencies: {
      assertReceiptStorage: async () => events.push("storage"),
      assertExactMergedMain: async () => revision,
      assertMigrationPreconditions: async () => events.push("preconditions"),
      readServices: async () => services,
      scaleService: async (_target: unknown, service: { name: string }, replicas: number) => {
        events.push(`scale:${service.name}=${replicas}`);
        services = services.map((current) => current.name === service.name
          ? { ...current, replicas, readyReplicas: replicas, pods: replicas }
          : current);
      },
      waitForServicesReady: async () => events.push("ready"),
      waitForServicesStopped: async () => events.push("stopped"),
      rotateMattermost: async () => events.push("mattermost-rotate"),
      resetGitea: async () => events.push("gitea-reset"),
      rematerializeSecrets: async () => events.push("secrets-rematerialized"),
      verifySecrets: async () => events.push("secrets-verified"),
      readReceipt: async () => receipt as never,
      writeReceipt: async (_uri: string, next: unknown) => { receipt = next; events.push("receipt"); },
      receiptUri: () => "gs://receipts/activation.json",
      settingsForTarget: () => ({ targetId: "test-west" }) as never,
      ...overrides,
    },
    events,
    receipt: () => receipt,
    setReceipt: (next: unknown) => { receipt = next; },
    services: () => services,
  };
}

describe("platform migration activation", () => {
  it("uses the explicitly confirmed Gitea migration mode that leaves credential writers stopped", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const setup = fs.readFileSync(path.join(repoRoot, "scripts/setup-gitea.sh"), "utf8");
    const operator = fs.readFileSync(path.join(repoRoot, "scripts/ops/activate-platform-migration-services.ts"), "utf8");

    expect(setup).toContain("--migration-quiesced");
    expect(setup).toContain("Migration-quiesced Gitea setup requires --confirm-platform-migration=$TARGET_ID");
    expect(setup).toContain("if $MIGRATION_QUIESCED; then");
    expect(operator).toContain('"--migration-quiesced"');
    expect(operator).toContain("`--confirm-platform-migration=${args.target}`");
  });

  it("selects only the two PVC-backed durable services, never the Mattermost callback workload", () => {
    const workload = (kind: string, name: string, claims: number) => ({ kind, metadata: { name }, spec: { replicas: 0, template: { spec: { volumes: Array.from({ length: claims }, (_, index) => ({ persistentVolumeClaim: { claimName: `${name}-${index}` } })) } } }, status: {} });
    expect(discoverActivationServices({ items: [
      workload("Deployment", "mattermost", 1), workload("Deployment", "octogee-gitea", 1), workload("Deployment", "mattermost-callback-router", 0),
    ] })).toEqual([
      { service: "gitea", kind: "Deployment", name: "octogee-gitea", replicas: 0, readyReplicas: 0, pods: 0 },
      { service: "mattermost", kind: "Deployment", name: "mattermost", replicas: 0, readyReplicas: 0, pods: 0 },
    ]);
  });

  it("requires explicit authority for the exact central-to-west pair", () => {
    expect(() => parsePlatformMigrationActivationArgs([
      "--source=test-central", "--target=test-west", `--migration-id=${migrationId}`, "--apply",
      "--confirm=wrong",
    ])).toThrow("apply requires --confirm=octogee/platform-migration-activation/test-central/test-west/");
  });

  it("starts only the stopped durable services, rotates credentials, verifies secrets, then records evidence", async () => {
    const state = dependencies();
    await executePlatformMigrationActivation(args(), state.dependencies);
    expect(state.events).toEqual([
      "storage", "preconditions", "scale:mattermost=1", "scale:octogee-gitea=1", "ready",
      "mattermost-rotate", "gitea-reset", "secrets-rematerialized", "secrets-verified", "receipt",
    ]);
    expect(state.receipt()).toMatchObject({
      kind: "platform-migration-activation-receipt", migrationId, source: "test-central", target: "test-west", revision, verified: true,
    });
  });

  it("returns only to the stopped target state when activation fails and writes no success evidence", async () => {
    const state = dependencies({ resetGitea: async () => { throw new Error("Gitea reset failed"); } });
    await expect(executePlatformMigrationActivation(args(), state.dependencies)).rejects.toThrow("Gitea reset failed");
    expect(state.events).toEqual(expect.arrayContaining(["scale:mattermost=0", "scale:octogee-gitea=0", "stopped"]));
    expect(state.receipt()).toBeNull();
    expect(state.services().map((service) => service.replicas)).toEqual([0, 0]);
  });

  it("returns both services to zero when immutable receipt creation fails", async () => {
    const state = dependencies({ writeReceipt: async () => { throw new Error("receipt collision"); } });
    await expect(executePlatformMigrationActivation(args(), state.dependencies)).rejects.toThrow("receipt collision");
    expect(state.events).toEqual(expect.arrayContaining(["secrets-verified", "scale:mattermost=0", "scale:octogee-gitea=0", "stopped"]));
    expect(state.services().map((service) => service.replicas)).toEqual([0, 0]);
  });

  it("treats a matching receipt discovered after a write acknowledgement failure as committed", async () => {
    const state = dependencies({
      writeReceipt: async (_uri, next) => {
        state.setReceipt(next);
        throw new Error("receipt acknowledgement unavailable");
      },
    });

    await expect(executePlatformMigrationActivation(args(), state.dependencies)).resolves.toEqual({
      receipt: "gs://receipts/activation.json",
      status: "complete",
    });
    expect(state.events).not.toContain("scale:mattermost=0");
    expect(state.services().map((service) => service.replicas)).toEqual([1, 1]);
  });

  it("rolls both services back when a write error reveals mismatched immutable evidence", async () => {
    const state = dependencies({
      writeReceipt: async (_uri, next) => {
        state.setReceipt({ ...next, revision: "b".repeat(40) });
        throw new Error("receipt collision");
      },
    });

    await expect(executePlatformMigrationActivation(args(), state.dependencies))
      .rejects.toThrow("activation receipt does not match");
    expect(state.events).toEqual(expect.arrayContaining(["scale:mattermost=0", "scale:octogee-gitea=0", "stopped"]));
    expect(state.services().map((service) => service.replicas)).toEqual([0, 0]);
  });

  it("is retry-safe after an interrupted activation left a durable service running", async () => {
    const state = dependencies({ readServices: async () => [
      { service: "mattermost", kind: "Deployment", name: "mattermost", replicas: 1, readyReplicas: 1, pods: 1 },
      { service: "gitea", kind: "Deployment", name: "octogee-gitea", replicas: 0, readyReplicas: 0, pods: 0 },
    ] });
    await executePlatformMigrationActivation(args(), state.dependencies);
    expect(state.events).not.toContain("scale:mattermost=1");
    expect(state.events).toContain("scale:octogee-gitea=1");
  });

  it("treats matching immutable evidence as a no-op", async () => {
    const existing = { schemaVersion: 1, kind: "platform-migration-activation-receipt", migrationId, source: "test-central", target: "test-west", revision, credentials: "migration-only-mattermost-and-target-gitea", secrets: "rematerialized-and-verified", services: [{ service: "mattermost", kind: "Deployment", name: "mattermost" }, { service: "gitea", kind: "Deployment", name: "octogee-gitea" }], verified: true };
    const state = dependencies({ readReceipt: async () => existing as never });
    await executePlatformMigrationActivation(args(), state.dependencies);
    expect(state.events).toEqual(["storage", "preconditions"]);
  });

  it("fails closed when an immutable activation receipt omits required evidence", async () => {
    const existing = { schemaVersion: 1, kind: "platform-migration-activation-receipt", migrationId, source: "test-central", target: "test-west", revision, verified: true };
    const state = dependencies({ readReceipt: async () => existing as never });
    await expect(executePlatformMigrationActivation(args(), state.dependencies)).rejects.toThrow("activation receipt does not match");
  });

  it.each([
    [[{ service: "mattermost", kind: "Deployment", name: "mattermost" }, { service: "rogue", kind: "Deployment", name: "octogee-gitea" }], "exact Mattermost and Gitea service set"],
    [[{ service: "mattermost", kind: "Job", name: "mattermost" }, { service: "gitea", kind: "Deployment", name: "octogee-gitea" }], "valid workload identity"],
    [[{ service: "mattermost", kind: "Deployment", name: "../mattermost" }, { service: "gitea", kind: "Deployment", name: "octogee-gitea" }], "valid workload identity"],
  ])("rejects corrupt immutable service evidence %#", (services, message) => {
    expect(() => assertPlatformMigrationActivationReceipt({
      schemaVersion: 1,
      kind: "platform-migration-activation-receipt",
      migrationId,
      source: "test-central",
      target: "test-west",
      revision,
      credentials: "migration-only-mattermost-and-target-gitea",
      secrets: "rematerialized-and-verified",
      services,
      verified: true,
    }, { migrationId, source: "test-central", target: "test-west", revision })).toThrow(message);
  });
});
