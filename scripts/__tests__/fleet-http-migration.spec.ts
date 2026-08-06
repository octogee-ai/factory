

import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  createActivateImportHandler,
  createActivationManifestExportHandler,
  createAbortRsyncImportHandler,
  createCompleteSurgeHandoffHandler,
  createExportHandler,
  createExportPathsHandler,
  createFlushHandler,
  createFinishRsyncImportHandler,
  createImportHandler,
  createPrepareImportHandler,
  createPrepareRsyncImportHandler,
  createPushRsyncStateHandler,
  createPushStateHandler,
  createQuiesceHandler,
  createRestoreHandler,
  createUnmountHandler,
  createVerifyHandler,
  findPathTraversalViolation,
  sendPushStateImportResponse,
  type MigrationHandlerDeps,
} from "../lib/fleet-http-migration.js";
import { signFleetRequest } from "../lib/fleet-signature.js";
import {
  SIGNATURE_HEADER,
  MIGRATION_ID_HEADER,
  MIGRATION_MODE_HEADER,
  MIGRATION_SLUG_HEADER,
  type QuiesceRequestBody,
  type UnmountRequestBody,
  type MigrationRequestBody,
  type PushStateRequestBody,
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
import {
  hasMountedMarker,
  writeMigratingInPin,
  writeMountedMarker,
} from "../lib/local-coach-wired.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

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

const SAMPLE_EXPORT: MigrationRequestBody = {
  migrationId: "mig-1",
  slug: "chris",
};

const SAMPLE_COMPLETE_SURGE: CompleteSurgeHandoffRequestBody = {
  migrationId: "surge-gw-a-pod-123",
  targetPodUid: "pod-123",
};

const SAMPLE_PUSH: PushStateRequestBody = {
  migrationId: "mig-1",
  slug: "chris",
  targetGatewayId: "gw-b",
  targetUrl: "http://target-gateway:18789",
  targetImportSignature: signFleetRequest(PRIVATE_KEY, "mig-1", "chris"),
};

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
  greetingPosted: true,
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

function mkRequest<T>(
  body: T,
  opts: { signature?: string; rawBody?: string; localAddress?: string } = {},
): Request {
  const rawBody = opts.rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (opts.signature !== undefined) headers[SIGNATURE_HEADER.toLowerCase()] = opts.signature;
  return {
    header: (name: string) => headers[name.toLowerCase()],
    rawBody,
    socket: {
      localAddress: opts.localAddress,
      address: () => ({ address: opts.localAddress ?? "127.0.0.1", family: "IPv4", port: 3003 }),
    },
  } as unknown as Request;
}

function mkImportRequest(opts: {
  migrationId?: string;
  slug?: string;
  mode?: string;
  signature?: string;
  body?: Readable;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.migrationId !== undefined) headers[MIGRATION_ID_HEADER.toLowerCase()] = opts.migrationId;
  if (opts.slug !== undefined) headers[MIGRATION_SLUG_HEADER.toLowerCase()] = opts.slug;
  if (opts.mode !== undefined) headers[MIGRATION_MODE_HEADER.toLowerCase()] = opts.mode;
  if (opts.signature !== undefined) headers[SIGNATURE_HEADER.toLowerCase()] = opts.signature;

const body = opts.body ?? Readable.from(["dummy-tar-bytes"]);
  return Object.assign(body, {
    header: (name: string) => headers[name.toLowerCase()],
  }) as unknown as Request;
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

describe("sendPushStateImportResponse", () => {
  it("relays successful target import responses and logs the target gateway", async () => {
    const { res, getStatus, getBody } = mkResponse();
    const log = vi.fn();
    const importResponse = new Response(
      JSON.stringify({ migrationId: "mig-1", slug: "chris", imported: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    await sendPushStateImportResponse(
      importResponse,
      { migrationId: "mig-1", slug: "chris", targetGatewayId: "gw-b" },
      res,
      log,
    );

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ migrationId: "mig-1", slug: "chris", imported: true });
    expect(log).toHaveBeenCalledWith(
      "[migration-http] ✅ push-state migrationId=mig-1 slug=chris target=gw-b done",
    );
  });
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
    quiesceCustomer: vi.fn(async () => ({ drained: true, runningCount: 0 })),
    listExportPaths: vi.fn(async () => [
      { cwd: "/tmp/state", path: "agents/octogee-chris-coach" },
    ]),
    prepareImportDir: vi.fn(async () => "/tmp/import"),
    prepareKeyImportDir: vi.fn(async () => "/tmp/import"),
    readLocalCustomerPubKey: vi.fn(() => "ssh-ed25519 LOCAL chris@gateway"),
    createGiteaUser: vi.fn(async () => undefined),
    activateImportedCustomer: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
    reassertByotForCustomer: vi.fn(async () => undefined),
    writeMountMarker: vi.fn(),
    onMounted: vi.fn(),
    waitForAccountHealthy: vi.fn(async () => true),
    hasCustomerDir: vi.fn(() => true),
    customerCoachWiredInOpenclawConfig: vi.fn(() => true),
    customerMountMarked: vi.fn(() => true),
    applyRemoveCustomerConfigPatch: vi.fn(async () => {}),
    deleteCustomerDir: vi.fn(async () => {}),
    loadUserSnapshot: vi.fn(async () => ({
      uid: "uid-chris",
      slug: "chris",
      tier: "trial",
      gatewayId: GATEWAY_ID,
      status: "complete",
      agentIds: ["octogee-chris-coach"],
      repoUrl: "git@gitea:octogee/chris.git",
      mattermostUserId: "mmuser-chris",
      greetingPosted: true,
      channels: [],
      ownerName: "Chris",
    })),
    onUnmounted: vi.fn(),
    ...overrides,
  };
}

function mkDeps(overrides: Partial<MigrationHandlerDeps> = {}): MigrationHandlerDeps {
  return {
    publicKey: PUBLIC_KEY,
    gatewayId: GATEWAY_ID,
    adapter: mkAdapter(),
    log: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("surge handoff control", () => {
  it("opens pod readiness only for a signed request", async () => {
    const releaseSurgeReadiness = vi.fn(async () => undefined);
    const handler = createCompleteSurgeHandoffHandler(mkDeps({ releaseSurgeReadiness }));
    const rawBody = JSON.stringify(SAMPLE_COMPLETE_SURGE);
    const signature = signFleetRequest(PRIVATE_KEY, SAMPLE_COMPLETE_SURGE.migrationId, rawBody);
    const { res, getStatus, getBody } = mkResponse();

    await handler(mkRequest(SAMPLE_COMPLETE_SURGE, { signature }), res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ released: true, targetPodUid: "pod-123" });
    expect(releaseSurgeReadiness).toHaveBeenCalledWith({ targetPodUid: "pod-123" });
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

async function readRequestBody(body: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("createQuiesceHandler", () => {
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

  it("rejects missing migrationId/slug with 400", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const req = mkRequest({} as QuiesceRequestBody, {
      signature: signFleetRequest(PRIVATE_KEY, "x", "{}"),
    });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
  });

  it("rejects malformed slug with 400", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const body: QuiesceRequestBody = { migrationId: "m", slug: "../etc" };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_QUIESCE.migrationId, rawBody);
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

  it("returns 408 + drained:false when adapter reports timeout", async () => {
    const adapter = mkAdapter({
      quiesceCustomer: vi.fn(async () => ({ drained: false, runningCount: 2 })),
    });
    const handler = createQuiesceHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_QUIESCE.migrationId, rawBody);
    const req = mkRequest(SAMPLE_QUIESCE, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(408);
    expect(getBody()).toMatchObject({ drained: false, runningCount: 2 });
  });

  it("defaults timeoutMs to 60_000 when omitted", async () => {
    const adapter = mkAdapter();
    const handler = createQuiesceHandler(mkDeps({ adapter }));
    const body: QuiesceRequestBody = { migrationId: "m", slug: "chris" };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_QUIESCE.migrationId, rawBody);
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
      signature: signFleetRequest(PRIVATE_KEY, body.migrationId, JSON.stringify(body)),
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
      steps: [{ name: "workspace-git", status: "done" as const, durationMs: 10 }],
    }));
    const handler = createFlushHandler(mkDeps({ flushLocalState }));
    const body = { migrationId: "mig-1", slug: "chris", reason: "idle" };
    const req = mkRequest(body, {
      signature: signFleetRequest(PRIVATE_KEY, body.migrationId, JSON.stringify(body)),
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
      steps: [{ name: "workspace-git", status: "done", durationMs: 10 }],
    });
  });

  it("fails closed when the gateway did not configure a flush implementation", async () => {
    const handler = createFlushHandler(mkDeps());
    const body = { migrationId: "mig-1", slug: "chris" };
    const req = mkRequest(body, {
      signature: signFleetRequest(PRIVATE_KEY, body.migrationId, JSON.stringify(body)),
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
      signature: signFleetRequest(PRIVATE_KEY, body.migrationId, JSON.stringify(body)),
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
      signature: signFleetRequest(PRIVATE_KEY, body.migrationId, JSON.stringify(body)),
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
      signature: signFleetRequest(PRIVATE_KEY, body.migrationId, JSON.stringify(body)),
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
        signature: signFleetRequest(
          PRIVATE_KEY,
          flushBody.migrationId,
          JSON.stringify(flushBody),
        ),
      }),
      flushResponse.res,
      vi.fn(),
    );
    await started;

    const unmountRaw = JSON.stringify(SAMPLE_UNMOUNT);
    const unmountResponse = mkResponse();
    await createUnmountHandler(deps)(
      mkRequest(SAMPLE_UNMOUNT, {
        signature: signFleetRequest(
          PRIVATE_KEY,
          SAMPLE_UNMOUNT.migrationId,
          unmountRaw,
        ),
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
      signature: signFleetRequest(PRIVATE_KEY, body.migrationId, JSON.stringify(body)),
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
    const handler = createVerifyHandler(mkDeps({ adapter }));
    const body = { migrationId: "mig-1", slug: "chris", timeoutMs: 5_000 };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
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
    const handler = createVerifyHandler(mkDeps({ adapter }));
    const body = { migrationId: "mig-1", slug: "chris" };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(409);
    expect(getBody()).toMatchObject({
      ready: false,
      checks: { mountMarked: false },
    });
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
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "snapshot mismatch" });
  });
});

describe("createUnmountHandler", () => {
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
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_UNMOUNT.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_UNMOUNT.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_UNMOUNT.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ unmounted: true });
    expect(adapter.applyRemoveCustomerConfigPatch).toHaveBeenCalled();
    expect(adapter.deleteCustomerDir).toHaveBeenCalled();
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
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(removalPatchApplied).toBe(true);
    expect(pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
  });
});

describe("createExportHandler", () => {
  it("rejects bad signature with 401", async () => {
    const handler = createExportHandler(mkDeps());
    const req = mkRequest(SAMPLE_EXPORT, { signature: "deadbeef" });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(401);
  });

  it("returns 404 when there's nothing to export for the slug", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => []),
    });
    const handler = createExportHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_EXPORT);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_EXPORT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_EXPORT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(404);
    expect(getBody()).toMatchObject({ error: "no export paths" });
  });

  it("kicks off tar with -C/path arg pairs derived from listExportPaths", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
        { cwd: "/openclaw", path: "customer-keys/chris" },
      ]),
    });

const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
    };
    fakeChild.stdout = Readable.from([Buffer.from("tar-bytes")]);
    fakeChild.stderr = Readable.from([]);
    spawnMock.mockReturnValueOnce(fakeChild);

    const handler = createExportHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_EXPORT);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_EXPORT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_EXPORT, { signature: sig });
    const { res, getStatus, getHeaders } = mkResponse();
    await handler(req, res, vi.fn());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe("tar");
    
    expect(args).toEqual([
      "-cf", "-",
      "-C", "/state", "agents/octogee-chris-coach",
      "-C", "/openclaw", "customer-keys/chris",
    ]);
    expect(getStatus()).toBe(200);
    expect(getHeaders()["content-type"]).toBe("application/x-tar");
  });
});

describe("queued-rsync migration control handlers", () => {
  it("createExportPathsHandler filters key-only mode down to the customer key dir", async () => {
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
      mode: "keys",
    };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
      const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
    const handler = createActivationManifestExportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ migrationId: "mig-1", slug: "chris", manifest });
  });

  it("createActivateImportHandler activates and marks the imported customer mounted", async () => {
    const markCustomerMigratingIn = vi.fn();
    const onMounted = vi.fn();
    const recordAppliedFingerprint = vi.fn();
    const createGiteaUser = vi.fn(async () => undefined);
    const adapter = mkAdapter({
      markCustomerMigratingIn,
      readLocalCustomerPubKey: vi.fn(() => "ssh-ed25519 TARGET chris@gateway"),
      createGiteaUser,
      activateImportedCustomer: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
      recordAppliedFingerprint,
      onMounted,
    });
    const body: ActivateImportRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    expect(recordAppliedFingerprint).toHaveBeenCalledWith("chris", "fp-chris");
    expect(onMounted).toHaveBeenCalledWith("chris");
    expect(getBody()).toMatchObject({ migrationId: "mig-1", slug: "chris", imported: true });
  });

  it("createPrepareRsyncImportHandler opens a one-time target rsync import session", async () => {
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markCustomerMigratingIn: vi.fn(),
    });
    const waitForRsyncReady = vi.fn(async () => undefined);
    const daemon = mkFakeChild();
    spawnMock.mockReturnValueOnce(daemon);
    const body: PrepareRsyncImportRequestBody = {
      migrationId: "mig-rsync",
      slug: "chris",
      mode: "pre",
      transferUser: "migration",
      transferKey: "a".repeat(64),
      sourcePodIp: SOURCE_POD_IP,
    };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
    const handler = createPrepareRsyncImportHandler(
      mkDeps({ adapter, migrationRsyncPort: 30873, waitForRsyncReady }),
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
    });
    expect(adapter.prepareImportDir).toHaveBeenCalledWith("chris", "pre");
    expect(adapter.markCustomerMigratingIn).toHaveBeenCalledWith("chris");
    expect(waitForRsyncReady).toHaveBeenCalledWith(30873);
    expect(String(spawnMock.mock.calls[0][0])).toMatch(/\/rsync$/);
    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(
      expect.arrayContaining(["--daemon", "--no-detach", "--port=30873"]),
    );
    const configArg = spawnArgs.find((arg) => arg.startsWith("--config="));
    expect(configArg).toBeDefined();
    const configPath = configArg?.slice("--config=".length) ?? "";
    const config = await fs.readFile(configPath, "utf-8");
    expect(config).toContain(`pid file = ${configPath.replace(/rsyncd\.conf$/, "rsyncd.pid")}`);
    expect(config).toContain(`lock file = ${configPath.replace(/rsyncd\.conf$/, "rsyncd.lock")}`);
    expect(config).toContain(`  hosts allow = ${SOURCE_POD_IP}`);

    const abortBody: AbortRsyncImportRequestBody = {
      migrationId: "mig-rsync",
      slug: "chris",
      mode: "pre",
    };
    const abortRaw = JSON.stringify(abortBody);
    const abortSig = signFleetRequest(PRIVATE_KEY, abortBody.migrationId, abortRaw);
    const abortHandler = createAbortRsyncImportHandler(mkDeps({ adapter }));
    const abortReq = mkRequest(abortBody, { signature: abortSig });
    const abortRes = mkResponse();
    await abortHandler(abortReq, abortRes.res, vi.fn());
    expect(daemon.kill).toHaveBeenCalled();
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
      mode: "pre",
      transferUser: "migration",
      transferKey: "a".repeat(64),
    };
    const interruptedRaw = JSON.stringify(interrupted);
    const interruptedResponse = mkResponse();
    try {
      await handler(
        mkRequest(interrupted, {
          signature: signFleetRequest(PRIVATE_KEY, interrupted.migrationId, interruptedRaw),
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
          signature: signFleetRequest(PRIVATE_KEY, resumed.migrationId, resumedRaw),
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
          signature: signFleetRequest(PRIVATE_KEY, otherMigration.migrationId, otherRaw),
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
      mode: "final",
      targetHost: TARGET_POD_IP,
      targetPort: 30873,
      transferUser: "migration",
      transferKey: "b".repeat(64),
      includeActivationManifest: true,
    };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
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
    expect(args).toContain(`rsync://migration@${TARGET_POD_IP}:30873/state/`);
  });

  it("createFinishRsyncImportHandler copies staged bytes and activates the customer", async () => {
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      activateImportedCustomer: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
      markCustomerMigratingIn: vi.fn(),
      onMounted: vi.fn(),
    });
    const daemon = mkFakeChild();
    const copy = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(daemon).mockReturnValueOnce(copy);
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-finish",
      slug: "chris",
      mode: "final",
      transferUser: "migration",
      transferKey: "c".repeat(64),
    };
    const prepareRaw = JSON.stringify(prepareBody);
    const prepareSig = signFleetRequest(PRIVATE_KEY, prepareBody.migrationId, prepareRaw);
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
      mode: "final",
    };
    const finishRaw = JSON.stringify(finishBody);
    const finishSig = signFleetRequest(PRIVATE_KEY, finishBody.migrationId, finishRaw);
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
    expect(adapter.writeMountMarker).toHaveBeenCalledWith("chris");
    expect(adapter.onMounted).toHaveBeenCalledWith("chris");
    const [copyCommand, copyArgs] = spawnMock.mock.calls[1] as [string, string[]];
    expect(copyCommand).toMatch(/\/rsync$/);
    expect(copyArgs.at(-1)).toBe("/openclaw/");
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
      mode: "keys",
      transferUser: "migration",
      transferKey: "d".repeat(64),
    };
    const prepareRaw = JSON.stringify(prepareBody);
    const prepareHandler = createPrepareRsyncImportHandler(deps);
    await prepareHandler(
      mkRequest(prepareBody, { signature: signFleetRequest(PRIVATE_KEY, prepareBody.migrationId, prepareRaw) }),
      mkResponse().res,
      vi.fn(),
    );

    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-keys-exit",
      slug: "chris",
      mode: "keys",
    };
    const finishRaw = JSON.stringify(finishBody);
    const finishHandler = createFinishRsyncImportHandler(deps);
    const finishResponse = mkResponse();
    const finish = finishHandler(
      mkRequest(finishBody, { signature: signFleetRequest(PRIVATE_KEY, finishBody.migrationId, finishRaw) }),
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

describe("createPushStateHandler", () => {
  it("streams a tar directly into the target gateway import endpoint", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
        { cwd: "/openclaw", path: "customers/chris" },
      ]),
    });
    const fakeChild = mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://target-gateway:18789/import/gw-b");
      const headers = init?.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("application/x-tar");
      expect(headers[SIGNATURE_HEADER]).toBe(signFleetRequest(PRIVATE_KEY, "mig-1", "chris"));
      expect(headers[MIGRATION_ID_HEADER]).toBe("mig-1");
      expect(headers[MIGRATION_SLUG_HEADER]).toBe("chris");
      expect(init?.body).toBe(fakeChild.stdout);
      expect(await readRequestBody(init?.body)).toBe("tar-bytes");
      expect((init as RequestInit & { duplex?: string })?.duplex).toBe("half");
      return new Response(
        JSON.stringify({ migrationId: "mig-1", slug: "chris", imported: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const handler = createPushStateHandler(mkDeps({ adapter, fetch: fetchMock }));
    const rawBody = JSON.stringify(SAMPLE_PUSH);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_PUSH.migrationId, rawBody);
    const req = mkRequest(SAMPLE_PUSH, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ migrationId: "mig-1", slug: "chris", imported: true });
    expect(adapter.listExportPaths).toHaveBeenCalledWith("chris");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe("tar");
    expect(spawnMock.mock.calls[0][1]).toEqual([
      "-cf", "-",
      "-C", "/state", "agents/octogee-chris-coach",
      "-C", "/openclaw", "customers/chris",
    ]);
  });

  it.each(["pre", "final"] as const)(
    "excludes project checkouts from a workspace-only %s transfer",
    async (mode) => {
      const adapter = mkAdapter({
        listExportPaths: vi.fn(async () => [
          { cwd: "/state", path: "agents/octogee-chris-coach" },
          { cwd: "/openclaw", path: "customers/chris" },
        ]),
      });
      spawnMock.mockReturnValueOnce(mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 }));
      const fetchMock = vi.fn(async () => new Response(
        JSON.stringify({ migrationId: "mig-1", slug: "chris", imported: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
      const body: PushStateRequestBody = {
        ...SAMPLE_PUSH,
        mode,
        projectCheckoutScope: "workspace-only",
      };
      const rawBody = JSON.stringify(body);
      const handler = createPushStateHandler(mkDeps({ adapter, fetch: fetchMock }));
      const req = mkRequest(body, {
        signature: signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody),
      });
      const { res, getStatus } = mkResponse();

      await handler(req, res, vi.fn());

      expect(getStatus()).toBe(200);
      expect(spawnMock.mock.calls[0][1]).toEqual([
        "-cf", "-",
        "--exclude=customers/chris/projects",
        "-C", "/state", "agents/octogee-chris-coach",
        "-C", "/openclaw", "customers/chris",
      ]);
    },
  );

  it("keeps project checkouts in an isolated disposable gateway transfer", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/openclaw", path: "customers/chris" },
      ]),
    });
    spawnMock.mockReturnValueOnce(mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 }));
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ migrationId: "mig-1", slug: "chris", imported: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    const body: PushStateRequestBody = {
      ...SAMPLE_PUSH,
      mode: "final",
      projectCheckoutScope: "workspace-and-projects",
    };
    const rawBody = JSON.stringify(body);
    const handler = createPushStateHandler(mkDeps({ adapter, fetch: fetchMock }));
    const req = mkRequest(body, {
      signature: signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(spawnMock.mock.calls[0][1]).toEqual([
      "-cf", "-",
      "-C", "/openclaw", "customers/chris",
    ]);
  });

  it("streams only the customer key dir in keys mode and forwards the import mode", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
        { cwd: "/openclaw", path: "customers/chris" },
        { cwd: "/openclaw", path: "customer-keys/chris" },
      ]),
      exportOpenClawActivationManifest: vi.fn(async () => {
        throw new Error("keys mode must not export activation manifests");
      }),
    });
    const fakeChild = mkFakeChild({ stdout: ["key-tar"], exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers[MIGRATION_MODE_HEADER]).toBe("keys");
      expect(await readRequestBody(init?.body)).toBe("key-tar");
      return new Response(
        JSON.stringify({ migrationId: "mig-1", slug: "chris", imported: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const body: PushStateRequestBody = { ...SAMPLE_PUSH, mode: "keys" };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
    const handler = createPushStateHandler(mkDeps({ adapter, fetch: fetchMock }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(spawnMock.mock.calls[0][1]).toEqual([
      "-cf", "-",
      "-C", "/openclaw", "customer-keys/chris",
    ]);
    expect(adapter.exportOpenClawActivationManifest).not.toHaveBeenCalled();
  });

  it("embeds an activation manifest and forwards the target-specific import signature", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
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
    const fakeChild = mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers[SIGNATURE_HEADER]).toBe("target-import-sig");
      return new Response(
        JSON.stringify({ migrationId: "mig-1", slug: "chris", imported: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const body = {
      ...SAMPLE_PUSH,
      includeActivationManifest: true,
      targetImportSignature: "target-import-sig",
    };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_PUSH.migrationId, rawBody);
    const handler = createPushStateHandler(mkDeps({ adapter, fetch: fetchMock }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(adapter.exportOpenClawActivationManifest).toHaveBeenCalledWith("chris");
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("agents/octogee-chris-coach");
    expect(args).toContain(".octogee-migration-activation/chris/activation.json");
  });

  it("Builder gateway transfers contain only the movable customer agent", async () => {
    const exportOpenClawActivationManifest = vi.fn(async () => ({
      version: 2 as const,
      slug: "eggman",
      appliedFingerprint: "fp-eggman",
      agentId: "octogee-eggman-coach",
      accountId: "eggman-coach",
      agent: { id: "octogee-eggman-coach" },
      mattermostAccount: { botToken: "coach-pat" },
      bindings: [{ agentId: "octogee-eggman-coach" }],
    }));
    const adapter = mkAdapter({
      isBuilderGateway: vi.fn(() => true),
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-eggman-coach" },
      ]),
      exportOpenClawActivationManifest,
    });
    const fakeChild = mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(await readRequestBody(init?.body)).toBe("tar-bytes");
      return new Response(
        JSON.stringify({ migrationId: "mig-operator", slug: "eggman", imported: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const body: PushStateRequestBody = {
      migrationId: "mig-operator",
      slug: "eggman",
      targetGatewayId: "eggman-green",
      targetUrl: "http://target-gateway:18789",
      targetImportSignature: "target-import-sig",
      includeActivationManifest: true,
    };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
    const handler = createPushStateHandler(mkDeps({ adapter, fetch: fetchMock }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ migrationId: "mig-operator", slug: "eggman", imported: true });
    expect(exportOpenClawActivationManifest).toHaveBeenCalledWith("eggman");
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("agents/octogee-eggman-coach");
    expect(args.some((arg) => arg.includes("octogee-ops-"))).toBe(false);
    expect(args).toContain(".octogee-migration-activation/eggman/activation.json");
  });

  it("fails an operator transfer when its customer activation manifest is missing", async () => {
    const exportOpenClawActivationManifest = vi.fn(async () => {
      throw new Error("[migration-activation:eggman] activation manifest agent missing or mismatched");
    });
    const adapter = mkAdapter({
      isBuilderGateway: vi.fn(() => true),
      listExportPaths: vi.fn(async () => [{ cwd: "/state", path: "agents/octogee-eggman-coach" }]),
      exportOpenClawActivationManifest,
    });
    const fakeChild = mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(await readRequestBody(init?.body)).toBe("tar-bytes");
      return new Response(
        JSON.stringify({ migrationId: "mig-operator", slug: "eggman", imported: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const body: PushStateRequestBody = {
      migrationId: "mig-operator",
      slug: "eggman",
      targetGatewayId: "eggman-green",
      targetUrl: "http://target-gateway:18789",
      targetImportSignature: "target-import-sig",
      includeActivationManifest: true,
    };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, body.migrationId, rawBody);
    const handler = createPushStateHandler(mkDeps({ adapter, fetch: fetchMock }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ error: "push-state failed" });
    expect(exportOpenClawActivationManifest).toHaveBeenCalledWith("eggman");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing targetGatewayId before spawning tar", async () => {
    const body = { migrationId: "mig-1", slug: "chris", targetUrl: "http://target" };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, "mig-1", rawBody);
    const handler = createPushStateHandler(mkDeps());
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "missing targetGatewayId" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects a missing controller-signed target import signature before spawning tar", async () => {
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      targetGatewayId: "gw-b",
      targetUrl: "http://target",
    };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(PRIVATE_KEY, "mig-1", rawBody);
    const handler = createPushStateHandler(mkDeps());
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "missing targetImportSignature" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the target import endpoint rejects the stream", async () => {
    const fakeChild = mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);
    const fetchMock = vi.fn(async () =>
      new Response("signature rejected", { status: 401 }),
    ) as unknown as typeof fetch;

    const handler = createPushStateHandler(mkDeps({ fetch: fetchMock }));
    const rawBody = JSON.stringify(SAMPLE_PUSH);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_PUSH.migrationId, rawBody);
    const req = mkRequest(SAMPLE_PUSH, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(502);
    expect(getBody()).toMatchObject({
      error: "target import failed",
      status: 401,
      message: "signature rejected",
    });
    expect(fakeChild.kill).not.toHaveBeenCalled();
  });

  it("returns target alreadyMounted success after streaming the tar", async () => {
    const fakeChild = mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          migrationId: "mig-1",
          slug: "chris",
          imported: true,
          alreadyMounted: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const handler = createPushStateHandler(mkDeps({ fetch: fetchMock }));
    const rawBody = JSON.stringify(SAMPLE_PUSH);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_PUSH.migrationId, rawBody);
    const req = mkRequest(SAMPLE_PUSH, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      imported: true,
      alreadyMounted: true,
    });
    expect(fakeChild.kill).not.toHaveBeenCalled();
  });

  it("handles a rejected target fetch after source tar streaming starts without crashing", async () => {
    const fakeChild = mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);
    const fetchMock = vi.fn(async () => {
      throw new Error("target unreachable");
    }) as unknown as typeof fetch;

    const handler = createPushStateHandler(mkDeps({ fetch: fetchMock }));
    const rawBody = JSON.stringify(SAMPLE_PUSH);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_PUSH.migrationId, rawBody);
    const req = mkRequest(SAMPLE_PUSH, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({
      error: "push-state failed",
      message: "target unreachable",
    });
    expect(fakeChild.kill).toHaveBeenCalled();
  });

  it("returns source tar failure when tar exits non-zero during streaming", async () => {
    const fakeChild = mkFakeChild({ stderr: ["tar sad"], exitCode: 2 });
    spawnMock.mockReturnValueOnce(fakeChild);
    const fetchMock = vi.fn(async () =>
      new Response("target saw stream abort", { status: 500 }),
    ) as unknown as typeof fetch;

    const handler = createPushStateHandler(mkDeps({ fetch: fetchMock }));
    const rawBody = JSON.stringify(SAMPLE_PUSH);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_PUSH.migrationId, rawBody);
    const req = mkRequest(SAMPLE_PUSH, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({
      error: "source tar failed",
      message: expect.stringMatching(/tar exit 2: tar sad/),
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(fakeChild.kill).toHaveBeenCalled();
  });

  it("aborts the target import when the controller disconnects", async () => {
    const fakeChild = mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);
    let signalSeen: AbortSignal | undefined;
    let resolveFetchStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signalSeen = init?.signal ?? undefined;
      resolveFetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        signalSeen?.addEventListener(
          "abort",
          () => reject(signalSeen?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const handler = createPushStateHandler(mkDeps({ fetch: fetchMock }));
    const rawBody = JSON.stringify(SAMPLE_PUSH);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_PUSH.migrationId, rawBody);
    const req = mkRequest(SAMPLE_PUSH, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    const handlerPromise = handler(req, res, vi.fn());
    await fetchStarted;
    (res as unknown as { emit: (e: string) => void }).emit("close");
    await handlerPromise;

    expect(signalSeen?.aborted).toBe(true);
    expect(fakeChild.kill).toHaveBeenCalled();
    expect(getStatus()).toBe(499);
    expect(getBody()).toMatchObject({ error: "controller disconnected" });
  });

  it("aborts the target import when the inner push-state timeout fires", async () => {
    const fakeChild = mkFakeChild({ stdout: ["tar-bytes"], exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);
    let signalSeen: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signalSeen = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        signalSeen?.addEventListener(
          "abort",
          () => reject(signalSeen?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const handler = createPushStateHandler(
      mkDeps({ fetch: fetchMock, pushStateTimeoutMs: 5 }),
    );
    const rawBody = JSON.stringify(SAMPLE_PUSH);
    const sig = signFleetRequest(PRIVATE_KEY, SAMPLE_PUSH.migrationId, rawBody);
    const req = mkRequest(SAMPLE_PUSH, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(signalSeen?.aborted).toBe(true);
    expect(fakeChild.kill).toHaveBeenCalled();
    expect(getStatus()).toBe(504);
    expect(getBody()).toMatchObject({ error: "push-state timed out" });
  });
});

describe("createImportHandler", () => {
  it("rejects missing migration headers with 400", async () => {
    const handler = createImportHandler(mkDeps());
    const req = mkImportRequest({}); 
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
    expect((getBody() as { error?: string }).error).toBe("missing migration headers");
  });

  it("rejects malformed slug with 400", async () => {
    const handler = createImportHandler(mkDeps());
    const req = mkImportRequest({ migrationId: "mig-1", slug: "bad slug!" });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "invalid slug" });
  });

  it("rejects bad signature with 401", async () => {
    const handler = createImportHandler(mkDeps());
    const req = mkImportRequest({
      migrationId: "mig-1",
      slug: "chris",
      signature: "deadbeef",
    });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(401);
  });

  it("returns 200 and calls activateImportedCustomer on full success", async () => {
    const adapter = mkAdapter();
    const fakeListChild = mkFakeChild({
      stdout: ["agents/octogee-chris-coach/sessions/sessions.json\ncustomers/chris/.git/HEAD\n"],
      exitCode: 0,
    });
    const fakeExtractChild = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeListChild).mockReturnValueOnce(fakeExtractChild);

    const handler = createImportHandler(mkDeps({ adapter }));
    const sig = signFleetRequest(PRIVATE_KEY, "mig-1", "chris");
    const req = mkImportRequest({
      migrationId: "mig-1",
      slug: "chris",
      signature: sig,
    });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      imported: true,
    });
    expect(adapter.prepareImportDir).toHaveBeenCalledWith("chris", "default");
    expect(adapter.activateImportedCustomer).toHaveBeenCalledWith(
      "chris",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(adapter.writeMountMarker).toHaveBeenCalledWith("chris");

    expect(spawnMock.mock.calls.length).toBe(2);
    expect(spawnMock.mock.calls[0][0]).toBe("tar");
    expect(spawnMock.mock.calls[0][1][0]).toBe("-tf");
    expect(spawnMock.mock.calls[1][1][0]).toBe("-xf");
  });

  it("imports keys mode without activating the customer", async () => {
    const adapter = mkAdapter();
    const fakeListChild = mkFakeChild({
      stdout: ["customer-keys/chris/id_ed25519\ncustomer-keys/chris/id_ed25519.pub\n"],
      exitCode: 0,
    });
    const fakeExtractChild = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeListChild).mockReturnValueOnce(fakeExtractChild);

    const handler = createImportHandler(mkDeps({ adapter }));
    const sig = signFleetRequest(PRIVATE_KEY, "mig-1", "chris");
    const req = mkImportRequest({
      migrationId: "mig-1",
      slug: "chris",
      mode: "keys",
      signature: sig,
    });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      imported: true,
    });
    expect(adapter.prepareKeyImportDir).toHaveBeenCalledWith("chris");
    expect(adapter.prepareImportDir).not.toHaveBeenCalled();
    expect(adapter.activateImportedCustomer).not.toHaveBeenCalled();
    expect(adapter.writeMountMarker).not.toHaveBeenCalled();
  });

  it("stages pre-sync state without activating or marking the target mounted", async () => {
    const adapter = mkAdapter();
    const fakeListChild = mkFakeChild({
      stdout: ["agents/octogee-chris-coach/sessions/sessions.json\ncustomers/chris/README.md\n"],
      exitCode: 0,
    });
    const fakeExtractChild = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeListChild).mockReturnValueOnce(fakeExtractChild);

    const handler = createImportHandler(mkDeps({ adapter }));
    const sig = signFleetRequest(PRIVATE_KEY, "mig-1", "chris");
    const req = mkImportRequest({
      migrationId: "mig-1",
      slug: "chris",
      mode: "pre",
      signature: sig,
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(adapter.prepareImportDir).toHaveBeenCalledWith("chris", "pre");
    expect(adapter.activateImportedCustomer).not.toHaveBeenCalled();
    expect(adapter.writeMountMarker).not.toHaveBeenCalled();
    expect(adapter.onMounted).not.toHaveBeenCalled();
  });

  it("returns 400 when the tarball contains a path-traversal entry (no extract attempted)", async () => {
    const adapter = mkAdapter();
    const fakeListChild = mkFakeChild({
      stdout: ["customers/chris/ok.txt\n/etc/passwd\n"],
      exitCode: 0,
    });
    spawnMock.mockReturnValueOnce(fakeListChild);

    const handler = createImportHandler(mkDeps({ adapter }));
    const sig = signFleetRequest(PRIVATE_KEY, "mig-1", "chris");
    const req = mkImportRequest({ migrationId: "mig-1", slug: "chris", signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
    expect((getBody() as { error?: string }).error).toBe("tarball failed validation");
    expect((getBody() as { message?: string }).message).toContain("absolute path");
    expect(spawnMock.mock.calls.length).toBe(1); 
    expect(adapter.activateImportedCustomer).not.toHaveBeenCalled();
  });

  it("refreshes the import even when the slug is already mounted so final sync is not skipped", async () => {
    const adapter = mkAdapter();
    const fakeListChild = mkFakeChild({
      stdout: ["agents/octogee-chris-coach/sessions/sessions.json\n"],
      exitCode: 0,
    });
    const fakeExtractChild = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeListChild).mockReturnValueOnce(fakeExtractChild);
    const pauseSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createImportHandler(
      mkDeps({
        adapter,
        getMountedCustomers: () => ["chris"],
        pauseSystemConfigWatch,
        resumeSystemConfigWatch,
      }),
    );
    const sig = signFleetRequest(PRIVATE_KEY, "mig-1", "chris");
    const req = mkImportRequest({
      migrationId: "mig-1",
      slug: "chris",
      mode: "final",
      signature: sig,
    });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      imported: true,
    });
    expect(adapter.prepareImportDir).toHaveBeenCalledWith("chris", "final");
    expect(adapter.activateImportedCustomer).toHaveBeenCalledWith(
      "chris",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
    expect(pauseSystemConfigWatch.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.activateImportedCustomer.mock.invocationCallOrder[0],
    );
    expect(spawnMock.mock.calls.length).toBe(2);
  });

  it("aborts activate + responds 499 when the client disconnects mid-import", async () => {
    const adapter = mkAdapter();
    let signalSeenByActivate: AbortSignal | undefined;
    let resolveActivateStarted: () => void = () => {};
    const activateStarted = new Promise<void>((r) => {
      resolveActivateStarted = r;
    });
    adapter.activateImportedCustomer = vi.fn(async (_slug: string, opts?: { signal?: AbortSignal }) => {
      signalSeenByActivate = opts?.signal;
      resolveActivateStarted();
      return new Promise<{ appliedFingerprint: string }>((_resolve, reject) => {
        const reject_ = () => reject(new Error("aborted"));
        if (opts?.signal?.aborted) {
          reject_();
          return;
        }
        opts?.signal?.addEventListener("abort", reject_);
      });
    });
    const fakeListChild = mkFakeChild({
      stdout: ["agents/octogee-chris-coach/sessions/sessions.json\n"],
      exitCode: 0,
    });
    const fakeExtractChild = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeListChild).mockReturnValueOnce(fakeExtractChild);

    const handler = createImportHandler(mkDeps({ adapter }));
    const sig = signFleetRequest(PRIVATE_KEY, "mig-1", "chris");
    const req = mkImportRequest({ migrationId: "mig-1", slug: "chris", signature: sig });
    const { res, getStatus } = mkResponse();

    const handlerPromise = handler(req, res, vi.fn());

await activateStarted;
    (res as unknown as { emit: (e: string) => void }).emit("close");

    await handlerPromise;
    expect(signalSeenByActivate).toBeInstanceOf(AbortSignal);
    expect(signalSeenByActivate?.aborted).toBe(true);
    expect(getStatus()).toBe(499);
  });

  it("returns 500 when tar exits non-zero before activation runs", async () => {
    const adapter = mkAdapter();
    const fakeChild = mkFakeChild({ stderr: ["permission denied"], exitCode: 1 });
    spawnMock.mockReturnValueOnce(fakeChild);

    const handler = createImportHandler(mkDeps({ adapter }));
    const sig = signFleetRequest(PRIVATE_KEY, "mig-1", "chris");
    const req = mkImportRequest({
      migrationId: "mig-1",
      slug: "chris",
      signature: sig,
    });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(500);
    expect((getBody() as { error?: string }).error).toBe("import failed");
    expect(adapter.activateImportedCustomer).not.toHaveBeenCalled();
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
