import { EventEmitter, once } from "node:events";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSurgeOpenClawProcessGate,
  createSurgeOpenClawProcessSupervisorClient,
  SURGE_OPENCLAW_PROCESS_GATE_FILE,
} from "../lib/surge-openclaw-process-gate.js";
import { createSurgeReadinessGate } from "../lib/surge-readiness.js";
import { createSurgeOpenClawBootWatcher, startSurgeOpenClawSupervisor } from "../entrypoints/surge-openclaw-supervisor.js";
import { createBuilderSurgeGateWiring } from "../lib/fleet-provisioner.js";
import * as builderStores from "../lib/openclaw-builder-store-preflight.js";
import type { CustomerLifecycleAdapter } from "../lib/customer-lifecycle.js";
import { stubBuilderClaim } from "./helpers/builder-claim.js";

const roots: string[] = [];

async function temporaryOpenClawDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-surge-openclaw-process-"));
  roots.push(root);
  return root;
}

class FakeChild extends EventEmitter {
  alive = true;
  constructor(private readonly ignoresSigterm = false) {
    super();
  }
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGTERM" && this.ignoresSigterm) return this.alive;
    if (!this.alive) return false;
    this.alive = false;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  });
}

function healthzOf(children: FakeChild[]): () => Promise<boolean> {
  return async () => children.some((child) => child.alive);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("surge OpenClaw process gate", () => {
  it("defaults a fresh or stale-pod record to held", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);

    await expect(gate.ensure({ podUid: "pod-new", readinessReleased: false })).resolves.toMatchObject({
      podUid: "pod-new",
      role: "normal",
      mode: "held",
      phase: "held",
    });

    await fs.writeFile(
      path.join(openclawDir, SURGE_OPENCLAW_PROCESS_GATE_FILE),
      JSON.stringify({
        version: 1,
        podUid: "pod-old",
        role: "normal",
        mode: "permitted",
        phase: "running",
      }),
    );

    await expect(gate.ensure({ podUid: "pod-newer", readinessReleased: false })).resolves.toMatchObject({
      podUid: "pod-newer",
      mode: "held",
      phase: "held",
    });
  });

  it("persists source stopping before target transfer and resumes any held source", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "source-pod", readinessReleased: true });
    const request = {
      podUid: "source-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await expect(gate.hold(request)).resolves.toMatchObject({
      role: "source",
      mode: "held",
      phase: "stopping",
    });
    await expect(gate.markHeld(request)).resolves.toMatchObject({ phase: "held" });
    await expect(gate.resumeSource({ ...request, migrationId: "surge-gateway-replaced" }))
      .resolves.toMatchObject({
        role: "source",
        mode: "permitted",
        phase: "starting",
      });
  });

  it("retains completion-started evidence across a target rehold and supervisor restart", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    const request = { podUid: "target-pod", migrationId: "surge-gateway-target", slug: "ceckert-test", targetPodUid: "target-pod" };
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    await gate.hydrateTarget(request);
    expect(await gate.claimTargetCompletion(request)).toMatchObject({ completionStarted: true });
    await gate.permitTarget(request);
    await gate.reholdTarget(request);
    await gate.markHeld(request);
    expect(await createSurgeOpenClawProcessGate(openclawDir).read()).toMatchObject({
      role: "target", mode: "held", phase: "held", completionStarted: true,
    });
    await gate.reholdTarget(request);
    expect(await gate.finalizeTargetCancellation(request)).toMatchObject({
      terminalTarget: { migrationId: request.migrationId, slug: request.slug, targetPodUid: request.targetPodUid, completionStarted: true },
    });
  });

  it("settles a completed migration back to a normal record and refuses to settle a held one", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    const request = {
      podUid: "target-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await gate.hydrateTarget(request);
    await expect(gate.settle({ podUid: "target-pod" })).rejects.toThrow(
      "cannot settle a held surge OpenClaw process gate",
    );
    await gate.claimTargetCompletion(request);
    await gate.permitTarget(request);
    await gate.markRunning({ podUid: "target-pod", migrationId: request.migrationId });
    await expect(gate.settle({ podUid: "target-pod" })).resolves.toEqual({
      version: 1,
      podUid: "target-pod",
      role: "normal",
      mode: "permitted",
      phase: "running",
    });
  });

  it("lets a new migration hold through an unsettled finished one but never an active start", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    const finished = {
      podUid: "target-pod",
      migrationId: "surge-gateway-finished",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };
    const next = { ...finished, migrationId: "surge-gateway-next", targetPodUid: "other-target" };

    await gate.hydrateTarget(finished);
    await gate.claimTargetCompletion(finished);
    await gate.permitTarget(finished);
    await expect(gate.hold(next)).rejects.toThrow("belongs to surge-gateway-finished");
    await gate.markRunning({ podUid: "target-pod", migrationId: finished.migrationId });
    await expect(gate.hold(next)).resolves.toMatchObject({
      role: "source",
      mode: "held",
      phase: "stopping",
      migrationId: "surge-gateway-next",
    });
  });

  it("keeps a target reservation across unreserve mismatches and clears only its own", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    const request = {
      podUid: "target-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await gate.hydrateTarget(request);
    await expect(gate.unreserveTarget({ ...request, migrationId: "other" })).rejects.toThrow(
      "does not reserve this target migration",
    );
    await expect(gate.unreserveTarget(request)).resolves.toEqual({
      version: 1,
      podUid: "target-pod",
      role: "normal",
      mode: "held",
      phase: "held",
      terminalTarget: { migrationId: request.migrationId, slug: request.slug, targetPodUid: request.targetPodUid, completionStarted: false },
    });
    await expect(gate.unreserveTarget(request)).resolves.toMatchObject({ role: "normal" });
  });

  it("refuses a stale target permit after its matching unreserve", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    const request = {
      podUid: "target-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await gate.hydrateTarget(request);
    await gate.unreserveTarget(request);

    await expect(gate.permitTarget(request)).rejects.toThrow(
      "does not reserve this target migration",
    );
    await expect(gate.reholdTarget(request)).rejects.toThrow(
      "does not reserve this target migration",
    );
    await expect(gate.read()).resolves.toEqual({
      version: 1,
      podUid: "target-pod",
      role: "normal",
      mode: "held",
      phase: "held",
      terminalTarget: { migrationId: request.migrationId, slug: request.slug, targetPodUid: request.targetPodUid, completionStarted: false },
    });
  });

  it("restarts a released pod serving and keeps held records held except healed normal residue", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    const request = {
      podUid: "pod-a",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "pod-a",
    };

    await gate.ensure({ podUid: "pod-a", readinessReleased: false });
    await gate.hydrateTarget(request);
    await expect(gate.ensure({ podUid: "pod-a", readinessReleased: true })).resolves.toMatchObject({
      role: "target",
      mode: "held",
      migrationId: request.migrationId,
    });

    await gate.claimTargetCompletion(request);
    await gate.permitTarget(request);
    await expect(gate.ensure({ podUid: "pod-a", readinessReleased: false })).resolves.toMatchObject({
      role: "target",
      mode: "held",
      phase: "held",
    });

    await gate.claimTargetCompletion(request);
    await gate.permitTarget(request);
    await expect(gate.ensure({ podUid: "pod-a", readinessReleased: true })).resolves.toEqual({
      version: 1,
      podUid: "pod-a",
      role: "normal",
      mode: "permitted",
      phase: "starting",
      terminalTarget: {
        migrationId: request.migrationId,
        slug: request.slug,
        targetPodUid: request.targetPodUid,
        completionStarted: true,
      },
    });
    await expect(gate.hold(request)).rejects.toThrow("target migration already released");

    await gate.holdNormal({ podUid: "pod-a" });
    await expect(gate.ensure({ podUid: "pod-a", readinessReleased: true })).resolves.toMatchObject({
      role: "normal",
      mode: "permitted",
      phase: "starting",
    });
  });

  it("cancels a matching target permit before it can release readiness", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "target-pod", readinessReleased: false });
    const request = {
      podUid: "target-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await gate.hydrateTarget(request);
    await gate.claimTargetCompletion(request);
    await gate.permitTarget(request);
    await expect(gate.hold(request)).resolves.toMatchObject({
      role: "target",
      mode: "held",
      phase: "cancelling",
      migrationId: request.migrationId,
    });
  });

  it("preserves a target cancellation across restart and clears it only through its finalizer", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    const request = {
      podUid: "target-pod",
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };
    await gate.ensure({ podUid: request.podUid, readinessReleased: false });
    await gate.hydrateTarget(request);
    await gate.claimTargetCompletion(request);
    await expect(gate.hold(request)).resolves.toMatchObject({
      role: "target",
      mode: "held",
      phase: "cancelling",
    });
    await expect(gate.claimTargetCompletion(request)).rejects.toThrow("target completion is not held");
    await expect(gate.unreserveTarget(request)).rejects.toThrow("cannot unreserve a claimed");
    await expect(gate.ensure({ podUid: request.podUid, readinessReleased: false })).resolves.toMatchObject({
      role: "target",
      mode: "held",
      phase: "cancelling",
    });
    await expect(gate.finalizeTargetCancellation(request)).resolves.toEqual({
      version: 1,
      podUid: request.podUid,
      role: "normal",
      mode: "held",
      phase: "held",
      terminalTarget: { migrationId: request.migrationId, slug: request.slug, targetPodUid: request.targetPodUid, completionStarted: true },
    });
  });

  it("permits a proven no-sibling Builder without inventing a migration identity", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const gate = createSurgeOpenClawProcessGate(openclawDir);
    await gate.ensure({ podUid: "pod-self", readinessReleased: false });

    await expect(gate.permitNormal({ podUid: "pod-self" })).resolves.toEqual({
      version: 1,
      podUid: "pod-self",
      role: "normal",
      mode: "permitted",
      phase: "starting",
    });
  });
});

describe("surge OpenClaw process supervisor", () => {

  it("prepares SQLite journals before every cold start and source resume", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const order: string[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: "source-pod", log: () => undefined, socketPath,
      readinessReleased: async () => true,
      prepareDatabases: async () => { order.push("journals"); },
      spawnOpenClaw: () => { order.push("spawn"); const child = new FakeChild(); children.push(child); return child; },
      probeHealthz: healthzOf(children), healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = { migrationId: "migration-journals", slug: "jefe", targetPodUid: "target-pod" };
    try {
      await vi.waitFor(() => expect(children).toHaveLength(1));
      await client.hold(request);
      await client.resume(request);
      expect(order).toEqual(["journals", "spawn", "journals", "spawn"]);
    } finally { await supervisor.stop(); }
  });

  it("self-releases readiness on a standby boot and starts OpenClaw permitted", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const children: FakeChild[] = [];
    const log = vi.fn();
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: "standby-pod", log, socketPath, standbyBoot: true,
      prepareTarget: async () => undefined, prepareDatabases: async () => undefined,
      spawnOpenClaw: () => { const child = new FakeChild(); children.push(child); return child; },
      probeHealthz: healthzOf(children), healthTimeoutMs: 100,
    });
    try {
      await vi.waitFor(() => expect(children).toHaveLength(1));
      await expect(createSurgeReadinessGate(openclawDir, "standby-pod").released()).resolves.toBe(true);
      await vi.waitFor(() => expect(supervisor.state()).resolves.toMatchObject({ role: "normal", mode: "permitted", phase: "running" }));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("standby"));
    } finally { await supervisor.stop(); }
  });

  it("keeps a non-standby Builder boot held until a migration releases it", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const spawnOpenClaw = vi.fn(() => new FakeChild());
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: "owned-pod", log: () => undefined, socketPath,
      prepareTarget: async () => undefined, prepareDatabases: async () => undefined,
      spawnOpenClaw, probeHealthz: async () => false, healthTimeoutMs: 100,
    });
    try {
      await expect(supervisor.state()).resolves.toMatchObject({ mode: "held" });
      await expect(createSurgeReadinessGate(openclawDir, "owned-pod").released()).resolves.toBe(false);
      expect(spawnOpenClaw).not.toHaveBeenCalled();
    } finally { await supervisor.stop(); }
  });

  it("keeps OpenClaw held when journal integrity preparation fails", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const spawnOpenClaw = vi.fn(() => new FakeChild());
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: "source-pod", log: () => undefined, socketPath,
      readinessReleased: async () => false,
      prepareTarget: async () => undefined,
      prepareDatabases: async () => { throw new Error("database integrity refused"); },
      spawnOpenClaw, probeHealthz: async () => false, healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    try {
      await expect(client.permitNormal()).rejects.toThrow("database integrity refused");
      expect(spawnOpenClaw).not.toHaveBeenCalled();
      await expect(client.status()).resolves.toMatchObject({ phase: "held" });
    } finally { await supervisor.stop(); }
  });
  it("validates configured Builder anchors before Native runtime admission", async () => {
    const openclawDir = await temporaryOpenClawDir(), socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const order: string[] = [], children: FakeChild[] = [];
    const inspection = vi.spyOn(builderStores, "inspectConfiguredBuilderAgentStores")
      .mockImplementationOnce(async () => { expect(children).toHaveLength(0); order.push("inspect"); return "exact"; });
    const bootWatcher = createSurgeOpenClawBootWatcher({
      openclawDir, releaseKey: "builder-release", log: () => {}, env: { GATEWAY_CLASS: "builder", OPENCLAW_CONFIG_PATH: path.join(openclawDir, "system_config/openclaw.json") },
      client: { claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "start" }), completeOpenClawBoot: vi.fn(), completeOpenClawDoctor: vi.fn() },
      run: async () => { expect(children).toHaveLength(0); order.push("doctor"); },
    });
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: "builder-pod", socketPath, log: () => {}, readinessReleased: async () => false,
      prepareTarget: async () => {}, prepareDatabases: async () => {}, bootWatcher,
      spawnOpenClaw: () => { order.push("spawn"); const child = new FakeChild(); children.push(child); return child; },
      probeHealthz: healthzOf(children), healthTimeoutMs: 100,
    });
    try {
      await createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath }).permitNormal();
      expect(order).toEqual(["inspect", "spawn"]);
      expect(inspection).toHaveBeenCalledWith({ stateDir: openclawDir, configPath: path.join(openclawDir, "system_config/openclaw.json") });
    } finally { await supervisor.stop(); inspection.mockRestore(); }
  });

  it("keeps the Builder process held when configured-store inspection refuses startup", async () => {
    const openclawDir = await temporaryOpenClawDir(), socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const inspection = vi.spyOn(builderStores, "inspectConfiguredBuilderAgentStores").mockRejectedValue(new Error("newer store schema refused"));
    const spawnOpenClaw = vi.fn(() => new FakeChild());
    const bootWatcher = createSurgeOpenClawBootWatcher({ openclawDir, releaseKey: "builder-release", log: () => {}, env: { GATEWAY_CLASS: "builder" },
      client: { claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "start" }), completeOpenClawBoot: vi.fn(), completeOpenClawDoctor: vi.fn() }, run: vi.fn() });
    const supervisor = await startSurgeOpenClawSupervisor({ openclawDir, podUid: "builder-pod", socketPath, log: () => {},
      readinessReleased: async () => false, prepareTarget: async () => {}, prepareDatabases: async () => {}, bootWatcher, spawnOpenClaw, probeHealthz: async () => false });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    try { await expect(client.permitNormal()).rejects.toThrow("newer store schema refused"); expect(spawnOpenClaw).not.toHaveBeenCalled();
      await expect(client.status()).resolves.toMatchObject({ phase: "held" });
    } finally { await supervisor.stop(); inspection.mockRestore(); }
  });

  it("does not apply Builder configured-store inspection to a Shared supervisor", async () => {
    const inspection = vi.spyOn(builderStores, "inspectConfiguredBuilderAgentStores"), run = vi.fn();
    try { await createSurgeOpenClawBootWatcher({ openclawDir: "/unused/shared", releaseKey: "shared-release", log: () => {}, env: { GATEWAY_CLASS: "shared" },
      client: { claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "start" }), completeOpenClawBoot: vi.fn(), completeOpenClawDoctor: vi.fn() }, run }).beforeStart();
      expect(inspection).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    } finally { inspection.mockRestore(); }
  });

  it.each(["retry", "cancel"] as const)("retains failed Builder database admission for an explicit %s", async scenario => {
    stubBuilderClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const readiness = createSurgeReadinessGate(openclawDir, "target-pod");
    const request = { migrationId: "surge-admission-retry", slug: "ceckert-test", targetPodUid: "target-pod" };
    const children: FakeChild[] = [];
    const credentials = path.join(openclawDir, "synthetic-client-credentials");
    const prepareDatabases = vi.fn(async () => {
      if (prepareDatabases.mock.calls.length === 1) {
        await fs.writeFile(credentials, "rebound");
        throw new Error("Doctor interrupted after credential rebind");
      }
      expect(await fs.readFile(credentials, "utf8")).toBe("rebound");
    });
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir, podUid: request.targetPodUid, socketPath, log: () => undefined,
      readinessReleased: readiness.released,
      prepareTarget: async () => undefined, prepareDatabases,
      bootWatcher: { beforeStart: async () => undefined, healthy: async () => undefined },
      spawnOpenClaw: () => { const child = new FakeChild(); children.push(child); return child; },
      probeHealthz: healthzOf(children), healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const adapter = {
      isBuilderGateway: () => true,
      isConfiguredBuilderCustomer: (slug: string) => slug === request.slug,
      configuredBuilderOverlayPresent: () => true,
      listLocalCustomerSlugs: () => [request.slug], customerMountMarked: () => true,
      hasWorkspaceGitDir: () => true, hasGitRemote: () => true,
    } as unknown as CustomerLifecycleAdapter;
    const waitForGatewayReady = vi.fn(async () => {
      expect(await client.status()).toMatchObject({ role: "target", mode: "permitted", phase: "running", ...request });
      expect(await readiness.released()).toBe(false);
      expect(prepareDatabases).toHaveBeenCalledTimes(2);
    });
    const wiring = createBuilderSurgeGateWiring({
      openclawDir, adapter, processGate: client, surgeReadiness: readiness, log: () => undefined,
      provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
      attachConfiguredBuilderBeforeOpenClaw: async () => request.slug,
      waitForGatewayHealthy: async () => undefined, waitForGatewayReady,
    });
    try {
      await client.hydrate(request);
      await expect(wiring.releaseSurgeReadiness(request)).rejects.toThrow("Doctor interrupted after credential rebind");
      expect(children).toHaveLength(0);
      expect(waitForGatewayReady).not.toHaveBeenCalled();
      await expect(client.status()).resolves.toEqual({ version: 1, podUid: request.targetPodUid,
        role: "target", mode: "held", phase: "held", completionStarted: true, ...request });
      expect(await readiness.released()).toBe(false);

      if (scenario === "cancel") {
        await expect(wiring.unreserveSurgeTarget(request)).resolves.toMatchObject({
          role: "normal", mode: "held", phase: "held", terminalTarget: request,
        });
        await expect(wiring.releaseSurgeReadiness(request)).rejects.toThrow("not reserved by this migration");
        expect(prepareDatabases).toHaveBeenCalledOnce();
        expect(children).toHaveLength(0);
        expect(await readiness.released()).toBe(false);
        return;
      }
      await wiring.releaseSurgeReadiness(request);
      expect(prepareDatabases).toHaveBeenCalledTimes(2);
      expect(children).toHaveLength(1);
      expect(waitForGatewayReady).toHaveBeenCalledOnce();
      expect(await readiness.released()).toBe(true);
      await expect(client.status()).resolves.toMatchObject({ role: "normal", mode: "permitted", phase: "running", terminalTarget: request });
    } finally {
      await supervisor.stop();
      vi.unstubAllEnvs();
    }
  });

  it("permits startup after the supervisor closes an idle socket during blocked setup", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const socketPath = path.join(openclawDir, "supervisor.sock");
    const closed = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(`
      const http = require("node:http");
      const { parentPort, workerData } = require("node:worker_threads");
      let socket;
      const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => res.end(JSON.stringify({
          version: 1, podUid: "target-pod", role: "normal", mode: "held", phase: "held",
        })));
      });
      server.on("connection", (connected) => { socket = connected; });
      server.listen(workerData.socketPath, () => parentPort.postMessage("ready"));
      parentPort.on("message", () => {
        socket.destroy();
        setImmediate(() => {
          Atomics.store(workerData.closed, 0, 1);
          Atomics.notify(workerData.closed, 0);
        });
      });
    `, { eval: true, workerData: { socketPath, closed } });
    try {
      await once(worker, "message");
      const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
      await client.status();
      await new Promise<void>((resolve) => setImmediate(resolve));
      worker.postMessage("expire-idle-connection");
      expect(Atomics.wait(closed, 0, 0, 5_000)).not.toBe("timed-out");

      await expect(client.permitNormal()).resolves.toMatchObject({ podUid: "target-pod" });
    } finally {
      await worker.terminate();
    }
  });

  it("refuses an unsupervised OpenClaw before preparing target state it could still be writing", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const prepareTarget = vi.fn(async () => undefined);
    const prepareDatabases = vi.fn(async () => undefined);
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget,
      prepareDatabases,
      spawnOpenClaw: () => new FakeChild(),
      probeHealthz: async () => true,
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = { migrationId: "surge-gateway-orphan", slug: "ceckert-test", targetPodUid: "target-pod" };
    try {
      await client.hydrate(request);
      await client.claimTargetCompletion(request);

      await expect(client.permit(request)).rejects.toThrow(/refusing to start a second gateway/u);
      expect(prepareTarget).not.toHaveBeenCalled();
      expect(prepareDatabases).not.toHaveBeenCalled();
    } finally {
      await supervisor.stop();
    }
  });

  it("owns a target child only after permit, prepares it after transfer, and returns it held on abort", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const prepareTarget = vi.fn(async () => undefined);
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children),
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await expect(client.status()).resolves.toMatchObject({ mode: "held", phase: "held" });
    await client.hydrate(request);
    await client.claimTargetCompletion(request);
    await expect(client.permit(request)).resolves.toMatchObject({
      role: "target",
      mode: "permitted",
      phase: "running",
    });
    expect(prepareTarget).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);

    await expect(client.hold(request)).resolves.toMatchObject({
      role: "target",
      mode: "held",
      phase: "cancelling",
    });
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(client.releaseTarget(request)).rejects.toThrow("does not permit this target migration");
    await expect(createSurgeReadinessGate(openclawDir, "target-pod").released()).resolves.toBe(false);
    await supervisor.stop();
  });

  it("rejects a delayed matching target hold after target release commits", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget: async () => undefined,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children),
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await client.hydrate(request);
    await client.claimTargetCompletion(request);
    await client.permit(request);
    await expect(client.releaseTarget(request)).resolves.toMatchObject({
      role: "normal",
      mode: "permitted",
      terminalTarget: request,
    });
    await expect(createSurgeReadinessGate(openclawDir, "target-pod").released()).resolves.toBe(true);

    await expect(client.hold(request)).rejects.toThrow("target migration already released");
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await expect(client.status()).resolves.toMatchObject({
      role: "normal",
      mode: "permitted",
      terminalTarget: request,
    });
    await supervisor.stop();
  });

  it("rolls back only the named released target and keeps it held across restart before retry", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const options = {
      openclawDir, podUid: "target-pod", socketPath,
      log: () => undefined,
      prepareTarget: async () => undefined,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children), healthTimeoutMs: 100,
    };
    let supervisor = await startSurgeOpenClawSupervisor(options);
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = { migrationId: "activation-1", slug: "chris", targetPodUid: "target-pod" };
    try {
      await client.hydrate(request);
      await client.claimTargetCompletion(request);
      await client.permit(request);
      await client.releaseTarget(request);
      for (const mismatch of [
        { ...request, migrationId: "stale-activation" },
        { ...request, slug: "someone-else" },
        { ...request, targetPodUid: "old-pod" },
      ]) {
        await expect(client.reholdReleasedTarget(mismatch)).rejects.toThrow("released target does not match");
      }
      expect(children[0]!.alive).toBe(true);
      await expect(createSurgeReadinessGate(openclawDir).released()).resolves.toBe(true);

      await expect(client.reholdReleasedTarget(request)).resolves.toMatchObject({
        role: "target", mode: "held", phase: "cancelling",
      });
      expect(children[0]!.alive).toBe(false);
      await expect(createSurgeReadinessGate(openclawDir).released()).resolves.toBe(false);
      await client.finalizeTargetCancellation(request);
      await supervisor.stop();
      supervisor = await startSurgeOpenClawSupervisor(options);
      await expect(client.status()).resolves.toMatchObject({ role: "normal", mode: "held", phase: "held" });
      expect(children).toHaveLength(1);
      await expect(client.hydrate({ ...request, migrationId: "activation-2" })).resolves.toMatchObject({
        role: "target", mode: "held", migrationId: "activation-2",
      });
      await expect(client.reholdReleasedTarget(request)).rejects.toThrow("released target does not match");
    } finally {
      await supervisor.stop();
    }
  });

  it("retries one target child exit before health and reports an exit only after the retry is healthy", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const prepareTarget = vi.fn(async () => undefined);
    const onUnexpectedChildExit = vi.fn();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const bootWatcher = {
      beforeStart: vi.fn(async () => undefined),
      healthy: vi.fn(async () => undefined),
    };
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget,
      onUnexpectedChildExit,
      bootWatcher,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        if (children.length === 1) {
          queueMicrotask(() => {
            child.alive = false;
            child.emit("exit", 1, null);
          });
        }
        return child;
      },
      probeHealthz: async () => children.at(-1)?.alive === true,
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await client.hydrate(request);
    await client.claimTargetCompletion(request);
    await expect(client.permit(request)).resolves.toMatchObject({
      role: "target",
      mode: "permitted",
      phase: "running",
    });
    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(2);
    expect(bootWatcher.beforeStart).toHaveBeenCalledTimes(2);
    expect(bootWatcher.healthy).toHaveBeenCalledOnce();
    expect(onUnexpectedChildExit).not.toHaveBeenCalled();

    children[1]!.alive = false;
    children[1]!.emit("exit", 1, null);
    expect(onUnexpectedChildExit).toHaveBeenCalledOnce();
    await supervisor.stop();
  });

  it("holds the target and reports the second pre-health child exit", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const prepareTarget = vi.fn(async () => undefined);
    const onUnexpectedChildExit = vi.fn();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget,
      onUnexpectedChildExit,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: async () => {
        const newest = children.at(-1);
        if (newest?.alive) {
          newest.alive = false;
          newest.emit("exit", 1, null);
        }
        return false;
      },
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await client.hydrate(request);
    await client.claimTargetCompletion(request);
    await expect(client.permit(request)).rejects.toThrow("OpenClaw exited before becoming healthy");
    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(onUnexpectedChildExit).toHaveBeenCalledOnce();
    await expect(client.status()).resolves.toMatchObject({ mode: "held", phase: "held" });
    await supervisor.stop();
  });

  it("stops and restarts a source only through its matching durable hold", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "source-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => true,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children),
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await vi.waitFor(() => expect(children).toHaveLength(1));
    await expect(client.hold(request)).resolves.toMatchObject({ role: "source", phase: "held" });
    await expect(client.resume(request)).resolves.toMatchObject({
      role: "normal",
      mode: "permitted",
      phase: "running",
    });
    expect(children).toHaveLength(2);
    await expect(client.hold({ ...request, migrationId: "surge-gateway-next" }))
      .resolves.toMatchObject({
        role: "source",
        mode: "held",
        phase: "held",
        migrationId: "surge-gateway-next",
      });
    await supervisor.stop();
  });

  it("answers status while a permit is still cloning and starting OpenClaw", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    let enteredPrepare = () => {};
    let releasePrepare = () => {};
    const prepareEntered = new Promise<void>((resolve) => { enteredPrepare = resolve; });
    const prepareBlocked = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget: async () => {
        enteredPrepare();
        await prepareBlocked;
      },
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children),
      healthTimeoutMs: 1_000,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    const request = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };

    await client.hydrate(request);
    await client.claimTargetCompletion(request);
    const permit = client.permit(request);
    await prepareEntered;

    await expect(client.status()).resolves.toMatchObject({ mode: "permitted" });

    releasePrepare();
    await expect(permit).resolves.toMatchObject({ phase: "running" });
    await supervisor.stop();
  });

  it("escalates to SIGKILL when OpenClaw ignores SIGTERM past the stop grace", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "source-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => true,
      spawnOpenClaw: () => {
        const child = new FakeChild(true);
        children.push(child);
        return child;
      },
      probeHealthz: healthzOf(children),
      healthTimeoutMs: 100,
      stopGraceMs: 10,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });
    await vi.waitFor(() => expect(children).toHaveLength(1));

    await expect(client.holdNormal()).resolves.toMatchObject({ mode: "held", phase: "held" });
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(children[0]!.alive).toBe(false);
    await supervisor.stop();
  });

  it("refuses to start beside an unsupervised OpenClaw already answering healthz", async () => {
    const openclawDir = await temporaryOpenClawDir();
    const children: FakeChild[] = [];
    const socketPath = path.join(os.tmpdir(), `oc-gate-${randomUUID()}.sock`);
    const supervisor = await startSurgeOpenClawSupervisor({
      openclawDir,
      podUid: "target-pod",
      log: () => undefined,
      socketPath,
      readinessReleased: async () => false,
      prepareTarget: async () => undefined,
      spawnOpenClaw: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probeHealthz: async () => true,
      healthTimeoutMs: 100,
    });
    const client = createSurgeOpenClawProcessSupervisorClient(openclawDir, { socketPath });

    await expect(client.permitNormal()).rejects.toThrow(/refusing to start a second gateway/);
    expect(children).toHaveLength(0);
    await expect(client.status()).resolves.toMatchObject({ role: "normal", mode: "held" });
    await supervisor.stop();
  });
});
