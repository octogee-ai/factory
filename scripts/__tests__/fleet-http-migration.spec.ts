

import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { pendingCloneAppliedFingerprint } from "../lib/pending-clone-fingerprint";
import type { Request, Response } from "express";
import { EventEmitter } from "node:events";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  createMigrationProgressHandler,
  createActivateImportHandler,
  createActivationManifestExportHandler,
  createAbortRsyncImportHandler,
  createCompleteSurgeHandoffHandler,
  createExportPathsHandler,
  createFlushHandler,
  createFinishRsyncImportHandler,
  createPrepareImportHandler,
  createPrepareRsyncImportHandler,
  createPushRsyncStateHandler,
  createQuiesceHandler,
  createSchedulerMigrationHandler,
  createSchedulerReadyHandler,
  createResumeHandler,
  createRestoreHandler,
  createUnmountHandler,
  createVerifyHandler,
  findPathTraversalViolation,
  type MigrationHandlerDeps,
} from "../lib/fleet-http-migration.js";
import { gatewayScopedJobId, signFleetRequest } from "../lib/fleet-signature.js";
import {
  MIGRATION_VERIFY_COACH_ATTACH_IN_PROGRESS,
  SIGNATURE_HEADER,
  type QuiesceRequestBody,
  type UnmountRequestBody,
  type ExportPathsRequestBody,
  type PrepareImportRequestBody,
  type ActivateImportRequestBody,
  type ActivationManifestExportRequestBody,
  type AbortRsyncImportRequestBody,
  type FinishRsyncImportRequestBody,
  type PrepareRsyncImportRequestBody,
  type PushRsyncStateRequestBody,
  type CompleteSurgeHandoffRequestBody,
} from "../../shared/types/fleet-controller.js";
import type { CustomerLifecycleAdapter } from "../lib/customer-lifecycle.js";
import type { ConfiguredBuilderPortableStatePlan } from "../lib/local-coach-wired.js";
import {
  hasMountedMarker,
  writeMigratingInPin,
  writeMountedMarker,
} from "../lib/local-coach-wired.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";
import { OpenclawWireError } from "../lib/gateway-rpc.js";

const spawnMock = vi.fn();
const upgradeStoresMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/agent-store-upgrade.js", () => ({ upgradeStagedAgentStores: upgradeStoresMock }));
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const migrationTempRoots: string[] = [];

const PRIVATE_KEY = FLEET_KEY_PAIR.privateKey;
const PUBLIC_KEY = FLEET_KEY_PAIR.publicKey;
const GATEWAY_ID = "gw-a";
const SOURCE_POD_IP = ["10", "1", "0", "10"].join(".");
const TARGET_POD_IP = ["10", "1", "0", "20"].join(".");
const SAMPLE_QUIESCE: QuiesceRequestBody = {
  migrationId: "mig-1",
  slug: "chris",
  timeoutMs: 5_000,
};

const SAMPLE_UNMOUNT: UnmountRequestBody = {
  migrationId: "mig-1",
  slug: "chris",
};

const SAMPLE_COMPLETE_SURGE: CompleteSurgeHandoffRequestBody = {
  migrationId: "surge-gw-a-pod-123",
  targetPodUid: "pod-123",
};

const HELD_BUILDER_GATE_STATE = {
  version: 1, podUid: "builder-pod", role: "normal", mode: "held", phase: "held",
} as const;

const RESTORE_SNAPSHOT = {
  uid: "uid-chris",
  slug: "chris",
  tier: "trial",
  gatewayId: GATEWAY_ID,
  status: "complete",
  agentIds: ["octogee-chris-coach"],
  repoUrl: "git@gitea:octogee/chris.git",
  mattermostUserId: "mmuser-chris",
  customerMmUserId: "mmuser-chris",
  channels: [],
  projects: [],
  ownerName: "Chris",
  email: "chris@example.com",
  displayName: "Chris",
  lastName: "",
  photoURL: "",
  onboardingVibe: null,
  coachToken: "coach-token",
  coachMmUserId: "mm-coach",
} as const;

// Cowboy scopes every pod-addressed signature to the gateway it addresses; the
// handlers reject anything minted for a sibling.
function signForPod(jobId: string, rawBody: string, gatewayId: string = GATEWAY_ID): string {
  return signFleetRequest(PRIVATE_KEY, gatewayScopedJobId(jobId, gatewayId), rawBody);
}

function mkRequest<T>(
  body: T,
  opts: {
    signature?: string;
    rawBody?: string;
    localAddress?: string;
    pathGatewayId?: string;
  } = {},
): Request {
  const rawBody = opts.rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (opts.signature !== undefined) headers[SIGNATURE_HEADER.toLowerCase()] = opts.signature;
  return {
    header: (name: string) => headers[name.toLowerCase()],
    params: { gatewayId: opts.pathGatewayId ?? GATEWAY_ID },
    rawBody,
    socket: {
      localAddress: opts.localAddress,
      address: () => ({ address: opts.localAddress ?? "127.0.0.1", family: "IPv4", port: 3003 }),
    },
  } as unknown as Request;
}

function mkResponse(): {
  res: Response;
  getStatus: () => number | undefined;
  getBody: () => unknown;
  getHeaders: () => Record<string, string>;
  destroyed: () => Error | null;
} {
  let status: number | undefined;
  let payload: unknown;
  const headers: Record<string, string> = {};
  let destroyError: Error | null = null;

const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  let headersSent = false;
  const res = Object.assign(sink, {
    headersSent: false,
    status(this: Response, code: number) {
      status = code;
      headersSent = true;
      Object.defineProperty(this, "headersSent", {
        get: () => headersSent,
        configurable: true,
      });
      return this;
    },
    json(this: Response, b: unknown) {
      payload = b;
      headersSent = true;
      return this;
    },
    setHeader(this: Response, name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    destroy(this: Response, err?: Error) {
      destroyError = err ?? null;
      return this;
    },
  }) as unknown as Response;
  return {
    res,
    getStatus: () => status,
    getBody: () => payload,
    getHeaders: () => headers,
    destroyed: () => destroyError,
  };
}

it("transfers only the selected customer's Git metadata", () => {
  expect(findPathTraversalViolation(["git-metadata/alice/projects/app.git/refs/heads/work", "git-metadata/alice/projects/app.git/index"], "alice", "final")).toBeNull();
  expect(findPathTraversalViolation(["git-metadata/bob/projects/app.git/index"], "alice", "final")).not.toBeNull();
  expect(findPathTraversalViolation(["git-metadata/alice/../../bob/index"], "alice", "final")).not.toBeNull();
});

function mkAdapter(overrides: Partial<CustomerLifecycleAdapter> = {}): CustomerLifecycleAdapter {
  const everythingElseThrows = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        vi.fn(() => {
          throw new Error(`unexpected call to adapter.${prop} in migration handler test`);
        }),
    },
  ) as CustomerLifecycleAdapter;

  return {
    ...everythingElseThrows,
    log: vi.fn(),
    uidForSlug: vi.fn(async () => "uid-chris"),
    resumeCustomer: vi.fn(async () => undefined),
    quiesceCustomer: vi.fn(async () => ({ drained: true, runningCount: 0 })),
    listExportPaths: vi.fn(async () => [
      { cwd: "/tmp/state", path: "agents/octogee-chris-coach" },
    ]),
    prepareImportDir: vi.fn(async () => "/tmp/import"),
    prepareKeyImportDir: vi.fn(async () => "/tmp/import"),
    readLocalCustomerPubKey: vi.fn(() => "ssh-ed25519 LOCAL chris@gateway"),
    createGiteaUser: vi.fn(async () => undefined),
    activateImportedCustomer: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
    projectCheckoutScope: vi.fn(() => "workspace-and-projects"),
    listProjectsNeedingClone: vi.fn(async () => []),
    cloneProjectRepo: vi.fn(async () => true),
    seedDeferredProjectWorkspace: vi.fn(async () => undefined),
    reassertByotForCustomer: vi.fn(async () => undefined),
    writeMountMarker: vi.fn(),
    onMounted: vi.fn(),
    isConfiguredBuilderCustomer: vi.fn(() => true),
    waitForAccountHealthy: vi.fn(async () => true),
    hasCustomerDir: vi.fn(() => true),
    customerCoachWiredInOpenclawConfig: vi.fn(() => true),
    customerMountMarked: vi.fn(() => true),
    applyRemoveCustomerConfigPatch: vi.fn(async () => {}),
    deleteCustomerDir: vi.fn(async () => {}),
    deleteDepartedCustomerState: vi.fn(async () => {}),
    loadUserSnapshot: vi.fn(async () => ({
      uid: "uid-chris",
      slug: "chris",
      tier: "trial",
      gatewayId: GATEWAY_ID,
      status: "complete",
      agentIds: ["octogee-chris-coach"],
      repoUrl: "git@gitea:octogee/chris.git",
      mattermostUserId: "mmuser-chris",
      channels: [],
      ownerName: "Chris",
    })),
    onUnmounted: vi.fn(),
    ...overrides,
  };
}

const TARGET_CERTIFICATE_PEM = "-----BEGIN CERTIFICATE-----\nTUlHUkFUSU9O\n-----END CERTIFICATE-----\n";
const RSYNC_DAEMON_LOOPBACK_PORT = 41873;

function mkDeps(overrides: Partial<MigrationHandlerDeps> = {}): MigrationHandlerDeps {
  return {
    publicKey: PUBLIC_KEY,
    gatewayId: GATEWAY_ID,
    adapter: mkAdapter(),
    voiceMigration: vi.fn(async () => ({ activeCalls: 0 })),
    log: vi.fn(),
    reserveLoopbackPort: async () => RSYNC_DAEMON_LOOPBACK_PORT,
    openMigrationTlsEndpoint: vi.fn(async () => ({
      certificatePem: TARGET_CERTIFICATE_PEM,
      close: async () => undefined,
    })),
    ...overrides,
  };
}

beforeEach(() => {
  spawnMock.mockReset();
  upgradeStoresMock.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of migrationTempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("surge handoff control", () => {
  it("opens pod readiness only for a signed request", async () => {
    const releaseSurgeReadiness = vi.fn(async () => undefined);
    const handler = createCompleteSurgeHandoffHandler(mkDeps({ releaseSurgeReadiness }));
    const rawBody = JSON.stringify(SAMPLE_COMPLETE_SURGE);
    const signature = signForPod(SAMPLE_COMPLETE_SURGE.migrationId, rawBody);
    const { res, getStatus, getBody } = mkResponse();

    await handler(mkRequest(SAMPLE_COMPLETE_SURGE, { signature }), res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ released: true, targetPodUid: "pod-123" });
    expect(releaseSurgeReadiness).toHaveBeenCalledWith({
      migrationId: SAMPLE_COMPLETE_SURGE.migrationId,
      targetPodUid: "pod-123",
    });
  });

  it("rejects an unsigned readiness release", async () => {
    const releaseSurgeReadiness = vi.fn(async () => undefined);
    const handler = createCompleteSurgeHandoffHandler(mkDeps({ releaseSurgeReadiness }));
    const { res, getStatus } = mkResponse();

    await handler(mkRequest(SAMPLE_COMPLETE_SURGE), res, vi.fn());

    expect(getStatus()).toBe(401);
    expect(releaseSurgeReadiness).not.toHaveBeenCalled();
  });
});

function mkFakeChild(opts: {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
  holdExit?: boolean;
} = {}): EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: () => boolean;
} {
  const stdout = new Readable({ read() { /* noop; caller pushes + ends */ } });
  for (const chunk of opts.stdout ?? []) stdout.push(chunk);
  stdout.push(null);
  const stderr = new Readable({ read() { /* noop */ } });
  for (const chunk of opts.stderr ?? []) stderr.push(chunk);
  stderr.push(null);
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: new Writable({
      write(_chunk, _enc, cb) { cb(); },
    }),
    exitCode: opts.exitCode ?? null,
    signalCode: null,
    kill: vi.fn(() => {
      if (!opts.holdExit) {
        setImmediate(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.signalCode = "SIGTERM";
          child.emit("exit", null, "SIGTERM");
        });
      }
      return true;
    }),
  });
  if (opts.exitCode !== undefined) {
    const code = opts.exitCode;

const armOnClose = (event: string | symbol) => {
      if (event === "close") {
        child.removeListener("newListener", armOnClose);
        setImmediate(() => child.emit("close", code));
      }
    };
    child.on("newListener", armOnClose);
  }
  return child;
}

describe("createQuiesceHandler", () => {
  it("does not pause the coach if the live voice registry cannot be checked", async () => {
    const adapter = mkAdapter();
    const response = mkResponse();
    const voiceMigration = vi.fn(async () => { throw new Error("voice registry unavailable"); });
    await createQuiesceHandler(mkDeps({ adapter, voiceMigration }))(mkRequest(SAMPLE_QUIESCE, { signature: signForPod(SAMPLE_QUIESCE.migrationId, JSON.stringify(SAMPLE_QUIESCE)) }), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(adapter.quiesceCustomer).not.toHaveBeenCalled();
  });

  it("defers before touching the coach while a voice call is active", async () => {
    const adapter = mkAdapter();
    const voiceMigration = vi.fn(async () => ({ activeCalls: 1 }));
    const response = mkResponse();
    await createQuiesceHandler(mkDeps({ adapter, voiceMigration }))(mkRequest(SAMPLE_QUIESCE, { signature: signForPod(SAMPLE_QUIESCE.migrationId, JSON.stringify(SAMPLE_QUIESCE)) }), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toMatchObject({ drained: false, runningCount: 1 });
    expect(adapter.quiesceCustomer).not.toHaveBeenCalled();
  });

  it("passes the whole-process rollout's ingress ownership through", async () => {
    const adapter = mkAdapter();
    const body = { ...SAMPLE_QUIESCE, stopMattermost: false };
    const response = mkResponse();
    await createQuiesceHandler(mkDeps({ adapter }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(adapter.quiesceCustomer).toHaveBeenCalledWith("chris", 5_000, { stopMattermost: false });
  });
  it("passes a partial scheduler handoff through to the customer quiesce", async () => {
    const adapter = mkAdapter();
    const body = { ...SAMPLE_QUIESCE, schedulerHandoff: true, schedulerMigrationId: "mig-1:scheduler:1", retainNonportable: true };
    const response = mkResponse();
    await createQuiesceHandler(mkDeps({ adapter }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(adapter.quiesceCustomer).toHaveBeenCalledWith("chris", 5_000, { stopMattermost: true, schedulerMigrationId: "mig-1:scheduler:1", retainNonportable: true });
  });
  it("ignores the partial flag outside a scheduler handoff", async () => {
    const adapter = mkAdapter();
    const body = { ...SAMPLE_QUIESCE, retainNonportable: true };
    const response = mkResponse();
    await createQuiesceHandler(mkDeps({ adapter }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(adapter.quiesceCustomer).toHaveBeenCalledWith("chris", 5_000);
  });
  it("rejects bad signature with 401", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const req = mkRequest(SAMPLE_QUIESCE, { signature: "deadbeef" });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(401);
    expect(getBody()).toEqual({ error: "invalid signature" });
  });

  it("rejects invalid JSON body with 400", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const req = mkRequest(SAMPLE_QUIESCE, { rawBody: "{not json" });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
  });

  it("checks the path gatewayId only after the signature, so an unsigned probe cannot identify the pod", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const unsigned = mkRequest(SAMPLE_QUIESCE, { pathGatewayId: "someone-else" });
    const { res, getStatus, getBody } = mkResponse();

    await handler(unsigned, res, vi.fn());

    expect(getStatus()).toBe(401);
    expect(getBody()).toEqual({ error: "invalid signature" });
  });

  it("refuses a signature minted for a sibling gateway, so a relayed capture cannot act here", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    // What a sibling pod would hold after receiving its own signed quiesce: a
    // valid Cowboy signature whose scope names that other gateway.
    const relayed = mkRequest(SAMPLE_QUIESCE, {
      signature: signForPod(SAMPLE_QUIESCE.migrationId, rawBody, "someone-else"),
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(relayed, res, vi.fn());

    expect(getStatus()).toBe(401);
    expect(getBody()).toEqual({ error: "invalid signature" });
  });

  it("rejects a signed quiesce addressed to another gateway without naming this one", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    const req = mkRequest(SAMPLE_QUIESCE, {
      signature: signForPod(SAMPLE_QUIESCE.migrationId, rawBody),
      pathGatewayId: "someone-else",
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(JSON.stringify(getBody())).not.toContain(GATEWAY_ID);
  });

  it("rejects missing migrationId/slug with 400", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const req = mkRequest({} as QuiesceRequestBody, {
      signature: signForPod("x", "{}"),
    });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
  });

  it("rejects malformed slug with 400", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const body: QuiesceRequestBody = { migrationId: "m", slug: "../etc" };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "invalid slug" });
  });

  it("returns 200 + drained:true when adapter reports clean drain", async () => {
    const adapter = mkAdapter();
    const handler = createQuiesceHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    const sig = signForPod(SAMPLE_QUIESCE.migrationId, rawBody);
    const req = mkRequest(SAMPLE_QUIESCE, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      migrationId: SAMPLE_QUIESCE.migrationId,
      slug: SAMPLE_QUIESCE.slug,
      drained: true,
      runningCount: 0,
    });
    expect(adapter.quiesceCustomer).toHaveBeenCalledWith("chris", 5_000);
  });

  it("returns 200 + drained:false when active work defers the move", async () => {
    const adapter = mkAdapter({
      quiesceCustomer: vi.fn(async () => ({ drained: false, runningCount: 2 })),
    });
    const handler = createQuiesceHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    const sig = signForPod(SAMPLE_QUIESCE.migrationId, rawBody);
    const req = mkRequest(SAMPLE_QUIESCE, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ drained: false, runningCount: 2 });
  });

  it("defaults timeoutMs to 60_000 when omitted", async () => {
    const adapter = mkAdapter();
    const handler = createQuiesceHandler(mkDeps({ adapter }));
    const body: QuiesceRequestBody = { migrationId: "m", slug: "chris" };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res } = mkResponse();
    await handler(req, res, vi.fn());
    expect(adapter.quiesceCustomer).toHaveBeenCalledWith("chris", 60_000);
  });

  it("returns 500 when adapter throws", async () => {
    const adapter = mkAdapter({
      quiesceCustomer: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const handler = createQuiesceHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    const sig = signForPod(SAMPLE_QUIESCE.migrationId, rawBody);
    const req = mkRequest(SAMPLE_QUIESCE, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ error: "quiesce failed", message: "boom" });
  });
});

describe("createFlushHandler", () => {
  it("reclaims the source SSH key before a migration-final durable flush", async () => {
    const createGiteaUser = vi.fn(async () => undefined);
    const flushLocalState = vi.fn(async () => ({
      ok: true,
      durationMs: 12,
      steps: [],
    }));
    const adapter = mkAdapter({
      readLocalCustomerPubKey: vi.fn(() => "ssh-ed25519 SOURCE chris@gateway"),
      createGiteaUser,
    });
    const handler = createFlushHandler(mkDeps({ adapter, flushLocalState }));
    const body = { migrationId: "mig-1", slug: "chris", reason: "migration-final" };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(createGiteaUser).toHaveBeenCalledWith(
      "chris",
      "ssh-ed25519 SOURCE chris@gateway",
    );
    expect(createGiteaUser.mock.invocationCallOrder[0]).toBeLessThan(
      flushLocalState.mock.invocationCallOrder[0],
    );
  });

  it("runs the configured local flush under the signed fleet-control envelope", async () => {
    const flushLocalState = vi.fn(async () => ({
      ok: true,
      durationMs: 12,
      steps: [{ name: "customer-files", status: "done" as const, durationMs: 10 }],
    }));
    const handler = createFlushHandler(mkDeps({ flushLocalState }));
    const body = { migrationId: "mig-1", slug: "chris", reason: "idle" };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(flushLocalState).toHaveBeenCalledWith({ slug: "chris", reason: "idle" });
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      ok: true,
      durationMs: 12,
      steps: [{ name: "customer-files", status: "done", durationMs: 10 }],
    });
  });

  it("fails closed when the gateway did not configure a flush implementation", async () => {
    const handler = createFlushHandler(mkDeps());
    const body = { migrationId: "mig-1", slug: "chris" };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(501);
    expect(getBody()).toEqual({ error: "flush not configured" });
  });

  it("passes the signed source checkpoint into the target migration-converge flush", async () => {
    const expectedSystemConfigCommit = "a".repeat(40);
    const flushLocalState = vi.fn(async () => ({
      ok: true,
      durationMs: 12,
      steps: [],
      systemConfigCommit: "b".repeat(40),
    }));
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createFlushHandler(mkDeps({
      flushLocalState,
      resumeSystemConfigWatch,
    }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      reason: "migration-converge",
      expectedSystemConfigCommit,
    };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(flushLocalState).toHaveBeenCalledWith({
      slug: "chris",
      reason: "migration-converge",
      expectedSystemConfigCommit,
    });
    expect(resumeSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(flushLocalState.mock.invocationCallOrder[0]).toBeLessThan(
      resumeSystemConfigWatch.mock.invocationCallOrder[0],
    );
  });

  it("keeps the target watcher fenced when migration convergence fails", async () => {
    const expectedSystemConfigCommit = "a".repeat(40);
    const flushLocalState = vi.fn(async () => {
      throw new Error("durable checkpoint unavailable");
    });
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createFlushHandler(mkDeps({
      flushLocalState,
      resumeSystemConfigWatch,
    }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      reason: "migration-converge",
      expectedSystemConfigCommit,
    };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
  });

  it("keeps the target watcher fenced when a convergence step reports failure", async () => {
    const expectedSystemConfigCommit = "a".repeat(40);
    const flushLocalState = vi.fn(async () => ({
      ok: false,
      durationMs: 12,
      steps: [{
        name: "system-config",
        status: "failed" as const,
        error: "writer-lock-busy",
        durationMs: 12,
      }],
    }));
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createFlushHandler(mkDeps({
      flushLocalState,
      resumeSystemConfigWatch,
    }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      reason: "migration-converge",
      expectedSystemConfigCommit,
    };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
  });

  it.each([
    ["an existing import fence", "import-fence"],
    ["no initial fence", null],
  ])("does not let a delayed convergence flush from %s clear a concurrent unmount fence", async (
    _label,
    initialFence,
  ) => {
    let finishFlush: () => void = () => {};
    const flushBlocked = new Promise<void>((resolve) => {
      finishFlush = resolve;
    });
    let flushStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      flushStarted = resolve;
    });
    let activeFence: string | null = initialFence;
    const flushLocalState = vi.fn(async () => {
      flushStarted();
      await flushBlocked;
      return { ok: true, durationMs: 12, steps: [] };
    });
    const readSystemConfigWatchFence = vi.fn(async () => activeFence);
    const resumeSystemConfigWatch = vi.fn(
      async (_slug: string, expectedGeneration?: string | null) => {
        if (activeFence === expectedGeneration) activeFence = null;
      },
    );
    const pauseSystemConfigWatch = vi.fn(async () => {
      activeFence = "unmount-fence";
      return activeFence;
    });
    const removeImportedCustomerBySlug = vi.fn(async () => ({
      wasMounted: true,
      steps: [],
    }));
    const deps = mkDeps({
      flushLocalState,
      readSystemConfigWatchFence,
      resumeSystemConfigWatch,
      pauseSystemConfigWatch,
      adapter: mkAdapter({ removeImportedCustomerBySlug }),
    });
    const flushBody = {
      migrationId: "mig-1",
      slug: "chris",
      reason: "migration-converge",
      expectedSystemConfigCommit: "a".repeat(40),
    };
    const flushResponse = mkResponse();
    const flushing = createFlushHandler(deps)(
      mkRequest(flushBody, {
        signature: signForPod(flushBody.migrationId, JSON.stringify(flushBody)),
      }),
      flushResponse.res,
      vi.fn(),
    );
    await started;

    const unmountRaw = JSON.stringify(SAMPLE_UNMOUNT);
    const unmountResponse = mkResponse();
    await createUnmountHandler(deps)(
      mkRequest(SAMPLE_UNMOUNT, {
        signature: signForPod(SAMPLE_UNMOUNT.migrationId, unmountRaw),
      }),
      unmountResponse.res,
      vi.fn(),
    );
    finishFlush();
    await flushing;

    expect(unmountResponse.getStatus()).toBe(200);
    expect(flushResponse.getStatus()).toBe(200);
    expect(resumeSystemConfigWatch).toHaveBeenCalledWith(
      "chris",
      initialFence,
    );
    expect(activeFence).toBe("unmount-fence");
  });

  it.each([
    {},
    { expectedSystemConfigCommit: "not-a-sha" },
  ])("rejects target convergence without a valid accepted commit: %o", async (extra) => {
    const flushLocalState = vi.fn();
    const handler = createFlushHandler(mkDeps({ flushLocalState }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      reason: "migration-converge",
      ...extra,
    };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(flushLocalState).not.toHaveBeenCalled();
  });
});

describe("createVerifyHandler", () => {
  it("rejects bad signature with 401", async () => {
    const handler = createVerifyHandler(mkDeps());
    const body = { migrationId: "mig-1", slug: "chris" };
    const req = mkRequest(body, { signature: "deadbeef" });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(401);
  });

  it("returns 200 ready=true when local migration readiness checks pass", async () => {
    const adapter = mkAdapter();
    const log = vi.fn();
    const handler = createVerifyHandler(mkDeps({ adapter, log }));
    const body = { migrationId: "mig-1", slug: "chris", timeoutMs: 5_000 };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[migration-http] verify"), { status: "done" });
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      ready: true,
      checks: {
        customerDir: true,
        coachWired: true,
        mountMarked: true,
        accountHealthy: true,
      },
    });
    expect(adapter.waitForAccountHealthy).toHaveBeenCalledWith({
      slug: "chris",
      timeoutMs: 5_000,
    });
  });

  it("returns 409 ready=false when any readiness check fails", async () => {
    const adapter = mkAdapter({
      customerMountMarked: vi.fn(() => false),
    });
    const log = vi.fn();
    const handler = createVerifyHandler(mkDeps({ adapter, log }));
    const body = { migrationId: "mig-1", slug: "chris" };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(409);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[migration-http] verify"), { status: "failed" });
    expect(getBody()).toMatchObject({
      ready: false,
      checks: { mountMarked: false },
    });
  });

  async function verifyMidAttach(input: { attachPending: boolean; coachWired: boolean; mountMarked: boolean }) {
    const adapter = mkAdapter({
      customerCoachWiredInOpenclawConfig: vi.fn(() => input.coachWired),
      customerMountMarked: vi.fn(() => input.mountMarked),
    });
    const customerAttachPending = vi.fn(async () => input.attachPending);
    const handler = createVerifyHandler(mkDeps({ adapter, customerAttachPending }));
    const body = { migrationId: "mig-1", slug: "chris" };
    const response = mkResponse();
    await handler(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      response.res,
      vi.fn(),
    );
    return { adapter, customerAttachPending, status: response.getStatus(), body: response.getBody() };
  }

  it.each([
    { coachWired: false, mountMarked: true },
    { coachWired: true, mountMarked: false },
  ])("reports a coach attach still in progress without waiting on the account (wired=$coachWired, marked=$mountMarked)", async (wiring) => {
    const result = await verifyMidAttach({ attachPending: true, ...wiring });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      ready: false,
      code: MIGRATION_VERIFY_COACH_ATTACH_IN_PROGRESS,
      checks: { ...wiring, accountHealthy: false },
    });
    expect(result.customerAttachPending).toHaveBeenCalledWith("chris");
    expect(result.adapter.waitForAccountHealthy).not.toHaveBeenCalled();
  });

  it("reports an unwired coach with no attach in progress as plainly not ready", async () => {
    const result = await verifyMidAttach({ attachPending: false, coachWired: false, mountMarked: true });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ ready: false, checks: { coachWired: false } });
    expect(result.body).not.toHaveProperty("code");
  });

  it("verifies a fully mounted coach normally while a content re-ensure is pending", async () => {
    const result = await verifyMidAttach({ attachPending: true, coachWired: true, mountMarked: true });

    expect(result.status).toBe(200);
    expect(result.body).not.toHaveProperty("code");
    expect(result.adapter.waitForAccountHealthy).toHaveBeenCalled();
  });

  it.each([
    { configTransferMode: undefined, overlayPresent: true },
    { configTransferMode: "configured-builder-system-config", overlayPresent: true },
    { configTransferMode: undefined, overlayPresent: false },
  ])("verifies configured Builder readiness (mode=$configTransferMode, overlay=$overlayPresent)", async ({ configTransferMode, overlayPresent }) => {
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "chris");
    const adapter = mkAdapter({
      isBuilderGateway: vi.fn(() => true),
      configuredBuilderOverlayPresent: vi.fn(() => overlayPresent),
      hasWorkspaceGitDir: vi.fn(() => true),
      hasGitRemote: vi.fn(() => true),
      customerCoachWiredInOpenclawConfig: vi.fn(() => false),
    });
    const handler = createVerifyHandler(mkDeps({ adapter }));
    const body = {
      migrationId: "mig-builder-verify",
      slug: "chris",
      ...(configTransferMode ? { configTransferMode } : {}),
    };
    const response = mkResponse();

    await handler(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      response.res,
      vi.fn(),
    );

    expect(response.getStatus()).toBe(overlayPresent ? 200 : 409);
    expect(response.getBody()).toEqual({
      migrationId: "mig-builder-verify",
      slug: "chris",
      ready: overlayPresent,
      configTransferMode: "configured-builder-system-config",
      checks: {
        customerDir: true,
        configuredBuilderOverlay: overlayPresent,
        mountMarked: true,
        workspaceGit: true,
        gitRemote: true,
      },
    });
    expect(adapter.waitForAccountHealthy).not.toHaveBeenCalled();
  });
});

describe("createRestoreHandler", () => {
  it("rejects bad signature with 401", async () => {
    const handler = createRestoreHandler(mkDeps());
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      uid: "uid-chris",
      snapshot: RESTORE_SNAPSHOT,
    };
    const req = mkRequest(body, { signature: "deadbeef" });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(401);
  });

  it("restores runtime state from the controller-provided durable snapshot and leaves the mount marker intact", async () => {
    const customersDir = await fs.mkdtemp(path.join(os.tmpdir(), "restore-marker-"));
    let watcherFenced = false;
    const pauseSystemConfigWatch = vi.fn(async (slug: string) => {
      expect(slug).toBe("chris");
      watcherFenced = true;
    });
    const adapter = mkAdapter({
      loadUserSnapshot: vi.fn(async () => {
        throw new Error("restore should use the signed snapshot, not broker lookup");
      }),
      hasCustomerSshKey: vi.fn(() => true),
      readLocalCustomerPubKey: vi.fn(() => "ssh-ed25519 local"),
      readGiteaCustomerPubKeys: vi.fn(async () => ["ssh-ed25519 local"]),
      ensureGiteaOrg: vi.fn(async () => undefined),
      hasWorkspaceGitDir: vi.fn(() => false),
      cloneWorkspaceRepo: vi.fn(async () => true),
      ensureCustomerDirectories: vi.fn(),
      writeCustomerTemplateFiles: vi.fn(async () => undefined),
      blobSyncForSlug: vi.fn(async () => undefined),
      restoreByosubForAgent: vi.fn(async () => ({ restored: false, present: false })),
      applyAddCustomerConfigPatch: vi.fn(async () => {
        expect(watcherFenced).toBe(true);
        return { elapsedMs: 1 };
      }),
      writeMountMarker: vi.fn((slug) => writeMountedMarker(customersDir, slug)),
      markCustomerMigratingIn: vi.fn((slug) => writeMigratingInPin(customersDir, slug)),
    });
    const handler = createRestoreHandler(mkDeps({ adapter, pauseSystemConfigWatch }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      uid: "uid-chris",
      snapshot: {
        ...RESTORE_SNAPSHOT,
        selectedTier: "personal_free",
        builderSubscription: { tier: "pro", status: "trialing" },
        trialGrant: {
          schemaVersion: 3,
          offerId: "builder-signup",
          offerVersion: 1,
          personalTier: "personal",
          builderTier: "hobby",
          configHash: "trial-config-a",
          claimedAt: "2026-07-22T00:00:00.000Z",
          endsAt: "2026-07-29T00:00:00.000Z",
        },
        freeTierModelRef: "platform-openrouter/moonshotai/kimi-k2",
        byotActive: true,
        systemConfig: { byot: { provider: "anthropic" } },
      },
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    try {
      await handler(req, res, vi.fn());

      expect(getStatus()).toBe(200);
      expect(getBody()).toMatchObject({
        migrationId: "mig-1",
        slug: "chris",
        restored: true,
      });
      expect(adapter.cloneWorkspaceRepo).toHaveBeenCalledWith(
        "chris",
        "git@gitea:octogee/chris.git",
      );
      expect(adapter.applyAddCustomerConfigPatch).toHaveBeenCalledWith(
        expect.objectContaining({ uid: "uid-chris", slug: "chris" }),
        null,
        expect.objectContaining({ byosActive: false }),
      );
      expect(adapter.reassertByotForCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          byotActive: true,
          selectedTier: "personal_free",
          builderSubscription: { tier: "pro", status: "trialing" },
          trialGrant: {
            schemaVersion: 3,
            offerId: "builder-signup",
            offerVersion: 1,
            personalTier: "personal",
            builderTier: "hobby",
            configHash: "trial-config-a",
            claimedAt: "2026-07-22T00:00:00.000Z",
            endsAt: "2026-07-29T00:00:00.000Z",
          },
          freeTierModelRef: "platform-openrouter/moonshotai/kimi-k2",
          systemConfig: { byot: { provider: "anthropic" } },
          provisioning: { openclaw: { status: "complete" } },
        }),
      );
      expect(adapter.writeMountMarker).toHaveBeenCalledWith("chris");
      expect(adapter.markCustomerMigratingIn).toHaveBeenCalledTimes(1);
      expect(adapter.markCustomerMigratingIn).toHaveBeenCalledWith("chris");
      expect(pauseSystemConfigWatch).toHaveBeenCalledOnce();
      expect(hasMountedMarker(customersDir, "chris")).toBe(true);
    } finally {
      await fs.rm(customersDir, { recursive: true, force: true });
    }
  });

  it("refreshes the same-uid broker snapshot before the model re-assert", async () => {
    const currentSnapshot = {
      ...RESTORE_SNAPSHOT,
      byotActive: true,
      systemConfig: { byot: { provider: "anthropic" } },
    };
    const adapter = mkAdapter({
      loadUserSnapshot: vi.fn(async () => currentSnapshot),
      hasCustomerSshKey: vi.fn(() => true),
      readLocalCustomerPubKey: vi.fn(() => "ssh-ed25519 local"),
      readGiteaCustomerPubKeys: vi.fn(async () => ["ssh-ed25519 local"]),
      ensureGiteaOrg: vi.fn(async () => undefined),
      hasWorkspaceGitDir: vi.fn(() => false),
      cloneWorkspaceRepo: vi.fn(async () => true),
      ensureCustomerDirectories: vi.fn(),
      writeCustomerTemplateFiles: vi.fn(async () => undefined),
      blobSyncForSlug: vi.fn(async () => undefined),
      restoreByosubForAgent: vi.fn(async () => ({ restored: false, present: false })),
      applyAddCustomerConfigPatch: vi.fn(async () => ({ elapsedMs: 1 })),
    });
    const handler = createRestoreHandler(mkDeps({ adapter }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      uid: "uid-chris",
      snapshot: RESTORE_SNAPSHOT,
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(adapter.loadUserSnapshot).toHaveBeenCalledWith("uid-chris");
    expect(adapter.reassertByotForCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        byotActive: true,
        systemConfig: { byot: { provider: "anthropic" } },
        provisioning: { openclaw: { status: "complete" } },
      }),
    );
  });

  it("rejects a snapshot whose uid/slug do not match the signed restore body", async () => {
    const handler = createRestoreHandler(mkDeps());
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      uid: "uid-chris",
      snapshot: { ...RESTORE_SNAPSHOT, slug: "mallory" },
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "snapshot mismatch" });
  });

  it("rejects a malformed snapshot body with 400 instead of throwing", async () => {
    const handler = createRestoreHandler(mkDeps());
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      uid: "uid-chris",
      snapshot: null,
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "snapshot mismatch" });
  });
});

describe("createUnmountHandler", () => {
  it.each([false, true])("cancels a Builder activation before rollback unmount; cancellation fails: %s", async (fails) => {
    vi.stubEnv("POD_UID", "builder-pod");
    const events: string[] = [];
    const adapter = mkAdapter({
      isBuilderGateway: () => true,
      removeImportedCustomerBySlug: vi.fn(async () => {
        events.push("unmount");
        return { wasMounted: true, steps: [] };
      }),
    });
    const unreserveSurgeTarget = vi.fn(async () => {
      events.push("cancel");
      if (fails) throw new Error("cannot cancel serving assignment");
      return HELD_BUILDER_GATE_STATE;
    });
    const handler = createUnmountHandler(mkDeps({
      adapter, unreserveSurgeTarget,
      reserveSurgeTarget: async () => undefined, releaseSurgeReadiness: async () => undefined,
    }));
    const response = mkResponse();
    await handler(mkRequest(SAMPLE_UNMOUNT, {
      signature: signForPod(SAMPLE_UNMOUNT.migrationId, JSON.stringify(SAMPLE_UNMOUNT)),
    }), response.res, vi.fn());
    expect(unreserveSurgeTarget).toHaveBeenCalledExactlyOnceWith({
      migrationId: SAMPLE_UNMOUNT.migrationId, slug: "chris", targetPodUid: "builder-pod",
    });
    expect(response.getStatus()).toBe(fails ? 500 : 200);
    expect(events).toEqual(fails ? ["cancel"] : ["cancel", "unmount"]);
  });

  it("rejects bad signature with 401", async () => {
    const handler = createUnmountHandler(mkDeps());
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: "deadbeef" });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(401);
  });

  it("returns 200 + unmounted:false when no user matches slug (idempotent)", async () => {
    const adapter = mkAdapter({
      uidForSlug: vi.fn(async () => null),
    });
    const pauseSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createUnmountHandler(mkDeps({
      adapter,
      pauseSystemConfigWatch,
      resumeSystemConfigWatch,
    }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signForPod(SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      unmounted: false,
    });
    expect(pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
  });

  it("keeps a duplicate imported-customer unmount fenced after response loss", async () => {
    const adapter = mkAdapter({
      removeImportedCustomerBySlug: vi.fn(async () => ({ wasMounted: false, steps: [] })),
    });
    const pauseSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createUnmountHandler(mkDeps({
      adapter,
      pauseSystemConfigWatch,
      resumeSystemConfigWatch,
    }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signForPod(SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ unmounted: false });
    expect(pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
  });

  it("rejects an unmount that crosses the dedicated watcher tenant boundary", async () => {
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "alice");
    const removeImportedCustomerBySlug = vi.fn(async () => ({ wasMounted: false, steps: [] }));
    const adapter = mkAdapter({ removeImportedCustomerBySlug });
    const handler = createUnmountHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signForPod(SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({
      error: "unmount failed",
      message: "system config watcher belongs to alice, not migration builder chris",
    });
    expect(removeImportedCustomerBySlug).not.toHaveBeenCalled();
  });

  it("returns 200 + unmounted:true when removeCustomerFromGateway succeeded", async () => {

const adapter = mkAdapter();
    const pauseSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createUnmountHandler(mkDeps({ adapter, pauseSystemConfigWatch }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signForPod(SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ unmounted: true });
    expect(adapter.applyRemoveCustomerConfigPatch).toHaveBeenCalled();
    expect(adapter.deleteDepartedCustomerState).toHaveBeenCalled();
    expect(pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
  });

  it("keeps the retired watcher fenced when unmount fails after an ambiguous partial removal", async () => {
    let removalPatchApplied = false;
    const adapter = mkAdapter({
      removeImportedCustomerBySlug: vi.fn(async () => {
        removalPatchApplied = true;
        throw new Error("response lost after config remove");
      }),
    });
    const pauseSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createUnmountHandler(mkDeps({
      adapter,
      pauseSystemConfigWatch,
      resumeSystemConfigWatch,
    }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signForPod(SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(removalPatchApplied).toBe(true);
    expect(pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
  });

  it("returns a structured config hash race for the surge controller's bounded retry", async () => {
    const adapter = mkAdapter({
      removeImportedCustomerBySlug: vi.fn(async () => {
        throw new OpenclawWireError("hash-mismatch", "config changed");
      }),
    });
    const handler = createUnmountHandler(mkDeps({
      adapter,
      pauseSystemConfigWatch: vi.fn(async () => undefined),
    }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const req = mkRequest(SAMPLE_UNMOUNT, {
      signature: signForPod(SAMPLE_UNMOUNT.migrationId, rawBody),
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toEqual({
      error: "unmount failed",
      message: "config changed",
      code: "hash-mismatch",
    });
  });
});

describe("queued-rsync migration control handlers", () => {
  it("createExportPathsHandler filters key-only mode down to the customer key dir", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
        { cwd: "/state", path: "agents/discord-helper" },
        { cwd: "/state", path: "memory/discord-helper.sqlite" },
        { cwd: "/openclaw", path: "customers/chris" },
        { cwd: "/openclaw", path: "customer-keys/chris" },
      ]),
    });
    const body: ExportPathsRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
      mode: "keys",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createExportPathsHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      sources: [{ cwd: "/openclaw", path: "customer-keys/chris" }],
    });
  });

  it.each(["pre", "final"] as const)(
    "createExportPathsHandler keeps pod-local customer keys out of %s surge state",
    async (mode) => {
      const adapter = mkAdapter({
        listExportPaths: vi.fn(async () => [
          { cwd: "/state", path: "agents/octogee-chris-coach" },
          { cwd: "/openclaw", path: "customers/chris" },
          { cwd: "/openclaw", path: "customer-keys/chris" },
        ]),
      });
      const body: ExportPathsRequestBody = {
        migrationId: "mig-1",
        slug: "chris",
        mode,
      };
      const rawBody = JSON.stringify(body);
      const sig = signForPod(body.migrationId, rawBody);
      const handler = createExportPathsHandler(mkDeps({ adapter }));
      const req = mkRequest(body, { signature: sig });
      const { res, getStatus, getBody } = mkResponse();

      await handler(req, res, vi.fn());

      expect(getStatus()).toBe(200);
      expect(getBody()).toEqual({
        migrationId: "mig-1",
        slug: "chris",
        sources: [
          { cwd: "/state", path: "agents/octogee-chris-coach" },
          { cwd: "/openclaw", path: "customers/chris" },
        ],
      });
    },
  );

  it("createExportPathsHandler rejects a missing/invalid transfer mode", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
      ]),
    });
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      mode: "bogus",
    } as unknown as ExportPathsRequestBody;
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createExportPathsHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "invalid migration mode" });
    expect(adapter.listExportPaths).not.toHaveBeenCalled();
  });

  it("createPrepareImportHandler uses the key-only import prep without stamping migrating-in", async () => {
    const markCustomerMigratingIn = vi.fn();
    const adapter = mkAdapter({
      prepareKeyImportDir: vi.fn(async () => "/openclaw"),
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markCustomerMigratingIn,
    });
    const body: PrepareImportRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
      mode: "keys",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createPrepareImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(adapter.prepareKeyImportDir).toHaveBeenCalledWith("chris");
    expect(adapter.prepareImportDir).not.toHaveBeenCalled();
    expect(markCustomerMigratingIn).not.toHaveBeenCalled();
    expect(getBody()).toMatchObject({ migrationId: "mig-1", slug: "chris", imported: true });
  });

  it("createPrepareImportHandler rejects a missing/invalid transfer mode before wiping state", async () => {
    const adapter = mkAdapter({
      prepareKeyImportDir: vi.fn(async () => "/openclaw"),
      prepareImportDir: vi.fn(async () => "/openclaw"),
    });
    const body = {
      migrationId: "mig-1",
      slug: "chris",
    } as unknown as PrepareImportRequestBody;
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createPrepareImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "invalid migration mode" });
    expect(adapter.prepareKeyImportDir).not.toHaveBeenCalled();
    expect(adapter.prepareImportDir).not.toHaveBeenCalled();
  });

  it("createPrepareImportHandler wipes normal import paths and stamps the migrating-in pin", async () => {
    const markCustomerMigratingIn = vi.fn();
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markCustomerMigratingIn,
    });
    const body: PrepareImportRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
      mode: "pre",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createPrepareImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(adapter.prepareImportDir).toHaveBeenCalledWith("chris", "pre");
    expect(markCustomerMigratingIn).toHaveBeenCalledWith("chris");
  });

  it("createActivationManifestExportHandler returns the source manifest as signed JSON", async () => {
    const manifest = {
      version: 2,
      slug: "chris",
      appliedFingerprint: "fp-chris",
      agentId: "octogee-chris-coach",
      accountId: "chris-coach",
      agent: { id: "octogee-chris-coach" },
      mattermostAccount: { botToken: "token" },
      bindings: [{ agentId: "octogee-chris-coach" }],
    };
    const adapter = mkAdapter({
      exportOpenClawActivationManifest: vi.fn(async () => manifest),
    });
    const body: ActivationManifestExportRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createActivationManifestExportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ migrationId: "mig-1", slug: "chris", manifest });
  });

  it("createActivateImportHandler records a completed standard activation", async () => {
    const markCustomerMigratingIn = vi.fn();
    const onMounted = vi.fn();
    const recordAppliedFingerprint = vi.fn();
    const createGiteaUser = vi.fn(async () => undefined);
    let pendingProjects = [{ projectSlug: "camp", giteaRepoName: "chris-camp" }];
    const cloneProjectRepo = vi.fn(async () => {
      pendingProjects = [];
      return true;
    });
    const adapter = mkAdapter({
      markCustomerMigratingIn,
      readLocalCustomerPubKey: vi.fn(() => "ssh-ed25519 TARGET chris@gateway"),
      createGiteaUser,
      activateImportedCustomer: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
      listProjectsNeedingClone: vi.fn(async () => pendingProjects),
      cloneProjectRepo,
      recordAppliedFingerprint,
      onMounted,
    });
    const body: ActivateImportRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createActivateImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(markCustomerMigratingIn).toHaveBeenCalledWith("chris");
    expect(createGiteaUser).toHaveBeenCalledWith(
      "chris",
      "ssh-ed25519 TARGET chris@gateway",
    );
    expect(adapter.activateImportedCustomer).toHaveBeenCalledWith("chris");
    expect(createGiteaUser.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.activateImportedCustomer).mock.invocationCallOrder[0],
    );
    expect(cloneProjectRepo).toHaveBeenCalledWith(
      "chris",
      "camp",
      "chris-camp",
      undefined,
    );
    expect(cloneProjectRepo.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.activateImportedCustomer).mock.invocationCallOrder[0],
    );
    expect(recordAppliedFingerprint).toHaveBeenCalledWith("chris", "fp-chris");
    expect(onMounted).toHaveBeenCalledWith("chris");
    expect(getBody()).toMatchObject({ migrationId: "mig-1", slug: "chris", imported: true });
  });

  it("does not activate a standard migration while a project checkout is still missing", async () => {
    const adapter = mkAdapter({
      listProjectsNeedingClone: vi.fn(async () => [
        { projectSlug: "camp", giteaRepoName: "chris-camp" },
      ]),
      cloneProjectRepo: vi.fn(async () => false),
    });
    const body: ActivateImportRequestBody = {
      migrationId: "mig-project-pending",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createActivateImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({
      error: "activate-import failed",
      message: expect.stringContaining("project checkout hydration incomplete"),
    });
    expect(adapter.activateImportedCustomer).not.toHaveBeenCalled();
  });

  it("activates a standard migration when the only missing checkout is a GitHub project that hydrates on the owner's Builder runtime", async () => {
    const cloneProjectRepo = vi.fn(async () => false);
    const adapter = mkAdapter({
      isBuilderGateway: vi.fn(() => false),
      isConfiguredBuilderCustomer: vi.fn(() => false),
      listProjectsNeedingClone: vi.fn(async () => [
        { projectSlug: "octogee", giteaRepoName: null, repoSource: { provider: "github", owner: "octogee-ai", repo: "octogee" } },
      ]),
      cloneProjectRepo,
      activateImportedCustomer: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
    });
    const body: ActivateImportRequestBody = {
      migrationId: "mig-github-deferred",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createActivateImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(cloneProjectRepo).not.toHaveBeenCalled();
    expect(adapter.activateImportedCustomer).toHaveBeenCalledWith("chris");
    expect(getBody()).toMatchObject({ migrationId: "mig-github-deferred", slug: "chris", imported: true });
  });

  it("activates an import onto the owner's own Builder runtime with its GitHub checkout left for the post-cutover reconcile", async () => {
    const cloneProjectRepo = vi.fn(async () => false);
    const recordAppliedFingerprint = vi.fn();
    const adapter = mkAdapter({
      isBuilderGateway: vi.fn(() => true),
      isConfiguredBuilderCustomer: vi.fn(() => true),
      listProjectsNeedingClone: vi.fn(async () => [
        { projectSlug: "octogee", giteaRepoName: null, repoSource: { provider: "github", owner: "octogee-ai", repo: "octogee" } },
      ]),
      cloneProjectRepo,
      activateImportedCustomer: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
      recordAppliedFingerprint,
    });
    const body: ActivateImportRequestBody = {
      migrationId: "mig-github-owner-runtime",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createActivateImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(cloneProjectRepo).not.toHaveBeenCalled();
    expect(adapter.activateImportedCustomer).toHaveBeenCalledWith("chris");
    expect(recordAppliedFingerprint).toHaveBeenCalledWith("chris", pendingCloneAppliedFingerprint("fp-chris"));
    expect(getBody()).toMatchObject({ migrationId: "mig-github-owner-runtime", slug: "chris", imported: true });
  });

  it("createPrepareRsyncImportHandler opens a one-time target rsync import session", async () => {
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markCustomerMigratingIn: vi.fn(),
    });
    const waitForRsyncReady = vi.fn(async () => undefined);
    const closeTransport = vi.fn(async () => undefined);
    const openMigrationTlsEndpoint = vi.fn(async () => ({
      certificatePem: TARGET_CERTIFICATE_PEM,
      close: closeTransport,
    }));
    const daemon = mkFakeChild();
    spawnMock.mockReturnValueOnce(daemon);
    const body: PrepareRsyncImportRequestBody = {
      migrationId: "mig-rsync",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "pre",
      transferUser: "migration",
      transferKey: "a".repeat(64),
      sourcePodIp: SOURCE_POD_IP,
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createPrepareRsyncImportHandler(
      mkDeps({ adapter, migrationRsyncPort: 30873, waitForRsyncReady, openMigrationTlsEndpoint }),
    );
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({
      migrationId: "mig-rsync",
      slug: "chris",
      imported: true,
      port: 30873,
      module: "state",
      certificatePem: TARGET_CERTIFICATE_PEM,
    });
    expect(adapter.prepareImportDir).toHaveBeenCalledWith("chris", "pre");
    expect(adapter.markCustomerMigratingIn).toHaveBeenCalledWith("chris");
    expect(waitForRsyncReady).toHaveBeenCalledWith(RSYNC_DAEMON_LOOPBACK_PORT);
    expect(openMigrationTlsEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      publicPort: 30873,
      upstreamPort: RSYNC_DAEMON_LOOPBACK_PORT,
      sourceIp: SOURCE_POD_IP,
    }));
    expect(String(spawnMock.mock.calls[0][0])).toMatch(/\/rsync$/);
    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(
      expect.arrayContaining(["--daemon", "--no-detach", `--port=${RSYNC_DAEMON_LOOPBACK_PORT}`]),
    );
    const configArg = spawnArgs.find((arg) => arg.startsWith("--config="));
    expect(configArg).toBeDefined();
    const configPath = configArg?.slice("--config=".length) ?? "";
    const config = await fs.readFile(configPath, "utf-8");
    expect(config).toContain(`pid file = ${configPath.replace(/rsyncd\.conf$/, "rsyncd.pid")}`);
    expect(config).toContain(`lock file = ${configPath.replace(/rsyncd\.conf$/, "rsyncd.lock")}`);
    expect(config).toContain("address = 127.0.0.1");
    expect(config).toContain("  hosts allow = 127.0.0.1");
    expect(config).not.toContain(SOURCE_POD_IP);

    const abortHandler = createAbortRsyncImportHandler(mkDeps({ adapter }));
    const replayedPrepare = mkResponse();
    await abortHandler(
      mkRequest(body, { signature: sig }),
      replayedPrepare.res,
      vi.fn(),
    );
    expect(replayedPrepare.getStatus()).toBe(400);
    expect(replayedPrepare.getBody()).toEqual({ error: "invalid rsync RPC phase" });
    expect(daemon.kill).not.toHaveBeenCalled();

    const abortBody: AbortRsyncImportRequestBody = {
      migrationId: "mig-rsync",
      slug: "chris",
      rpcPhase: "abort-rsync-import",
      mode: "pre",
    };
    const abortRaw = JSON.stringify(abortBody);
    const abortSig = signForPod(abortBody.migrationId, abortRaw);
    const abortReq = mkRequest(abortBody, { signature: abortSig });
    const abortRes = mkResponse();
    await abortHandler(abortReq, abortRes.res, vi.fn());
    expect(daemon.kill).toHaveBeenCalled();
    expect(closeTransport).toHaveBeenCalled();
  });

  it("reserves the surge target only for a configured Builder final import, before opening its session, and fails closed", async () => {
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "chris");
    const adapter = mkAdapter({
      isBuilderGateway: vi.fn(() => true),
      prepareKeyImportDir: vi.fn(async () => "/openclaw-keys"),
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markCustomerMigratingIn: vi.fn(),
    });
    const reserveSurgeTarget = vi.fn(async () => undefined);
    const waitForRsyncReady = vi.fn(async () => undefined);
    spawnMock.mockReturnValue(mkFakeChild());
    const handler = createPrepareRsyncImportHandler(
      mkDeps({ adapter, migrationRsyncPort: 30873, waitForRsyncReady, reserveSurgeTarget }),
    );
    const prepare = async (body: PrepareRsyncImportRequestBody) => {
      const response = mkResponse();
      await handler(
        mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
        response.res,
        vi.fn(),
      );
      return response;
    };
    const surge: PrepareRsyncImportRequestBody = {
      migrationId: "surge-gw-a-target",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
      transferUser: "migration",
      transferKey: "a".repeat(64),
    };
    const activationKeys: PrepareRsyncImportRequestBody = {
      migrationId: "surge-gw-a-target",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "keys",
      transferUser: "migration",
      transferKey: "a".repeat(64),
    };

    expect((await prepare(surge)).getStatus()).toBe(200);
    expect(reserveSurgeTarget).toHaveBeenCalledWith({
      migrationId: "surge-gw-a-target",
      slug: "chris",
    });

    expect((await prepare(activationKeys)).getStatus()).toBe(200);
    expect(reserveSurgeTarget).toHaveBeenCalledTimes(1);

    reserveSurgeTarget.mockRejectedValueOnce(new Error("cannot hydrate a permitted surge OpenClaw process gate"));
    expect((await prepare(surge)).getStatus()).toBe(500);
    expect(adapter.prepareImportDir).toHaveBeenCalledTimes(1);

    const abort: AbortRsyncImportRequestBody = {
      migrationId: "surge-gw-a-target",
      slug: "chris",
      rpcPhase: "abort-rsync-import",
      mode: "keys",
    };
    await createAbortRsyncImportHandler(mkDeps({ adapter }))(
      mkRequest(abort, { signature: signForPod(abort.migrationId, JSON.stringify(abort)) }),
      mkResponse().res,
      vi.fn(),
    );
  });

  it("reclaims an interrupted rsync session only for its owning migration", async () => {
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markCustomerMigratingIn: vi.fn(),
    });
    const waitForRsyncReady = vi.fn(async () => undefined);
    const interruptedDaemon = mkFakeChild();
    const resumedDaemon = mkFakeChild();
    spawnMock
      .mockReturnValueOnce(interruptedDaemon)
      .mockReturnValueOnce(resumedDaemon);
    const handler = createPrepareRsyncImportHandler(
      mkDeps({ adapter, migrationRsyncPort: 30873, waitForRsyncReady }),
    );
    const interrupted: PrepareRsyncImportRequestBody = {
      migrationId: "surge-default-b-target",
      slug: "smoke-dave-smoke",
      rpcPhase: "prepare-rsync-import",
      mode: "pre",
      transferUser: "migration",
      transferKey: "a".repeat(64),
    };
    const interruptedRaw = JSON.stringify(interrupted);
    const interruptedResponse = mkResponse();
    try {
      await handler(
        mkRequest(interrupted, {
          signature: signForPod(interrupted.migrationId, interruptedRaw),
        }),
        interruptedResponse.res,
        vi.fn(),
      );
      expect(interruptedResponse.getStatus()).toBe(200);

      const resumed: PrepareRsyncImportRequestBody = {
        ...interrupted,
        slug: "smoke-erica-smoke",
        mode: "final",
        transferKey: "b".repeat(64),
      };
      const resumedRaw = JSON.stringify(resumed);
      const resumedResponse = mkResponse();
      await handler(
        mkRequest(resumed, {
          signature: signForPod(resumed.migrationId, resumedRaw),
        }),
        resumedResponse.res,
        vi.fn(),
      );
      expect(resumedResponse.getStatus()).toBe(200);
      expect(interruptedDaemon.kill).toHaveBeenCalledWith("SIGTERM");

      const otherMigration: PrepareRsyncImportRequestBody = {
        ...resumed,
        migrationId: "surge-default-b-other-target",
        transferKey: "c".repeat(64),
      };
      const otherRaw = JSON.stringify(otherMigration);
      const otherResponse = mkResponse();
      await handler(
        mkRequest(otherMigration, {
          signature: signForPod(otherMigration.migrationId, otherRaw),
        }),
        otherResponse.res,
        vi.fn(),
      );
      expect(otherResponse.getStatus()).toBe(500);
      expect(otherResponse.getBody()).toMatchObject({
        error: "prepare-rsync-import failed",
        message: expect.stringContaining("surge-default-b-target"),
      });
      expect(resumedDaemon.kill).not.toHaveBeenCalled();
    } finally {
      for (const daemon of [interruptedDaemon, resumedDaemon]) {
        if (daemon.exitCode !== null || daemon.signalCode !== null) continue;
        daemon.exitCode = 0;
        daemon.emit("exit", 0, null);
      }
    }
  });

  it("createPushRsyncStateHandler runs rsync directly to the target pod with the one-time key", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
        { cwd: "/openclaw", path: "customers/chris" },
        { cwd: "/openclaw", path: "customer-keys/chris" },
      ]),
      exportOpenClawActivationManifest: vi.fn(async () => ({
        version: 2,
        slug: "chris",
        appliedFingerprint: "fp-chris",
        agentId: "octogee-chris-coach",
        accountId: "chris-coach",
        agent: { id: "octogee-chris-coach" },
        mattermostAccount: { botToken: "coach-pat" },
        bindings: [{ agentId: "octogee-chris-coach" }],
      })),
    });
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const body: PushRsyncStateRequestBody = {
      migrationId: "mig-rsync",
      slug: "chris",
      rpcPhase: "push-rsync-state",
      mode: "final",
      targetHost: TARGET_POD_IP,
      targetPort: 30873,
      targetCertificatePem: TARGET_CERTIFICATE_PEM,
      transferUser: "migration",
      transferKey: "b".repeat(64),
      includeActivationManifest: true,
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createPushRsyncStateHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ migrationId: "mig-rsync", slug: "chris", imported: true });
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toMatch(/\/rsync$/);
    expect(args).toContain("--relative");
    expect(args).toContain("/state/./agents/octogee-chris-coach");
    expect(args).toContain("/openclaw/./customers/chris");
    expect(args).not.toContain("/openclaw/./customer-keys/chris");
    expect(args.some((arg) => arg.endsWith("/./.octogee-migration-activation/chris/activation.json"))).toBe(true);
    expect(args).toContain(`rsync://migration@${TARGET_POD_IP}/state/`);
    expect(args).toEqual(expect.arrayContaining(["--compress", "--compress-choice=zstd"]));
    const env = (spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.RSYNC_CONNECT_PROG).toContain(`-connect ${TARGET_POD_IP}:30873`);
    expect(env.RSYNC_CONNECT_PROG).toContain("-verify_return_error");
    expect(env.RSYNC_CONNECT_PROG).toMatch(/-CAfile \S+\/target\.crt/);
  });

  it("refuses to push without the target's pinned TLS certificate", async () => {
    const body = {
      migrationId: "mig-rsync-no-pin",
      slug: "chris",
      rpcPhase: "push-rsync-state",
      mode: "final",
      targetHost: TARGET_POD_IP,
      targetPort: 30873,
      transferUser: "migration",
      transferKey: "b".repeat(64),
    };
    const { res, getStatus, getBody } = mkResponse();

    await createPushRsyncStateHandler(mkDeps())(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      res,
      vi.fn(),
    );

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "invalid targetCertificatePem" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not materialize an activation manifest for a configured Builder final transfer", async () => {
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "chris");
    const exportOpenClawActivationManifest = vi.fn(async () => {
      throw new Error("Builder transfer must not materialize an activation manifest");
    });
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
        { cwd: "/state", path: "agents/discord-helper" },
        { cwd: "/state", path: "memory/discord-helper.sqlite" },
        { cwd: "/openclaw", path: "customers/chris" },
      ]),
      exportOpenClawActivationManifest,
    });
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const body: PushRsyncStateRequestBody = {
      migrationId: "mig-builder-push",
      slug: "chris",
      rpcPhase: "push-rsync-state",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
      targetHost: TARGET_POD_IP,
      targetPort: 30873,
      targetCertificatePem: TARGET_CERTIFICATE_PEM,
      transferUser: "migration",
      transferKey: "b".repeat(64),
    };
    const handler = createPushRsyncStateHandler(mkDeps({ adapter }));
    const response = mkResponse();

    await handler(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      response.res,
      vi.fn(),
    );

    expect(response.getStatus()).toBe(200);
    expect(exportOpenClawActivationManifest).not.toHaveBeenCalled();
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("/state/./agents/discord-helper");
    expect(args).toContain("/state/./memory/discord-helper.sqlite");
    expect(args.some((arg) => arg.includes(".octogee-migration-activation"))).toBe(false);
  });

  it("rejects a configured Builder transfer on a nonmatching gateway", async () => {
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "alice");
    const body: PrepareRsyncImportRequestBody = {
      migrationId: "mig-builder-wrong-target",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
      transferUser: "migration",
      transferKey: "b".repeat(64),
    };
    const handler = createPrepareRsyncImportHandler(mkDeps());
    const response = mkResponse();

    await handler(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      response.res,
      vi.fn(),
    );

    expect(response.getStatus()).toBe(409);
    expect(response.getBody()).toEqual({
      error: "configured Builder system config transfer requires the matching Builder gateway",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(["ready", "activation-failed", "verification-pending", "startup-failed", "disconnected", "cancellation-failed"])(
    "activates a held Barn-to-Builder target through its process gate: %s",
    async (outcome) => {
      vi.stubEnv("POD_UID", "builder-pod");
      const events: string[] = [];
      const response = mkResponse();
      const adapter = mkAdapter({
        isBuilderGateway: () => true,
        isConfiguredBuilderCustomer: (slug) => slug === "chris",
        prepareImportDir: vi.fn(async () => "/openclaw"),
        activateImportedCustomer: vi.fn(async () => {
          expect(events).toContain("attach-permit-verify");
          events.push("activate-manifest");
          if (outcome === "activation-failed") throw new Error("Coach activation failed");
          return { appliedFingerprint: "imported-coach", ...(outcome === "verification-pending" ? { verificationPending: "Coach disconnected" } : {}) };
        }),
      });
      const reserveSurgeTarget = vi.fn(async () => { events.push("reserve"); });
      const unreserveSurgeTarget = vi.fn(async () => {
        events.push("cancel");
        if (outcome === "cancellation-failed") throw new Error("supervisor unavailable");
        return HELD_BUILDER_GATE_STATE;
      });
      const releaseSurgeReadiness = vi.fn(async () => {
        events.push("attach-permit-verify");
        if (outcome === "startup-failed" || outcome === "cancellation-failed") throw new Error("OpenClaw startup failed");
        if (outcome === "disconnected") response.res.emit("close");
      });
      const deps = mkDeps({
        adapter, reserveSurgeTarget, releaseSurgeReadiness, unreserveSurgeTarget,
        waitForRsyncReady: async () => undefined,
      });
      spawnMock.mockReturnValueOnce(mkFakeChild()).mockImplementationOnce(() => {
        events.push("copy");
        return mkFakeChild({ exitCode: 0 });
      });
      const prepare: PrepareRsyncImportRequestBody = {
        migrationId: `builder-${outcome}`, slug: "chris", mode: "final",
        rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "c".repeat(64),
      };
      const prepared = mkResponse();
      await createPrepareRsyncImportHandler(deps)(mkRequest(prepare, {
        signature: signForPod(prepare.migrationId, JSON.stringify(prepare)),
      }), prepared.res, vi.fn());
      expect(prepared.getStatus()).toBe(200);
      const finish: FinishRsyncImportRequestBody = {
        migrationId: prepare.migrationId, slug: "chris", mode: "final", rpcPhase: "finish-rsync-import",
      };
      await createFinishRsyncImportHandler(deps)(mkRequest(finish, {
        signature: signForPod(finish.migrationId, JSON.stringify(finish)),
      }), response.res, vi.fn());
      expect(events.slice(0, 3)).toEqual(["reserve", "copy", "attach-permit-verify"]);
      if (["ready", "activation-failed", "verification-pending"].includes(outcome)) {
        expect(adapter.activateImportedCustomer).toHaveBeenCalledExactlyOnceWith("chris", { signal: expect.any(AbortSignal) });
      } else {
        expect(adapter.activateImportedCustomer).not.toHaveBeenCalled();
      }
      expect(releaseSurgeReadiness).toHaveBeenCalledWith({
        migrationId: prepare.migrationId, targetPodUid: "builder-pod",
      });
      if (outcome === "ready") {
        expect(response.getStatus()).toBe(200);
        expect(adapter.onMounted).toHaveBeenCalledWith("chris");
        expect(unreserveSurgeTarget).not.toHaveBeenCalled();
      } else {
        expect(response.getStatus()).toBe(outcome === "disconnected" ? 499 : 500);
        expect(adapter.onMounted).not.toHaveBeenCalled();
        expect(unreserveSurgeTarget).toHaveBeenCalledExactlyOnceWith({
          migrationId: prepare.migrationId, slug: "chris", targetPodUid: "builder-pod",
        });
        if (outcome === "cancellation-failed") {
          expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("OpenClaw startup failed"));
          expect(response.getBody()).toMatchObject({
            message: "Builder activation failed and could not be cancelled",
          });
        }
      }
    },
  );

  it.each(["missing-gate", "missing-pod", "wrong-builder"])(
    "rejects unsafe cold Builder import before transferring state: %s",
    async (scenario) => {
      vi.stubEnv("POD_UID", scenario === "missing-pod" ? "" : "builder-pod");
      const adapter = mkAdapter({
        isBuilderGateway: () => true,
        isConfiguredBuilderCustomer: () => scenario !== "wrong-builder",
      });
      const reserveSurgeTarget = vi.fn(async () => undefined);
      const deps = mkDeps({
        adapter, reserveSurgeTarget,
        releaseSurgeReadiness: scenario === "missing-gate" ? undefined : async () => undefined,
        unreserveSurgeTarget: async () => HELD_BUILDER_GATE_STATE,
      });
      const body: PrepareRsyncImportRequestBody = {
        migrationId: "unsafe-builder", slug: "chris", mode: "final", rpcPhase: "prepare-rsync-import",
        transferUser: "migration", transferKey: "c".repeat(64),
      };
      const response = mkResponse();
      await createPrepareRsyncImportHandler(deps)(mkRequest(body, {
        signature: signForPod(body.migrationId, JSON.stringify(body)),
      }), response.res, vi.fn());
      expect(response.getStatus()).toBe(500);
      expect(reserveSurgeTarget).not.toHaveBeenCalled();
      expect(adapter.prepareImportDir).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("cancels a cold Builder reservation when import preparation fails; cancellation fails: %s", async (fails) => {
    vi.stubEnv("POD_UID", "builder-pod");
    const adapter = mkAdapter({
      isBuilderGateway: () => true,
      prepareImportDir: vi.fn(async () => { throw new Error("cannot prepare import root"); }),
    });
    const reserveSurgeTarget = vi.fn(async () => undefined);
    const unreserveSurgeTarget = vi.fn(async () => {
      if (fails) throw new Error("supervisor unavailable");
      return HELD_BUILDER_GATE_STATE;
    });
    const deps = mkDeps({
      adapter, reserveSurgeTarget,
      releaseSurgeReadiness: async () => undefined, unreserveSurgeTarget,
    });
    const body: PrepareRsyncImportRequestBody = {
      migrationId: "prepare-failed-builder", slug: "chris", mode: "final", rpcPhase: "prepare-rsync-import",
      transferUser: "migration", transferKey: "c".repeat(64),
    };
    const response = mkResponse();
    await createPrepareRsyncImportHandler(deps)(mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(reserveSurgeTarget).toHaveBeenCalledExactlyOnceWith({
      migrationId: body.migrationId, slug: "chris", targetPodUid: "builder-pod",
    });
    expect(unreserveSurgeTarget).toHaveBeenCalledExactlyOnceWith({
      migrationId: body.migrationId, slug: "chris", targetPodUid: "builder-pod",
    });
    if (fails) expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("supervisor unavailable"));
  });

  it.each(["held", "failed", "permitted"])("cancels a prepared cold Builder import; result: %s", async (outcome) => {
    vi.stubEnv("POD_UID", "builder-pod");
    const adapter = mkAdapter({
      isBuilderGateway: () => true,
      clearMountMarker: vi.fn(),
      clearCustomerMigratingIn: vi.fn(),
    });
    const unreserveSurgeTarget = vi.fn(async () => {
      if (outcome === "failed") throw new Error("supervisor unavailable");
      return { ...HELD_BUILDER_GATE_STATE, mode: outcome === "held" ? "held" as const : "permitted" as const };
    });
    const deps = mkDeps({
      adapter, reserveSurgeTarget: async () => undefined,
      releaseSurgeReadiness: async () => undefined, unreserveSurgeTarget,
    });
    const body: AbortRsyncImportRequestBody = {
      migrationId: "cancel-builder", slug: "chris", mode: "final", rpcPhase: "abort-rsync-import",
    };
    const response = mkResponse();
    await createAbortRsyncImportHandler(deps)(mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());
    expect(unreserveSurgeTarget).toHaveBeenCalledExactlyOnceWith({
      migrationId: body.migrationId, slug: "chris", targetPodUid: "builder-pod",
    });
    expect(response.getStatus()).toBe(outcome === "held" ? 200 : 500);
    if (outcome !== "held") {
      expect(adapter.onUnmounted).not.toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining(
        outcome === "failed" ? "supervisor unavailable" : "process is permitted",
      ), { status: "failed" });
    } else {
      expect(adapter.onUnmounted).toHaveBeenCalledWith("chris");
      expect(adapter.clearMountMarker).toHaveBeenCalledWith("chris");
    }
  });

  it("createFinishRsyncImportHandler leaves expedited project convergence to reconciliation", async () => {
    const recordAppliedFingerprint = vi.fn();
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      activateImportedCustomer: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
      markCustomerMigratingIn: vi.fn(),
      recordAppliedFingerprint,
      onMounted: vi.fn(),
    });
    const daemon = mkFakeChild();
    const copy = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(daemon).mockReturnValueOnce(copy);
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-finish",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      transferUser: "migration",
      transferKey: "c".repeat(64),
    };
    const prepareRaw = JSON.stringify(prepareBody);
    const prepareSig = signForPod(prepareBody.migrationId, prepareRaw);
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30873,
      waitForRsyncReady: vi.fn(async () => undefined),
      pauseSystemConfigWatch: vi.fn(async (_slug: string) => undefined),
      resumeSystemConfigWatch: vi.fn(async (_slug: string) => undefined),
    });
    const prepareHandler = createPrepareRsyncImportHandler(deps);
    const prepareReq = mkRequest(prepareBody, {
      signature: prepareSig,
      localAddress: `::ffff:${TARGET_POD_IP}`,
    });
    const prepareRes = mkResponse();
    await prepareHandler(prepareReq, prepareRes.res, vi.fn());
    expect(prepareRes.getBody()).toMatchObject({
      host: TARGET_POD_IP,
      port: 30873,
      module: "state",
    });
    const [, daemonArgs, daemonOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { stdio: string[] },
    ];
    expect(daemonArgs).toContain("--daemon");
    expect(daemonOpts.stdio).toEqual(["ignore", "ignore", "ignore"]);

    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-finish",
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode: "final",
      loadStrategy: "expedited",
    };
    const finishRaw = JSON.stringify(finishBody);
    const finishSig = signForPod(finishBody.migrationId, finishRaw);
    const finishHandler = createFinishRsyncImportHandler(deps);
    const finishReq = mkRequest(finishBody, { signature: finishSig });
    const { res, getStatus, getBody } = mkResponse();

    await finishHandler(finishReq, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ migrationId: "mig-finish", slug: "chris", imported: true });
    expect(daemon.kill).toHaveBeenCalled();
    expect(adapter.activateImportedCustomer).toHaveBeenCalledWith("chris", expect.any(Object));
    expect(deps.pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(deps.resumeSystemConfigWatch).not.toHaveBeenCalled();
    expect(recordAppliedFingerprint).not.toHaveBeenCalled();
    expect(adapter.listProjectsNeedingClone).not.toHaveBeenCalled();
    expect(adapter.writeMountMarker).toHaveBeenCalledWith("chris");
    expect(adapter.onMounted).toHaveBeenCalledWith("chris");
    const [copyCommand, copyArgs] = spawnMock.mock.calls[1] as [string, string[]];
    expect(copyCommand).toMatch(/\/rsync$/);
    expect(copyArgs.at(-1)).toBe("/openclaw/");
  });

  it("replaces only the imported customer's files and Git refs with the final source state", async () => {
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "final-customer-state-"));
    migrationTempRoots.push(importDir);
    const adapter = mkAdapter({ prepareImportDir: vi.fn(async () => importDir) });
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnMock.mockReturnValueOnce(mkFakeChild()).mockImplementation(real.spawn);
    const deps = mkDeps({ adapter, waitForRsyncReady: vi.fn(async () => undefined) });
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-exact-state", slug: "chris", rpcPhase: "prepare-rsync-import",
      mode: "final", transferUser: "migration", transferKey: "c".repeat(64),
    };
    const response = mkResponse();
    await createPrepareRsyncImportHandler(deps)(mkRequest(prepareBody, {
      signature: signForPod(prepareBody.migrationId, JSON.stringify(prepareBody)),
      localAddress: `::ffff:${TARGET_POD_IP}`,
    }), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    const daemonArgs = spawnMock.mock.calls[0][1] as string[];
    const configPath = daemonArgs.find((arg) => arg.startsWith("--config="))!.slice(9);
    const stageDir = /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf8"))![1]!;
    for (const [relative, content] of [
      ["customers/chris/draft.txt", "latest draft"],
      ["git-metadata/chris/workspace.git/HEAD", "ref: refs/heads/work"],
    ]) {
      await fs.mkdir(path.dirname(path.join(stageDir, relative)), { recursive: true });
      await fs.writeFile(path.join(stageDir, relative), content);
    }
    for (const relative of ["customers/chris/deleted.txt", "git-metadata/chris/workspace.git/refs/heads/deleted", "customers/alice/keep.txt"]) {
      await fs.mkdir(path.dirname(path.join(importDir, relative)), { recursive: true });
      await fs.writeFile(path.join(importDir, relative), "presync");
    }
    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: prepareBody.migrationId, slug: "chris", rpcPhase: "finish-rsync-import", mode: "final",
    };
    const finished = mkResponse();
    await createFinishRsyncImportHandler(deps)(mkRequest(finishBody, {
      signature: signForPod(finishBody.migrationId, JSON.stringify(finishBody)),
    }), finished.res, vi.fn());
    expect(finished.getStatus()).toBe(200);
    expect(await fs.readFile(path.join(importDir, "customers/chris/draft.txt"), "utf8")).toBe("latest draft");
    expect(await fs.readFile(path.join(importDir, "git-metadata/chris/workspace.git/HEAD"), "utf8")).toBe("ref: refs/heads/work");
    expect(fsSync.existsSync(path.join(importDir, "customers/chris/deleted.txt"))).toBe(false);
    expect(fsSync.existsSync(path.join(importDir, "git-metadata/chris/workspace.git/refs/heads/deleted"))).toBe(false);
    expect(await fs.readFile(path.join(importDir, "customers/alice/keep.txt"), "utf8")).toBe("presync");
  });

  it("keeps a committed import whose activation could not finish verifying", async () => {
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      activateImportedCustomer: vi.fn(async () => ({
        appliedFingerprint: "fp-chris",
        verificationPending: "connect response timed out after 30000ms",
      })),
      markCustomerMigratingIn: vi.fn(),
      onMounted: vi.fn(),
    });
    const daemon = mkFakeChild();
    const copy = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(daemon).mockReturnValueOnce(copy);
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30874,
      waitForRsyncReady: vi.fn(async () => undefined),
      pauseSystemConfigWatch: vi.fn(async (_slug: string) => undefined),
      resumeSystemConfigWatch: vi.fn(async (_slug: string) => undefined),
    });
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-pending",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      transferUser: "migration",
      transferKey: "d".repeat(64),
    };
    const prepareRaw = JSON.stringify(prepareBody);
    await createPrepareRsyncImportHandler(deps)(
      mkRequest(prepareBody, {
        signature: signForPod(prepareBody.migrationId, prepareRaw),
        localAddress: `::ffff:${TARGET_POD_IP}`,
      }),
      mkResponse().res,
      vi.fn(),
    );

    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-pending",
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode: "final",
    };
    const finishRaw = JSON.stringify(finishBody);
    const { res, getStatus, getBody } = mkResponse();
    await createFinishRsyncImportHandler(deps)(
      mkRequest(finishBody, {
        signature: signForPod(finishBody.migrationId, finishRaw),
      }),
      res,
      vi.fn(),
    );

    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({
      imported: true,
      verificationPending: "connect response timed out after 30000ms",
    });
    expect(adapter.writeMountMarker).toHaveBeenCalledWith("chris");
    expect(adapter.onMounted).toHaveBeenCalledWith("chris");
  });

  it("omits neutral fallback state from a configured Builder final import before surge release", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "builder-finish-"));
    migrationTempRoots.push(stateDir);
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({
      agents: { list: [{ id: "discord-helper" }, { id: "octogee-unmatched-route" }] },
    }));
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "chris");
    vi.stubEnv("OPENCLAW_DIR", stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const mounted: string[] = [];
    const onMounted = vi.fn((slug: string) => {
      if (!mounted.includes(slug)) mounted.push(slug);
    });
    const markCustomerMigratingIn = vi.fn();
    const adapter = mkAdapter({
      isBuilderGateway: vi.fn(() => true),
      configuredBuilderOverlayPresent: vi.fn(() => true),
      hasCustomerSshKey: vi.fn(() => true),
      readGiteaCustomerPubKeys: vi.fn(async () => ["ssh-ed25519 LOCAL chris@gateway"]),
      hasWorkspaceGitDir: vi.fn(() => true),
      hasGitRemote: vi.fn(() => true),
      prepareImportDir: vi.fn(async () => stateDir),
      activateImportedCustomer: vi.fn(async () => ({ appliedFingerprint: "unexpected" })),
      applyAddCustomerConfigPatch: vi.fn(async () => ({ elapsedMs: 1 })),
      markCustomerMigratingIn,
      writeMountMarker: vi.fn(),
      customerMountMarked: vi.fn(() => true),
      onMounted,
    });
    const daemon = mkFakeChild();
    const copy = mkFakeChild({ exitCode: 0 });
    let stageDir = "";
    const stagedFallbackFiles = [
      "agents/octogee-unmatched-route/agent/state.json",
      "workspace-octogee-unmatched-route/MEMORY.md",
      "memory/octogee-unmatched-route.sqlite",
    ];
    spawnMock.mockReturnValueOnce(daemon).mockImplementationOnce(() => {
      for (const relativePath of stagedFallbackFiles) {
        expect(fsSync.existsSync(path.join(stageDir, relativePath))).toBe(false);
      }
      return copy;
    });
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30873,
      waitForRsyncReady: vi.fn(async () => undefined),
      getMountedCustomers: () => mounted,
    });
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-builder-finish",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
      transferUser: "migration",
      transferKey: "d".repeat(64),
    };
    const prepareResponse = mkResponse();
    await createPrepareRsyncImportHandler(deps)(
      mkRequest(prepareBody, {
        signature: signForPod(prepareBody.migrationId, JSON.stringify(prepareBody)),
      }),
      prepareResponse.res,
      vi.fn(),
    );
    expect(prepareResponse.getStatus()).toBe(200);
    const [, daemonArgs] = spawnMock.mock.calls[0] as [string, string[]];
    const rsyncConfigPath = daemonArgs
      .find((arg) => arg.startsWith("--config="))!
      .slice("--config=".length);
    stageDir = /^\s*path = (.+)$/mu.exec(await fs.readFile(rsyncConfigPath, "utf-8"))![1]!;
    for (const relativePath of stagedFallbackFiles) {
      const absolutePath = path.join(stageDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "legacy fallback state");
    }

    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-builder-finish",
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
    };
    const finishResponse = mkResponse();
    await createFinishRsyncImportHandler(deps)(
      mkRequest(finishBody, {
        signature: signForPod(finishBody.migrationId, JSON.stringify(finishBody)),
      }),
      finishResponse.res,
      vi.fn(),
    );

    expect(finishResponse.getStatus()).toBe(200);
    expect(adapter.activateImportedCustomer).not.toHaveBeenCalled();
    expect(adapter.applyAddCustomerConfigPatch).not.toHaveBeenCalled();
    expect(adapter.loadUserSnapshot).not.toHaveBeenCalled();
    expect(adapter.writeMountMarker).not.toHaveBeenCalled();
    expect(onMounted).not.toHaveBeenCalled();
    expect(markCustomerMigratingIn).toHaveBeenCalledWith("chris");
    expect(mounted).toEqual([]);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("omitted system fallback state from staged import"),
    );
  });

  it("rejects a final import whose config transfer mode does not match the prepared Builder session", async () => {
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "chris");
    const adapter = mkAdapter({ prepareImportDir: vi.fn(async () => "/openclaw") });
    const daemon = mkFakeChild();
    spawnMock.mockReturnValueOnce(daemon);
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30873,
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-builder-mismatch",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
      transferUser: "migration",
      transferKey: "e".repeat(64),
    };
    await createPrepareRsyncImportHandler(deps)(
      mkRequest(prepareBody, {
        signature: signForPod(prepareBody.migrationId, JSON.stringify(prepareBody)),
      }),
      mkResponse().res,
      vi.fn(),
    );
    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-builder-mismatch",
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode: "final",
      configTransferMode: "activation-manifest",
    };
    const response = mkResponse();
    await createFinishRsyncImportHandler(deps)(
      mkRequest(finishBody, {
        signature: signForPod(finishBody.migrationId, JSON.stringify(finishBody)),
      }),
      response.res,
      vi.fn(),
    );

    expect(response.getStatus()).toBe(409);
    expect(response.getBody()).toEqual({
      error: "rsync import config transfer mode does not match prepared session",
    });
    const abortBody: AbortRsyncImportRequestBody = {
      migrationId: "mig-builder-mismatch",
      slug: "chris",
      rpcPhase: "abort-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
    };
    await createAbortRsyncImportHandler(deps)(
      mkRequest(abortBody, {
        signature: signForPod(abortBody.migrationId, JSON.stringify(abortBody)),
      }),
      mkResponse().res,
      vi.fn(),
    );
    expect(daemon.kill).toHaveBeenCalled();
  });

  it("clears only Builder migration observation when a final import is aborted", async () => {
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "chris");
    const clearMountMarker = vi.fn();
    const clearCustomerMigratingIn = vi.fn();
    const onUnmounted = vi.fn();
    const adapter = mkAdapter({
      clearMountMarker,
      clearCustomerMigratingIn,
      onUnmounted,
    });
    const body: AbortRsyncImportRequestBody = {
      migrationId: "mig-builder-abort",
      slug: "chris",
      rpcPhase: "abort-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
    };
    const response = mkResponse();

    await createAbortRsyncImportHandler(mkDeps({ adapter }))(
      mkRequest(body, {
        signature: signForPod(body.migrationId, JSON.stringify(body)),
      }),
      response.res,
      vi.fn(),
    );

    expect(response.getStatus()).toBe(200);
    expect(clearMountMarker).toHaveBeenCalledWith("chris");
    expect(clearCustomerMigratingIn).toHaveBeenCalledWith("chris");
    expect(onUnmounted).toHaveBeenCalledWith("chris");
    expect(adapter.applyRemoveCustomerConfigPatch).not.toHaveBeenCalled();
    expect(adapter.deleteDepartedCustomerState).not.toHaveBeenCalled();
  });

  it("does not acknowledge a finished key import until its rsync listener exits", async () => {
    const adapter = mkAdapter({
      prepareKeyImportDir: vi.fn(async () => "/openclaw"),
    });
    const daemon = mkFakeChild({ holdExit: true });
    const copy = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(daemon).mockReturnValueOnce(copy);
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30873,
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-keys-exit",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "keys",
      transferUser: "migration",
      transferKey: "d".repeat(64),
    };
    const prepareRaw = JSON.stringify(prepareBody);
    const prepareHandler = createPrepareRsyncImportHandler(deps);
    await prepareHandler(
      mkRequest(prepareBody, { signature: signForPod(prepareBody.migrationId, prepareRaw) }),
      mkResponse().res,
      vi.fn(),
    );

    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-keys-exit",
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode: "keys",
    };
    const finishRaw = JSON.stringify(finishBody);
    const finishHandler = createFinishRsyncImportHandler(deps);
    const finishResponse = mkResponse();
    const finish = finishHandler(
      mkRequest(finishBody, { signature: signForPod(finishBody.migrationId, finishRaw) }),
      finishResponse.res,
      vi.fn(),
    );

    expect(await Promise.race([
      finish.then(() => "finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 100)),
    ])).toBe("pending");
    expect(daemon.kill).toHaveBeenCalledWith("SIGTERM");

    daemon.exitCode = 0;
    daemon.emit("exit", 0, null);
    await finish;

    expect(finishResponse.getStatus()).toBe(200);
  });
});

describe("agent sqlite stores across an rsync carry", () => {
  const CARRIED_STORE = path.join(
    "agents",
    "octogee-chris-coach",
    "agent",
    "openclaw-agent.sqlite",
  );
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  async function mkTempRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "carry-"));
    tempRoots.push(root);
    return root;
  }

  async function writeStore(
    root: string,
    rel: string,
    seed: (db: DatabaseSync) => void,
  ): Promise<string> {
    const dbPath = path.join(root, rel);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE transcript_events(body TEXT); CREATE TABLE session_nodes(status TEXT)");
    seed(db);
    db.close();
    return dbPath;
  }

  function rowCount(dbPath: string): number {
    const db = new DatabaseSync(dbPath);
    try {
      return (db.prepare("SELECT count(*) AS c FROM transcript_events").get() as { c: number }).c;
    } finally {
      db.close();
    }
  }

  const SNAPSHOT_REPOSITORY = path.join("agents", "octogee-chris-coach", "agent", ".octogee-snapshot");

  function snapshotResult(ok: boolean, extra: Record<string, unknown> = {}): { code: number; stdout: string } {
    return ok
      ? { code: 0, stdout: JSON.stringify({ ok: true, ...extra }) }
      : { code: 1, stdout: JSON.stringify({ ok: false, error: { message: String(extra.message) } }) };
  }

  function fakeOpenClaw(options: { failSnapshot?: string } = {}) {
    return vi.fn(async (args: string[]) => {
      const [, , action] = args;
      if (action === "create") {
        if (options.failSnapshot) return snapshotResult(false, { message: options.failSnapshot });
        const repository = args[args.indexOf("--repository") + 1]!;
        const snapshotPath = path.join(repository, "snap-1");
        await fs.mkdir(snapshotPath, { recursive: true });
        await fs.writeFile(path.join(snapshotPath, "manifest.json"), "{}");
        await fs.writeFile(path.join(snapshotPath, "database.sqlite"), "snapshot");
        return snapshotResult(true, { snapshotPath });
      }
      if (args[0] === "database" && args[1] === "preflight-agent") {
        return { code: 0, stdout: JSON.stringify({
          schema: "openclaw.agent-schema-preflight.v1", databasePath: args[2], agentId: args[args.indexOf("--agent-id") + 1],
          foundVersion: 24, targetVersion: 24, status: "exact",
        }) };
      }
      if (action === "verify") return snapshotResult(true);
      if (action === "restore") {
        await fs.copyFile(path.join(args[3]!, "database.sqlite"), args[args.indexOf("--target") + 1]!);
        return snapshotResult(true);
      }
      throw new Error(`unexpected openclaw ${args.join(" ")}`);
    });
  }

  function pushRsync(stateDir: string, migrationId: string, options: {
    mode?: "pre" | "final";
    runOpenClaw?: ReturnType<typeof fakeOpenClaw>;
  } = {}): {
    handler: ReturnType<typeof createPushRsyncStateHandler>;
    req: Request;
  } {
    const body: PushRsyncStateRequestBody = {
      migrationId,
      slug: "chris",
      rpcPhase: "push-rsync-state",
      mode: options.mode ?? "final",
      targetHost: TARGET_POD_IP,
      targetPort: 30873,
      targetCertificatePem: TARGET_CERTIFICATE_PEM,
      transferUser: "migration",
      transferKey: "b".repeat(64),
    };
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: stateDir, path: path.join("agents", "octogee-chris-coach") },
      ]),
      exportOpenClawActivationManifest: vi.fn(async () => null as never),
    });
    return {
      handler: createPushRsyncStateHandler(mkDeps({ adapter, runOpenClaw: options.runOpenClaw ?? fakeOpenClaw() })),
      req: mkRequest(body, {
        signature: signForPod(migrationId, JSON.stringify(body)),
      }),
    };
  }

  it("carries an OpenClaw snapshot of each agent database and never the live files", async () => {
    const stateDir = await mkTempRoot();
    const dbPath = await writeStore(stateDir, CARRIED_STORE, () => {});
    const live = new DatabaseSync(dbPath);
    live.prepare("INSERT INTO transcript_events VALUES (?)").run("newest");
    const runOpenClaw = fakeOpenClaw();
    let snapshotCarried = false;
    spawnMock.mockImplementationOnce((_command: string, args: string[]) => {
      const snapshotSource = args.find((arg) => arg.endsWith(`/./${SNAPSHOT_REPOSITORY}`));
      snapshotCarried = snapshotSource !== undefined &&
        fsSync.existsSync(path.join(snapshotSource.replace("/./", "/"), "snap-1", "database.sqlite"));
      return mkFakeChild({ exitCode: 0 });
    });
    const { handler, req } = pushRsync(stateDir, "mig-carry-snapshot", { runOpenClaw });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());
    live.close();

    expect(getStatus()).toBe(200);
    expect(runOpenClaw).toHaveBeenCalledWith(
      ["backup", "sqlite", "create", "--agent", "octogee-chris-coach", "--repository", expect.stringMatching(new RegExp(`${SNAPSHOT_REPOSITORY}$`)), "--json"],
      expect.any(Object),
    );
    expect(snapshotCarried).toBe(true);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(expect.arrayContaining([
      "--exclude=openclaw-agent.sqlite",
      "--exclude=openclaw-agent.sqlite-*",
    ]));
  });

  it("carries a consistent agent snapshot during pre-sync without transferring the live database", async () => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, CARRIED_STORE, () => {});
    const runOpenClaw = fakeOpenClaw();
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const { handler, req } = pushRsync(stateDir, "mig-carry-pre", { mode: "pre", runOpenClaw });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(runOpenClaw).toHaveBeenCalledWith(expect.arrayContaining(["backup", "sqlite", "create"]), expect.any(Object));
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("--exclude=openclaw-agent.sqlite");
  });

  it("fails the push instead of carrying a store OpenClaw cannot snapshot", async () => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, CARRIED_STORE, () => {});
    const { handler, req } = pushRsync(stateDir, "mig-carry-bad", {
      runOpenClaw: fakeOpenClaw({ failSnapshot: "database disk image is malformed" }),
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({
      error: "push-rsync-state failed",
      message: "OpenClaw snapshot of octogee-chris-coach failed: database disk image is malformed",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses to carry an unexpected SQLite store from agent state", async () => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, path.join("agents", "octogee-chris-coach", "agent", "stray.sqlite"), () => {});
    const { handler, req } = pushRsync(stateDir, "mig-carry-stray");
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({
      message: expect.stringContaining("unexpected OpenClaw SQLite store in agent state"),
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  async function prepareImport(input: {
    migrationId: string;
    importDir: string;
    daemon: ReturnType<typeof mkFakeChild>;
    mode?: "pre" | "final";
    adapter?: Partial<CustomerLifecycleAdapter>;
    deps?: Partial<MigrationHandlerDeps>;
  }): Promise<{ deps: MigrationHandlerDeps; stageDir: string }> {
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => input.importDir),
      activateImportedCustomer: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
      markCustomerMigratingIn: vi.fn(),
      onMounted: vi.fn(),
      ...input.adapter,
    });
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30873,
      waitForRsyncReady: vi.fn(async () => undefined),
      pauseSystemConfigWatch: vi.fn(async () => undefined),
      resumeSystemConfigWatch: vi.fn(async () => undefined),
      runOpenClaw: fakeOpenClaw(),
      ...input.deps,
    });
    spawnMock.mockReturnValueOnce(input.daemon);
    const body: PrepareRsyncImportRequestBody = {
      migrationId: input.migrationId,
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: input.mode ?? "final",
      transferUser: "migration",
      transferKey: "c".repeat(64),
    };
    await createPrepareRsyncImportHandler(deps)(
      mkRequest(body, {
        signature: signForPod(input.migrationId, JSON.stringify(body)),
      }),
      mkResponse().res,
      vi.fn(),
    );
    const [, daemonArgs] = spawnMock.mock.calls.at(-1) as [string, string[]];
    const configPath = daemonArgs
      .find((arg) => arg.startsWith("--config="))!
      .slice("--config=".length);
    const stageDir = /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf-8"))![1]!;
    return { deps, stageDir };
  }

  async function finishImport(
    deps: MigrationHandlerDeps,
    migrationId: string,
    mode: "pre" | "final" = "final",
  ): Promise<ReturnType<typeof mkResponse>> {
    const body: FinishRsyncImportRequestBody = {
      migrationId,
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode,
    };
    const response = mkResponse();
    await createFinishRsyncImportHandler(deps)(
      mkRequest(body, {
        signature: signForPod(migrationId, JSON.stringify(body)),
      }),
      response.res,
      vi.fn(),
    );
    return response;
  }

  it.each(["pre", "final"] as const)(
    "omits neutral fallback state from a staged %s import",
    async (mode) => {
      const importDir = await mkTempRoot();
      const migrationId = `mig-neutral-fallback-${mode}`;
      const { deps, stageDir } = await prepareImport({
        migrationId,
        importDir,
        daemon: mkFakeChild(),
        mode,
      });
      const stagedFallbackFiles = [
        "agents/octogee-unmatched-route/agent/state.json",
        "workspace-octogee-unmatched-route/MEMORY.md",
        "workspaces/octogee-unmatched-route/MEMORY.md",
        "memory/octogee-unmatched-route.sqlite",
      ];
      for (const relativePath of stagedFallbackFiles) {
        const absolutePath = path.join(stageDir, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, "legacy fallback state");
      }
      const copy = mkFakeChild({ exitCode: 0 });
      spawnMock.mockImplementationOnce(() => {
        for (const relativePath of stagedFallbackFiles) {
          expect(fsSync.existsSync(path.join(stageDir, relativePath))).toBe(false);
        }
        expect(fsSync.existsSync(path.join(stageDir, "workspaces"))).toBe(false);
        return copy;
      });

      const { getStatus } = await finishImport(deps, migrationId, mode);

      expect(getStatus()).toBe(200);
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining("omitted system fallback state from staged import"),
      );
    },
  );

  it("does not follow an untrusted staged fallback ancestor", async () => {
    const importDir = await mkTempRoot();
    const outside = await mkTempRoot();
    const sentinel = path.join(outside, "octogee-unmatched-route", "MEMORY.md");
    await fs.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.writeFile(sentinel, "outside stage");
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-neutral-symlink",
      importDir,
      daemon: mkFakeChild(),
    });
    await fs.symlink(outside, path.join(stageDir, "workspaces"));

    const { getStatus } = await finishImport(deps, "mig-neutral-symlink");

    expect(getStatus()).toBe(500);
    await expect(fs.readFile(sentinel, "utf-8")).resolves.toBe("outside stage");
    expect(spawnMock.mock.calls).toHaveLength(1);
  });

  const STAGED_SNAPSHOT = path.join(SNAPSHOT_REPOSITORY, "snap-1");

  async function stageSnapshot(stageDir: string, seed: (db: DatabaseSync) => void): Promise<void> {
    await writeStore(stageDir, path.join(STAGED_SNAPSHOT, "database.sqlite"), seed);
    await fs.writeFile(path.join(stageDir, STAGED_SNAPSHOT, "manifest.json"), "{}");
  }

  it("rejects a carried workspace store that does not open instead of delivering it", async () => {
    const importDir = await mkTempRoot();
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-unreadable",
      importDir,
      daemon: mkFakeChild(),
    });
    const staged = path.join(stageDir, "customers", "chris", "app.sqlite");
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.writeFile(staged, "this is not a database");

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-unreadable");

    expect(getStatus()).toBe(400);
    expect(getBody()).toMatchObject({
      error: "rsync import failed validation",
      message: expect.stringContaining("carried agent store customers/chris/app.sqlite does not open"),
    });
    expect(spawnMock.mock.calls).toHaveLength(1);
    expect(deps.adapter.activateImportedCustomer).not.toHaveBeenCalled();
  });

  it("rejects live agent database files carried instead of a snapshot", async () => {
    const importDir = await mkTempRoot();
    const { deps, stageDir } = await prepareImport({ migrationId: "mig-carry-live", importDir, daemon: mkFakeChild() });
    await writeStore(stageDir, CARRIED_STORE, () => {});

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-live");

    expect(getStatus()).toBe(400);
    expect(getBody()).toMatchObject({
      message: `carried live agent database files instead of snapshots: ${CARRIED_STORE}`,
    });
    expect(spawnMock.mock.calls).toHaveLength(1);
    await expect(fs.access(path.join(importDir, CARRIED_STORE))).rejects.toThrow();
  });

  it("verifies, restores and lands the carried snapshot before activating", async () => {
    const importDir = await mkTempRoot();
    const landedAtActivation: boolean[] = [];
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-land",
      importDir,
      daemon: mkFakeChild(),
      adapter: {
        activateImportedCustomer: vi.fn(async () => {
          landedAtActivation.push(fsSync.existsSync(path.join(importDir, CARRIED_STORE)));
          return { appliedFingerprint: "fp-chris" };
        }),
      },
    });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO transcript_events VALUES ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus } = await finishImport(deps, "mig-carry-land");

    expect(getStatus()).toBe(200);
    const run = deps.runOpenClaw as ReturnType<typeof fakeOpenClaw>;
    expect(run.mock.calls.map(([args]) => args.slice(0, 2).join(" "))).toEqual([
      "database preflight-agent",
      "backup sqlite",
    ]);
    expect(run.mock.calls.slice(1).map(([args]) => args[2])).toEqual(["restore"]);
    expect(rowCount(path.join(importDir, CARRIED_STORE))).toBe(1);
    expect((await fs.stat(path.join(importDir, CARRIED_STORE))).mode & 0o777).toBe(0o600);
    expect(landedAtActivation).toEqual([true]);
    expect(upgradeStoresMock).not.toHaveBeenCalled();
    await expect(fs.access(path.join(importDir, ".octogee-import", "mig-carry-land"))).rejects.toThrow();
    await expect(fs.access(path.join(stageDir, SNAPSHOT_REPOSITORY))).rejects.toThrow();
  });

  it("keeps Shared pre-copy agents undiscoverable until the final authoritative snapshot arrives", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const migrationId = "mig-shared-undiscoverable-pre";
    const releaseAgent = vi.fn(async () => undefined);
    const adapter = { isBuilderGateway: () => false, releaseAgent };
    const pre = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), mode: "pre", adapter, deps: { procRoot } });
    await stageSnapshot(pre.stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('pre')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    expect((await finishImport(pre.deps, migrationId, "pre")).getStatus()).toBe(200);

    const liveDatabase = path.join(importDir, CARRIED_STORE);
    if (fsSync.existsSync(liveDatabase)) {
      await fs.mkdir(path.join(procRoot, "92", "fd"), { recursive: true });
      await fs.symlink(liveDatabase, path.join(procRoot, "92", "fd", "53"));
    }
    const final = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), adapter, deps: { procRoot } });
    await stageSnapshot(final.stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('pre'), ('final')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(final.deps, migrationId);

    expect(result.getBody()).toEqual({ migrationId, slug: "chris", imported: true });
    expect(result.getStatus()).toBe(200);
    expect(rowCount(liveDatabase)).toBe(2);
    expect(releaseAgent).not.toHaveBeenCalled();
    expect(final.deps.adapter.activateImportedCustomer).toHaveBeenCalledOnce();
    await expect(fs.access(path.dirname(pre.stageDir))).rejects.toThrow();
  });

  it("pre-copies Shared repositories while keeping agent files private and removes them on abort", async () => {
    const importDir = await mkTempRoot();
    const migrationId = "mig-shared-private-pre";
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), mode: "pre" });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('pre')"));
    await fs.writeFile(path.join(stageDir, "agents/octogee-chris-coach/agent/auth.json"), "agent configuration");
    await fs.mkdir(path.join(stageDir, "customers/chris/projects/project"), { recursive: true });
    await fs.writeFile(path.join(stageDir, "customers/chris/projects/project/README.md"), "source checkout");
    const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnMock.mockImplementation(spawn);

    const finished = await finishImport(deps, migrationId, "pre");

    expect(finished.getStatus()).toBe(200);
    expect(await fs.readFile(path.join(importDir, "customers/chris/projects/project/README.md"), "utf8")).toBe("source checkout");
    await expect(fs.access(path.join(importDir, "agents"))).rejects.toThrow();
    const privateRoot = path.join(path.dirname(stageDir), ".octogee-import", migrationId);
    expect(rowCount(path.join(privateRoot, CARRIED_STORE))).toBe(1);
    expect((await fs.stat(privateRoot)).mode & 0o777).toBe(0o700);
    expect(deps.adapter.activateImportedCustomer).not.toHaveBeenCalled();

    const body: AbortRsyncImportRequestBody = { migrationId, slug: "chris", mode: "pre", rpcPhase: "abort-rsync-import" };
    const aborted = mkResponse();
    await createAbortRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), aborted.res, vi.fn());
    expect(aborted.getStatus()).toBe(200);
    await expect(fs.access(path.dirname(stageDir))).rejects.toThrow();
    expect(await fs.readFile(path.join(importDir, "customers/chris/projects/project/README.md"), "utf8")).toBe("source checkout");
  });

  it("rejects Builder pre-copy without a configured activation gate before staging agent state", async () => {
    vi.stubEnv("POD_UID", "builder-without-gate");
    const prepareImportDir = vi.fn(async () => "/unused-builder-state");
    const deps = mkDeps({ adapter: mkAdapter({
      isBuilderGateway: () => true,
      isConfiguredBuilderCustomer: () => true,
      prepareImportDir,
    }) });
    const body: PrepareRsyncImportRequestBody = {
      migrationId: "mig-builder-without-gate", slug: "chris", mode: "pre",
      rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "c".repeat(64),
    };
    const response = mkResponse();

    await createPrepareRsyncImportHandler(deps)(mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());

    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toMatchObject({ message: "configured Builder activation requires its pod-bound process gate" });
    expect(prepareImportDir).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("releases an occupied destination through OpenClaw before replacing its database", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, () => {});
    await fs.writeFile(`${previous}-wal`, "previous wal");
    const releaseAgent = vi.fn(async () => undefined);
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-release",
      importDir,
      daemon: mkFakeChild(),
      adapter: { releaseAgent },
      deps: { procRoot },
    });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO transcript_events VALUES ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus } = await finishImport(deps, "mig-carry-release");

    expect(getStatus()).toBe(200);
    expect(releaseAgent).toHaveBeenCalledWith("octogee-chris-coach");
    expect(rowCount(previous)).toBe(1);
    await expect(fs.access(`${previous}-wal`)).rejects.toThrow();
  });

  it("refuses to replace a database a process still holds after release", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, (db) => db.exec("INSERT INTO transcript_events VALUES ('previous')"));
    await fs.mkdir(path.join(procRoot, "92", "fd"), { recursive: true });
    await fs.symlink(`${previous}-shm (deleted)`, path.join(procRoot, "92", "fd", "41"));
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-held",
      importDir,
      daemon: mkFakeChild(),
      adapter: { releaseAgent: vi.fn(async () => undefined) },
      deps: { procRoot },
    });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO transcript_events VALUES ('carried'), ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-held");

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: `agent database files are still held open: ${previous}-shm` });
    expect(rowCount(previous)).toBe(1);
    expect(deps.adapter.activateImportedCustomer).not.toHaveBeenCalled();
  });

  it("refuses to replace an occupied database when the gateway cannot release agents", async () => {
    const importDir = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, () => {});
    const { deps, stageDir } = await prepareImport({ migrationId: "mig-carry-no-release", importDir, daemon: mkFakeChild() });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-no-release");

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: expect.stringContaining("cannot release agents") });
    expect(fsSync.existsSync(previous)).toBe(true);
    expect(deps.adapter.activateImportedCustomer).not.toHaveBeenCalled();
  });

  function builderTargetImport(openClawHeld: MigrationHandlerDeps["surgeTargetOpenClawHeld"]): {
    adapter: Partial<CustomerLifecycleAdapter>;
    deps: Partial<MigrationHandlerDeps>;
  } {
    vi.stubEnv("POD_UID", "builder-pod");
    return {
      adapter: {
        isBuilderGateway: () => true,
        isConfiguredBuilderCustomer: (slug) => slug === "chris",
        releaseAgent: vi.fn(async () => undefined),
      },
      deps: {
        reserveSurgeTarget: vi.fn(async () => undefined),
        releaseSurgeReadiness: vi.fn(async () => undefined),
        unreserveSurgeTarget: vi.fn(async () => HELD_BUILDER_GATE_STATE),
        ...(openClawHeld ? { surgeTargetOpenClawHeld: openClawHeld } : {}),
      },
    };
  }

  it("prepares a held Builder with its agent snapshot installed before offline hydration", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const migrationId = "mig-builder-pre-installed";
    const target = builderTargetImport(async () => true);
    await writeStore(importDir, CARRIED_STORE, () => {});
    const prepareSurgeTarget = vi.fn(async () => {
      expect(rowCount(path.join(importDir, CARRIED_STORE))).toBe(1);
    });
    const { deps, stageDir } = await prepareImport({
      migrationId, importDir, daemon: mkFakeChild(), mode: "pre", adapter: target.adapter,
      deps: { ...target.deps, procRoot, prepareSurgeTarget },
    });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('pre')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId, "pre");

    expect(result.getStatus()).toBe(200);
    expect(prepareSurgeTarget).toHaveBeenCalledOnce();
    expect(deps.adapter.releaseAgent).not.toHaveBeenCalled();
    expect(deps.releaseSurgeReadiness).not.toHaveBeenCalled();
    migrationTempRoots.push(path.dirname(stageDir));
  });

  it("replaces an occupied database on a held Builder target without calling its unreleased OpenClaw", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, (db) => db.exec("INSERT INTO transcript_events VALUES ('previous')"));
    await fs.writeFile(`${previous}-wal`, "previous session wal");
    const surgeTargetOpenClawHeld = vi.fn(async () => true);
    const target = builderTargetImport(surgeTargetOpenClawHeld);
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-held-builder",
      importDir,
      daemon: mkFakeChild(),
      adapter: target.adapter,
      deps: { ...target.deps, procRoot },
    });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO transcript_events VALUES ('carried'), ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus } = await finishImport(deps, "mig-carry-held-builder");

    expect(getStatus()).toBe(200);
    expect(surgeTargetOpenClawHeld).toHaveBeenCalledWith({
      migrationId: "mig-carry-held-builder", slug: "chris", targetPodUid: "builder-pod",
    });
    expect(deps.adapter.releaseAgent).not.toHaveBeenCalled();
    expect(rowCount(previous)).toBe(2);
    await expect(fs.access(`${previous}-wal`)).rejects.toThrow();
    expect(deps.releaseSurgeReadiness).toHaveBeenCalledOnce();
  });

  it("still refuses to replace a held Builder target's database while a process holds it", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, (db) => db.exec("INSERT INTO transcript_events VALUES ('previous')"));
    await fs.mkdir(path.join(procRoot, "77", "fd"), { recursive: true });
    await fs.symlink(`${previous}-wal`, path.join(procRoot, "77", "fd", "9"));
    const target = builderTargetImport(async () => true);
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-held-builder-open",
      importDir,
      daemon: mkFakeChild(),
      adapter: target.adapter,
      deps: { ...target.deps, procRoot },
    });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-held-builder-open");

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: `agent database files are still held open: ${previous}-wal` });
    expect(rowCount(previous)).toBe(1);
    expect(deps.releaseSurgeReadiness).not.toHaveBeenCalled();
  });

  it("releases an occupied database through OpenClaw on a Builder target whose OpenClaw is permitted", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, () => {});
    const target = builderTargetImport(async () => false);
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-permitted-builder",
      importDir,
      daemon: mkFakeChild(),
      adapter: target.adapter,
      deps: { ...target.deps, procRoot },
    });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO transcript_events VALUES ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus } = await finishImport(deps, "mig-carry-permitted-builder");

    expect(getStatus()).toBe(200);
    expect(deps.adapter.releaseAgent).toHaveBeenCalledExactlyOnceWith("octogee-chris-coach");
    expect(rowCount(previous)).toBe(1);
  });

  it("refuses to replace a Builder target's database without its process gate status", async () => {
    const importDir = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, () => {});
    const target = builderTargetImport(undefined);
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-builder-no-status",
      importDir,
      daemon: mkFakeChild(),
      adapter: target.adapter,
      deps: target.deps,
    });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-builder-no-status");

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: expect.stringContaining("process gate status") });
    expect(deps.adapter.releaseAgent).not.toHaveBeenCalled();
    expect(fsSync.existsSync(previous)).toBe(true);
  });

  it("rejects a final running claim before overwriting or activating the target", async () => {
    const importDir = await mkTempRoot();
    const { deps, stageDir } = await prepareImport({ migrationId: "mig-running", importDir, daemon: mkFakeChild() });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO session_nodes VALUES ('running')"));
    const response = await finishImport(deps, "mig-running");
    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toMatchObject({ message: expect.stringContaining("running sessions") });
    expect(deps.adapter.activateImportedCustomer).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(fs.access(path.join(importDir, CARRIED_STORE))).rejects.toThrow();
  });

  it("does not deliver or activate state when offline upgrade fails", async () => {
    const importDir = await mkTempRoot();
    const { deps, stageDir } = await prepareImport({ migrationId: "mig-schema-failure", importDir, daemon: mkFakeChild() });
    await stageSnapshot(stageDir, () => {});
    const artifact = path.join(stageDir, STAGED_SNAPSHOT, "database.sqlite");
    const bytes = await fs.readFile(artifact);
    await fs.writeFile(path.join(stageDir, STAGED_SNAPSHOT, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      database: { role: "agent", agentId: "octogee-chris-coach" },
      artifact: { path: "database.sqlite", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    }));
    deps.runOpenClaw = vi.fn(async () => ({ code: 1, stdout: JSON.stringify({
      schema: "openclaw.agent-schema-preflight.v1", databasePath: artifact, agentId: "octogee-chris-coach",
      foundVersion: 23, targetVersion: 24, status: "incompatible",
    }) }));
    upgradeStoresMock.mockRejectedValueOnce(new Error("schema upgrade failed"));
    const { getStatus, getBody } = await finishImport(deps, "mig-schema-failure");
    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: "schema upgrade failed" });
    expect(upgradeStoresMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(deps.adapter.activateImportedCustomer).not.toHaveBeenCalled();
    await expect(fs.access(path.join(importDir, CARRIED_STORE))).rejects.toThrow();
  });
});

describe("Git metadata across migration imports", () => {
  async function tempRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-metadata-import-"));
    migrationTempRoots.push(root);
    return root;
  }

  async function importMetadata(sourceDir: string, importDir: string) {
    const adapter = mkAdapter({ prepareImportDir: vi.fn(async () => importDir) });
    const deps = mkDeps({ adapter, waitForRsyncReady: vi.fn(async () => undefined) });
    const migrationId = "mig-git-rsync";
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnMock.mockReturnValueOnce(mkFakeChild()).mockImplementation(real.spawn);
    const prepare: PrepareRsyncImportRequestBody = {
      migrationId, slug: "chris", mode: "final", rpcPhase: "prepare-rsync-import",
      transferUser: "migration", transferKey: "c".repeat(64),
    };
    const prepared = mkResponse();
    await createPrepareRsyncImportHandler(deps)(mkRequest(prepare, {
      signature: signForPod(migrationId, JSON.stringify(prepare)),
    }), prepared.res, vi.fn());
    expect(prepared.getStatus()).toBe(200);
    const args = spawnMock.mock.calls[0][1] as string[];
    const configPath = args.find((arg) => arg.startsWith("--config="))!.slice(9);
    const stageDir = /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf8"))![1]!;
    await fs.cp(sourceDir, stageDir, { recursive: true, dereference: false });
    const finish: FinishRsyncImportRequestBody = {
      migrationId, slug: "chris", mode: "final", rpcPhase: "finish-rsync-import",
    };
    const response = mkResponse();
    await createFinishRsyncImportHandler(deps)(mkRequest(finish, {
      signature: signForPod(migrationId, JSON.stringify(finish)),
    }), response.res, vi.fn());
    return { ...response, adapter };
  }

  describe("rsync", () => {
    it.each([
      ["git-metadata", "symlink"],
      ["git-metadata/chris", "symlink"],
      ["git-metadata/chris/workspace.git/objects", "symlink"],
      ["git-metadata/chris/workspace.git/objects/info/alternates", "indirection"],
      ["git-metadata/chris/workspace.git/commondir", "indirection"],
      ["git-metadata/chris/projects/demo.git/objects/info/alternates", "indirection"],
      ["git-metadata/chris/workspace.git", "gitfile"],
      ["git-metadata/chris/projects/demo.git", "gitfile"],
    ])("rejects unsafe Git metadata at %s before copying or activating", async (relative, kind) => {
      const sourceDir = await tempRoot();
      const importDir = await tempRoot();
      const outsideDir = await tempRoot();
      const customerFile = "customers/chris/draft.txt";
      for (const [root, content] of [[sourceDir, "source draft"], [importDir, "destination draft"]]) {
        await fs.mkdir(path.dirname(path.join(root, customerFile)), { recursive: true });
        await fs.writeFile(path.join(root, customerFile), content);
      }
      await fs.writeFile(path.join(outsideDir, "sentinel"), "outside metadata");
      const unsafePath = path.join(sourceDir, relative);
      await fs.mkdir(path.dirname(unsafePath), { recursive: true });
      const unsafeContent = `${kind === "gitfile" ? "gitdir: " : ""}${outsideDir}\n`;
      if (kind === "symlink") await fs.symlink(outsideDir, unsafePath);
      else await fs.writeFile(unsafePath, unsafeContent);

      const result = await importMetadata(sourceDir, importDir);

      expect(result.getStatus()).toBe(400);
      expect(result.getBody()).toMatchObject({
        error: "rsync import failed validation",
        message: expect.stringContaining("unsafe Git metadata"),
      });
      expect(spawnMock.mock.calls).toHaveLength(1);
      expect(upgradeStoresMock).not.toHaveBeenCalled();
      expect(result.adapter.activateImportedCustomer).not.toHaveBeenCalled();
      expect(result.adapter.writeMountMarker).not.toHaveBeenCalled();
      expect(result.adapter.onMounted).not.toHaveBeenCalled();
      expect(result.adapter.deleteCustomerDir).not.toHaveBeenCalled();
      expect(result.adapter.deleteDepartedCustomerState).not.toHaveBeenCalled();
      expect(result.adapter.onUnmounted).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(importDir, customerFile), "utf8")).toBe("destination draft");
      expect(await fs.readFile(path.join(sourceDir, customerFile), "utf8")).toBe("source draft");
      expect(await fs.readFile(path.join(outsideDir, "sentinel"), "utf8")).toBe("outside metadata");
      if (kind === "symlink") expect(await fs.readlink(unsafePath)).toBe(outsideDir);
      else expect(await fs.readFile(unsafePath, "utf8")).toBe(unsafeContent);
    });

    it("imports customer files without Git metadata", async () => {
      const sourceDir = await tempRoot();
      const importDir = await tempRoot();
      await fs.mkdir(path.join(sourceDir, "customers/chris"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, "customers/chris/draft.txt"), "source draft");

      const result = await importMetadata(sourceDir, importDir);

      expect(result.getStatus()).toBe(200);
      expect(await fs.readFile(path.join(importDir, "customers/chris/draft.txt"), "utf8")).toBe("source draft");
      expect(result.adapter.activateImportedCustomer).toHaveBeenCalledOnce();
    });

    it("copies normal Git metadata unchanged and activates", async () => {
      const sourceDir = await tempRoot();
      const importDir = await tempRoot();
      const files = [
        ["git-metadata/chris/workspace.git/HEAD", "ref: refs/heads/work\n"],
        ["git-metadata/chris/workspace.git/config", "[core]\n\tbare = false\n"],
        ["git-metadata/chris/workspace.git/refs/heads/work", `${"1".repeat(40)}\n`],
        ["git-metadata/chris/workspace.git/objects/ab/cdef", "object contents"],
        ["git-metadata/chris/projects/demo.git/HEAD", "ref: refs/heads/commondir\n"],
        ["git-metadata/chris/projects/demo.git/refs/heads/commondir", `${"2".repeat(40)}\n`],
        ["customers/chris/draft.txt", "source draft"],
      ];
      for (const [relative, content] of files) {
        await fs.mkdir(path.dirname(path.join(sourceDir, relative)), { recursive: true });
        await fs.writeFile(path.join(sourceDir, relative), content);
      }

      const result = await importMetadata(sourceDir, importDir);

      expect(result.getStatus()).toBe(200);
      for (const [relative, content] of files) {
        expect(await fs.readFile(path.join(importDir, relative), "utf8")).toBe(content);
      }
      expect(result.adapter.activateImportedCustomer).toHaveBeenCalledOnce();
    });
  });
});

describe("findPathTraversalViolation — no permanent operator lane", () => {
  it("rejects every legacy operator agent directory", () => {
    expect(
      findPathTraversalViolation(
        ["agents/octogee-ops-eggman/sessions/sessions.json"],
        "eggman",
      ),
    ).toContain("outside the per-slug allowlist");
  });
});

describe("findPathTraversalViolation", () => {
  const slug = "chris";

  it("returns null for a clean tarball", () => {
    expect(findPathTraversalViolation([
      "agents/octogee-chris-coach/sessions/sessions.json",
      "agents/octogee-chris-coach/",
      "memory/octogee-chris-coach.sqlite",
      "memory/octogee-chris-coach.sqlite-shm",
      "customers/chris/.git/config",
      "customer-keys/chris/id_ed25519",
      ".octogee-migration-activation/chris/activation.json",
    ], slug)).toBeNull();
  });

  it("accepts project-agent state paths owned by the migrating builder", () => {
    expect(findPathTraversalViolation([
      "agents/octogee-chris-proj-cityscout-coach/sessions/sessions.json",
      "agents/octogee-chris-proj-cityscout-coach/",
      "memory/octogee-chris-proj-cityscout-coach.sqlite",
      "memory/octogee-chris-proj-cityscout-coach.sqlite-wal",
      "memory/octogee-chris-proj-cityscout-coach.sqlite-shm",
    ], slug)).toBeNull();
  });

  it("accepts opaque Builder agent state only when the configured safe ID is allowlisted", () => {
    const state = [
      "agents/discord-helper/agent/auth.json",
      "agents/discord-helper/sessions/session.json",
      "memory/discord-helper.sqlite",
    ];
    expect(findPathTraversalViolation(state, slug, "final", ["discord-helper"])).toBeNull();
    expect(findPathTraversalViolation(state, slug, "final")).toContain(
      "outside the per-slug allowlist",
    );
    expect(findPathTraversalViolation(state, slug, "final", ["../outside"])).toContain(
      "outside the per-slug allowlist",
    );
  });

  it("accepts bare directory entries that match a prefix exactly", () => {
    expect(findPathTraversalViolation([
      "customers/chris",
      "customers/chris/",
      "customer-keys/chris",
      ".octogee-migration-activation/chris",
    ], slug)).toBeNull();
  });

  it("accepts rsync --relative parent directory entries", () => {
    expect(findPathTraversalViolation([
      "customers/",
      "customers/chris/",
      "customer-keys/",
      "customer-keys/chris/",
      "memory/",
      "memory/octogee-chris-coach.sqlite",
      ".octogee-migration-activation/",
      ".octogee-migration-activation/chris/",
    ], slug)).toBeNull();
  });

  it("accepts the customer-keys parent directory during keys-only transfer", () => {
    expect(findPathTraversalViolation([
      "customer-keys/",
      "customer-keys/chris/",
      "customer-keys/chris/id_ed25519",
    ], slug, "keys")).toBeNull();
  });

  it.each(["pre", "final"] as const)(
    "accepts an empty customer-keys parent during %s surge import",
    (mode) => {
      expect(findPathTraversalViolation([
        "customer-keys/",
      ], slug, mode)).toBeNull();
    },
  );

  it.each(["pre", "final"] as const)(
    "rejects pod-local customer keys during %s surge import",
    (mode) => {
      expect(findPathTraversalViolation([
        "customer-keys/chris/id_ed25519",
      ], slug, mode)).toContain("outside the per-slug allowlist");
    },
  );

  it("rejects an absolute-path entry", () => {
    expect(findPathTraversalViolation(["/etc/passwd"], slug)).toContain("absolute path");
  });

  it("rejects a `..` segment", () => {
    expect(findPathTraversalViolation(["customers/chris/../../../etc/passwd"], slug)).toContain("path traversal");
  });

  it("rejects a leading `..`", () => {
    expect(findPathTraversalViolation(["../etc/passwd"], slug)).toContain("path traversal");
  });

  it("does NOT false-positive on legitimate names containing `..`", () => {
    expect(findPathTraversalViolation([
      "customers/chris/notes/foo..bar.txt",
    ], slug)).toBeNull();
  });

  it("rejects a path for a different slug (cross-customer escape)", () => {
    expect(findPathTraversalViolation([
      "customers/other/secrets",
    ], slug)).toContain("outside the per-slug allowlist");
  });

  it("rejects another slug below an allowed parent directory", () => {
    expect(findPathTraversalViolation([
      "customer-keys/",
      "customer-keys/other/id_ed25519",
    ], slug, "keys")).toContain("outside the per-slug allowlist");
  });

  it("rejects a truncated file-prefix match", () => {
    expect(findPathTraversalViolation([
      "memory/octogee-chris-coach.sqlit",
    ], slug)).toContain("outside the per-slug allowlist");
  });

  it("rejects an unknown top-level directory", () => {
    expect(findPathTraversalViolation([
      "etc/openclaw.json",
    ], slug)).toContain("outside the per-slug allowlist");
  });

  it("rejects an agent dir for a different slug", () => {
    expect(findPathTraversalViolation([
      "agents/octogee-attacker-coach/sessions.json",
    ], slug)).toContain("outside the per-slug allowlist");
  });

  it("rejects project agent state for another builder", () => {
    expect(findPathTraversalViolation([
      "agents/octogee-attacker-proj-cityscout-coach/sessions.json",
    ], slug)).toContain("outside the per-slug allowlist");
    expect(findPathTraversalViolation([
      "memory/octogee-attacker-proj-cityscout-coach.sqlite",
    ], slug)).toContain("outside the per-slug allowlist");
  });

  it("rejects neutral route agent state even when a configured Builder plan includes it", () => {
    const configuredBuilderStatePlan: ConfiguredBuilderPortableStatePlan = {
      agentIds: ["octogee-unmatched-route"],
      agentDirs: ["agents/octogee-unmatched-route/agent"],
      sessionStorePaths: ["agents/octogee-unmatched-route/sessions/sessions.json"],
      paths: [
        { relativePath: "agents/octogee-unmatched-route", kind: "directory" },
        { relativePath: "workspace-octogee-unmatched-route", kind: "directory" },
        { relativePath: "workspaces/octogee-unmatched-route", kind: "directory" },
        { relativePath: "memory/octogee-unmatched-route.sqlite", kind: "file" },
      ],
    };
    expect(findPathTraversalViolation([
      "agents/octogee-unmatched-route/",
      "workspace-octogee-unmatched-route/",
      "workspaces/octogee-unmatched-route/",
      "memory/octogee-unmatched-route.sqlite",
    ], slug, "final", [], configuredBuilderStatePlan)).toContain("outside the per-slug allowlist");
  });

  it("returns the FIRST violation found (deterministic for ops messages)", () => {
    const v = findPathTraversalViolation([
      "customers/chris/ok.txt",
      "/etc/passwd",
      "../also-bad",
    ], slug);
    expect(v).toContain("absolute path");
    expect(v).toContain("/etc/passwd");
  });
});


describe("destination migration progress", () => {
  it("accepts the migration runner's rollback phase names", async () => {
    const body = { migrationId: "mig-1", slug: "chris", source: "gw-old", phase: "rollback:unmount-target", status: "running" };
    const { res, getStatus } = mkResponse();
    await createMigrationProgressHandler(mkDeps())(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), res, vi.fn());
    expect(getStatus()).toBe(200);
  });
  it.each(["running", "pending", "done", "failed"])("logs %s as structured progress", async (status) => {
    const body = { migrationId: "mig-1", slug: "chris", source: "gw-old", phase: "quiesce-source", status, elapsedMs: 123 };
    const deps = mkDeps();
    const { res, getStatus } = mkResponse();
    await createMigrationProgressHandler(deps)(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(deps.log).toHaveBeenCalledWith("Migration quiesce-source", expect.objectContaining({ builderSlug: "chris", operationId: "mig-1", sourceGateway: "gw-old", gatewayId: "gw-a", phase: "quiesce-source", status, durationMs: 123 }));
  });
  it.each([{ status: "green" }, { phase: "x\ninjected" }, { elapsedMs: -1 }, { source: "x\ninjected" }])("rejects malformed progress %j", async (invalid) => {
    const body = { migrationId: "mig-1", slug: "chris", source: "gw-old", phase: "copy", status: "done", elapsedMs: 1, ...invalid };
    const { res, getStatus } = mkResponse();
    await createMigrationProgressHandler(mkDeps())(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), res, vi.fn());
    expect(getStatus()).toBe(400);
  });
  it("rejects unsigned progress", async () => {
    const { res, getStatus } = mkResponse();
    await createMigrationProgressHandler(mkDeps())(mkRequest({ migrationId: "mig-1", slug: "chris" }), res, vi.fn());
    expect(getStatus()).toBe(401);
  });
});

describe("createResumeHandler", () => {
  it("resumes only the signed customer's channels", async () => {
    const adapter = mkAdapter();
    const body = { migrationId: SAMPLE_QUIESCE.migrationId, slug: "chris" };
    const response = mkResponse();
    await createResumeHandler(mkDeps({ adapter }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(adapter.resumeCustomer).toHaveBeenCalledExactlyOnceWith("chris");
  });
  it("does not resume channels without a valid signature", async () => {
    const adapter = mkAdapter();
    const response = mkResponse();
    await createResumeHandler(mkDeps({ adapter }))(mkRequest(SAMPLE_QUIESCE, { signature: "bad" }), response.res, vi.fn());
    expect(response.getStatus()).toBe(401);
    expect(adapter.resumeCustomer).not.toHaveBeenCalled();
  });
});


describe("scheduler readiness signed endpoint", () => {
  const body = { migrationId: "m1", slug: "chris" };
  const signed = () => mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) });
  it("confirms readiness only after a gateway RPC connects, and never touches cron.migration", async () => {
    const schedulerReady = vi.fn(async () => undefined);
    const schedulerMigration = vi.fn();
    const response = mkResponse();
    await createSchedulerReadyHandler(mkDeps({ adapter: mkAdapter({ schedulerReady, schedulerMigration }) }))(signed(), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual({ ready: true });
    expect(schedulerReady).toHaveBeenCalledOnce();
    expect(schedulerMigration).not.toHaveBeenCalled();
  });
  it("reports why the scheduler is not ready", async () => {
    const schedulerReady = vi.fn(async () => { throw new Error("OpenClaw workspace identities are not initialized for this boot"); });
    const response = mkResponse();
    await createSchedulerReadyHandler(mkDeps({ adapter: mkAdapter({ schedulerReady }) }))(signed(), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toEqual({ error: "scheduler readiness failed", message: "OpenClaw workspace identities are not initialized for this boot" });
  });
  it("rejects an unsigned readiness probe", async () => {
    const schedulerReady = vi.fn();
    const response = mkResponse();
    await createSchedulerReadyHandler(mkDeps({ adapter: mkAdapter({ schedulerReady }) }))(mkRequest(body, {}), response.res, vi.fn());
    expect(response.getStatus()).toBe(401);
    expect(schedulerReady).not.toHaveBeenCalled();
  });
});

describe("scheduler migration signed endpoint", () => {
  const body = { migrationId: "handoff-1", slug: "chris", phase: "hold" as const };
  it("rejects unsigned scheduler commands", async () => {
    const schedulerMigration = vi.fn();
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(mkRequest(body, {}), response.res, vi.fn());
    expect(response.getStatus()).toBe(401);
    expect(schedulerMigration).not.toHaveBeenCalled();
  });
  it("holds schedules under the authenticated handoff identity", async () => {
    const result = { operationId: body.migrationId, phase: body.phase, agentIds: ["octogee-chris-coach"], drained: true };
    const schedulerMigration = vi.fn(async () => result);
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual(result);
    expect(schedulerMigration).toHaveBeenCalledWith("chris", { operationId: "handoff-1", phase: "hold" });
  });
  it("does not report a draining scheduler as ready", async () => {
    const schedulerMigration = vi.fn(async () => ({ operationId: body.migrationId, phase: body.phase, agentIds: ["octogee-chris-coach"], drained: false }));
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(409);
  });
  it("forwards a partial export so host-bound jobs stay dormant here", async () => {
    const partial = { ...body, phase: "export" as const, retainNonportable: true };
    const result = { operationId: partial.migrationId, phase: "export", agentIds: ["octogee-chris-coach"], drained: true, snapshot: { retainedJobIds: ["desktop-watch"] } };
    const schedulerMigration = vi.fn(async () => result);
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
      mkRequest(partial, { signature: signForPod(partial.migrationId, JSON.stringify(partial)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(schedulerMigration).toHaveBeenCalledWith("chris", { operationId: "handoff-1", phase: "export", retainNonportable: true });
  });
  it("rejects a partial flag that is not a boolean or names a phase that cannot retain", async () => {
    for (const invalid of [{ ...body, retainNonportable: "yes" }, { ...body, phase: "retire", retainNonportable: true }]) {
      const schedulerMigration = vi.fn();
      const response = mkResponse();
      await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
        mkRequest(invalid, { signature: signForPod(invalid.migrationId, JSON.stringify(invalid)) }), response.res, vi.fn(),
      );
      expect(response.getStatus()).toBe(400);
      expect(schedulerMigration).not.toHaveBeenCalled();
    }
  });
  it("rejects staging without a snapshot before calling the runtime", async () => {
    const invalid = { ...body, phase: "stage" };
    const schedulerMigration = vi.fn();
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
      mkRequest(invalid, { signature: signForPod(invalid.migrationId, JSON.stringify(invalid)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(400);
    expect(schedulerMigration).not.toHaveBeenCalled();
  });
});

describe("prepared migration staging", () => {
  it("finishes a Shared import before ownership moves and removes source-deleted projects", async () => {
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-prepared-import-"));
    migrationTempRoots.push(importDir);
    const uidForSlug = vi.fn(async () => null);
    const loadUserSnapshot = vi.fn();
    const deps = mkDeps({
      adapter: mkAdapter({ isBuilderGateway: () => false, uidForSlug, loadUserSnapshot,
        prepareImportDir: vi.fn(async () => importDir) }),
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const migrationId = "shared-unassigned-final-import";
    const prepare = async (mode: "pre" | "final") => {
      spawnMock.mockReturnValueOnce(mkFakeChild());
      const body = { migrationId, slug: "chris", mode, rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "c".repeat(64) };
      const response = mkResponse();
      await createPrepareRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      expect(response.getStatus()).toBe(200);
      const configPath = (spawnMock.mock.calls.at(-1)![1] as string[]).find(arg => arg.startsWith("--config="))!.slice(9);
      return /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf8"))![1]!;
    };
    const finish = async (mode: "pre" | "final") => {
      spawnMock.mockImplementation(() => mkFakeChild({ exitCode: 0 }));
      const body = { migrationId, slug: "chris", mode, rpcPhase: "finish-rsync-import" };
      const response = mkResponse();
      await createFinishRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      return response;
    };
    const stageDir = await prepare("pre");
    for (const root of [stageDir, importDir]) {
      await fs.mkdir(path.join(root, "customers/chris/projects/active-repo"), { recursive: true });
      await fs.writeFile(path.join(root, "customers/chris/projects/active-repo/README.md"), "source checkout");
      await fs.mkdir(path.join(root, "customers/chris/projects/deleted-repo"), { recursive: true });
      await fs.writeFile(path.join(root, "customers/chris/projects/deleted-repo/draft"), "removed after pre-sync");
    }
    expect((await finish("pre")).getStatus()).toBe(200);
    expect(await prepare("final")).toBe(stageDir);
    await fs.rm(path.join(stageDir, "customers/chris/projects/deleted-repo"), { recursive: true });
    const completed = await finish("final");
    expect(completed.getBody()).toEqual({ migrationId, slug: "chris", imported: true });
    expect(completed.getStatus()).toBe(200);
    expect(uidForSlug).not.toHaveBeenCalled();
    expect(loadUserSnapshot).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(importDir, "customers/chris/projects/active-repo/README.md"), "utf8")).toBe("source checkout");
    await expect(fs.stat(path.join(importDir, "customers/chris/projects/deleted-repo"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not finish an existing import while another phase prepares its staging", async () => {
    vi.stubEnv("POD_UID", "concurrent-builder-pod");
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "concurrent-import-"));
    migrationTempRoots.push(importDir);
    let releasePreparation!: () => void;
    const blocked = new Promise<void>(resolve => { releasePreparation = resolve; });
    const reserveSurgeTarget = vi.fn(async () => blocked);
    const deps = mkDeps({
      adapter: mkAdapter({ isBuilderGateway: () => true,
        prepareKeyImportDir: vi.fn(async () => importDir), prepareImportDir: vi.fn(async () => importDir) }),
      reserveSurgeTarget, releaseSurgeReadiness: vi.fn(async () => undefined),
      unreserveSurgeTarget: vi.fn(async () => HELD_BUILDER_GATE_STATE),
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const migrationId = "concurrent-preparation";
    const first = { migrationId, slug: "chris", mode: "keys", rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "d".repeat(64) };
    spawnMock.mockReturnValueOnce(mkFakeChild());
    const prepared = mkResponse();
    await createPrepareRsyncImportHandler(deps)(mkRequest(first, { signature: signForPod(migrationId, JSON.stringify(first)) }), prepared.res, vi.fn());
    expect(prepared.getStatus()).toBe(200);
    const next = { ...first, mode: "pre" };
    const preparing = createPrepareRsyncImportHandler(deps)(mkRequest(next, { signature: signForPod(migrationId, JSON.stringify(next)) }), mkResponse().res, vi.fn());
    try {
      await vi.waitFor(() => expect(reserveSurgeTarget).toHaveBeenCalledOnce());
      spawnMock.mockImplementation(() => mkFakeChild({ exitCode: 0 }));
      const finish = { migrationId, slug: "chris", mode: "keys", rpcPhase: "finish-rsync-import" };
      const finished = mkResponse();
      await createFinishRsyncImportHandler(deps)(mkRequest(finish, { signature: signForPod(migrationId, JSON.stringify(finish)) }), finished.res, vi.fn());
      expect(finished.getStatus()).toBe(409);
      expect(finished.getBody()).toEqual({ error: "migration import completion is already in progress" });
    } finally {
      releasePreparation();
      await preparing;
      const abort = { migrationId, slug: "chris", mode: "pre", rpcPhase: "abort-rsync-import" };
      await createAbortRsyncImportHandler(deps)(mkRequest(abort, { signature: signForPod(migrationId, JSON.stringify(abort)) }), mkResponse().res, vi.fn());
    }
  });

  it("reuses the prepared file tree for final synchronization and holds Builder startup", async () => {
    vi.stubEnv("POD_UID", "builder-prepared-pod");
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "prepared-import-"));
    migrationTempRoots.push(importDir);
    const prepareSurgeTarget = vi.fn(async () => undefined);
    const releaseSurgeReadiness = vi.fn(async () => undefined);
    const deps = mkDeps({
      adapter: mkAdapter({ isBuilderGateway: () => true, prepareImportDir: vi.fn(async () => importDir),
        loadUserSnapshot: vi.fn(async () => ({ ...RESTORE_SNAPSHOT, agentIds: [...RESTORE_SNAPSHOT.agentIds], channels: [], projects: [{ projectId: "new", projectSlug: "new-repo", giteaRepoName: "chris-new-repo" }] })),
      }),
      reserveSurgeTarget: vi.fn(async () => undefined), prepareSurgeTarget,
      releaseSurgeReadiness, unreserveSurgeTarget: vi.fn(async () => HELD_BUILDER_GATE_STATE),
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const migrationId = "prepared-persistent-stage";
    const prepare = async (mode: "pre" | "final") => {
      spawnMock.mockReturnValueOnce(mkFakeChild());
      const body = { migrationId, slug: "chris", mode, rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "b".repeat(64) };
      const response = mkResponse();
      await createPrepareRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      expect(response.getStatus()).toBe(200);
      const call = spawnMock.mock.calls.at(-1)!;
      const configPath = (call[1] as string[]).find(arg => arg.startsWith("--config="))!.slice(9);
      return /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf8"))![1]!;
    };
    const stageDir = await prepare("pre");
    await fs.mkdir(path.join(stageDir, "customers/chris"), { recursive: true });
    await fs.writeFile(path.join(stageDir, "customers/chris/draft.txt"), "uncommitted source work");
    spawnMock.mockImplementation(() => mkFakeChild({ exitCode: 0 }));
    const finish = { migrationId, slug: "chris", mode: "pre", rpcPhase: "finish-rsync-import" };
    const finished = mkResponse();
    await createFinishRsyncImportHandler(deps)(mkRequest(finish, { signature: signForPod(migrationId, JSON.stringify(finish)) }), finished.res, vi.fn());
    expect(finished.getStatus()).toBe(200);
    expect(prepareSurgeTarget).toHaveBeenCalledWith({ migrationId, slug: "chris", targetPodUid: "builder-prepared-pod" });
    expect(releaseSurgeReadiness).not.toHaveBeenCalled();
    const finalStage = await prepare("final");
    expect(finalStage).toBe(stageDir);
    expect(await fs.readFile(path.join(finalStage, "customers/chris/draft.txt"), "utf8")).toBe("uncommitted source work");
    await fs.mkdir(path.join(importDir, "customers/chris/projects/new-repo"), { recursive: true });
    await fs.writeFile(path.join(importDir, "customers/chris/projects/new-repo/README.md"), "prepared checkout");
    await fs.mkdir(path.join(importDir, "customers/chris/projects/archived-repo"), { recursive: true });
    await fs.writeFile(path.join(importDir, "customers/chris/projects/archived-repo/draft"), "prepared before project removal");
    await fs.writeFile(path.join(importDir, "customers/chris/draft.txt"), "old source content");
    await fs.rm(path.join(finalStage, "customers/chris/draft.txt"));
    const finishFinal = { migrationId, slug: "chris", mode: "final", rpcPhase: "finish-rsync-import" };
    const completed = mkResponse();
    await createFinishRsyncImportHandler(deps)(mkRequest(finishFinal, { signature: signForPod(migrationId, JSON.stringify(finishFinal)) }), completed.res, vi.fn());
    expect(completed.getStatus()).toBe(200);
    await expect(fs.stat(path.join(importDir, "customers/chris/draft.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(importDir, "customers/chris/projects/new-repo/README.md"), "utf8")).toBe("prepared checkout");
    await expect(fs.stat(path.join(importDir, "customers/chris/projects/archived-repo"))).rejects.toMatchObject({ code: "ENOENT" });
    const abort = { migrationId, slug: "chris", mode: "final", rpcPhase: "abort-rsync-import" };
    await createAbortRsyncImportHandler(deps)(mkRequest(abort, { signature: signForPod(migrationId, JSON.stringify(abort)) }), mkResponse().res, vi.fn());
    await expect(fs.stat(stageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
