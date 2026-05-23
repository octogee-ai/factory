

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import {
  createExportHandler,
  createImportHandler,
  createQuiesceHandler,
  createUnmountHandler,
  findPathTraversalViolation,
  type MigrationHandlerDeps,
} from "../lib/fleet-http-migration.js";
import { signFleetRequest } from "../lib/fleet-signature.js";
import {
  SIGNATURE_HEADER,
  MIGRATION_ID_HEADER,
  MIGRATION_SLUG_HEADER,
  type QuiesceRequestBody,
  type UnmountRequestBody,
  type MigrationRequestBody,
} from "../../shared/types/fleet-controller.js";
import type { CustomerLifecycleAdapter } from "../lib/customer-lifecycle.js";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const SECRET = "test-secret";
const GATEWAY_ID = "gw-a";

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

function mkRequest<T>(body: T, opts: { signature?: string; rawBody?: string } = {}): Request {
  const rawBody = opts.rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (opts.signature !== undefined) headers[SIGNATURE_HEADER.toLowerCase()] = opts.signature;
  return {
    header: (name: string) => headers[name.toLowerCase()],
    rawBody,
  } as unknown as Request;
}

function mkImportRequest(opts: {
  migrationId?: string;
  slug?: string;
  signature?: string;
  body?: Readable;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.migrationId !== undefined) headers[MIGRATION_ID_HEADER.toLowerCase()] = opts.migrationId;
  if (opts.slug !== undefined) headers[MIGRATION_SLUG_HEADER.toLowerCase()] = opts.slug;
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
    activateImportedCustomer: vi.fn(async () => {}),

hasCustomerDir: vi.fn(() => true),
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
    secret: SECRET,
    gatewayId: GATEWAY_ID,
    adapter: mkAdapter(),
    log: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  spawnMock.mockReset();
});

function mkFakeChild(opts: {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
} = {}): EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
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
      signature: signFleetRequest(SECRET, "x", "{}"),
    });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
  });

  it("rejects malformed slug with 400", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const body: QuiesceRequestBody = { migrationId: "m", slug: "../etc" };
    const rawBody = JSON.stringify(body);
    const sig = signFleetRequest(SECRET, body.migrationId, rawBody);
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
    const sig = signFleetRequest(SECRET, SAMPLE_QUIESCE.migrationId, rawBody);
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
    const sig = signFleetRequest(SECRET, SAMPLE_QUIESCE.migrationId, rawBody);
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
    const sig = signFleetRequest(SECRET, body.migrationId, rawBody);
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
    const sig = signFleetRequest(SECRET, SAMPLE_QUIESCE.migrationId, rawBody);
    const req = mkRequest(SAMPLE_QUIESCE, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ error: "quiesce failed", message: "boom" });
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
    const handler = createUnmountHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signFleetRequest(SECRET, SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      unmounted: false,
    });
  });

  it("returns 200 + unmounted:true when removeCustomerFromGateway succeeded", async () => {

const adapter = mkAdapter();
    const handler = createUnmountHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signFleetRequest(SECRET, SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ unmounted: true });
    expect(adapter.applyRemoveCustomerConfigPatch).toHaveBeenCalled();
    expect(adapter.deleteCustomerDir).toHaveBeenCalled();
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
    const sig = signFleetRequest(SECRET, SAMPLE_EXPORT.migrationId, rawBody);
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
    const sig = signFleetRequest(SECRET, SAMPLE_EXPORT.migrationId, rawBody);
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
    const sig = signFleetRequest(SECRET, "mig-1", "chris");
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
    expect(adapter.prepareImportDir).toHaveBeenCalledWith("chris");
    expect(adapter.activateImportedCustomer).toHaveBeenCalledWith(
      "chris",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

expect(spawnMock.mock.calls.length).toBe(2);
    expect(spawnMock.mock.calls[0][0]).toBe("tar");
    expect(spawnMock.mock.calls[0][1][0]).toBe("-tf"); 
    expect(spawnMock.mock.calls[1][1][0]).toBe("-xf"); 
  });

  it("returns 400 when the tarball contains a path-traversal entry (no extract attempted)", async () => {

const adapter = mkAdapter();
    const fakeListChild = mkFakeChild({
      stdout: ["customers/chris/ok.txt\n/etc/passwd\n"],
      exitCode: 0,
    });
    spawnMock.mockReturnValueOnce(fakeListChild);

    const handler = createImportHandler(mkDeps({ adapter }));
    const sig = signFleetRequest(SECRET, "mig-1", "chris");
    const req = mkImportRequest({ migrationId: "mig-1", slug: "chris", signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
    expect((getBody() as { error?: string }).error).toBe("tarball failed validation");
    expect((getBody() as { message?: string }).message).toContain("absolute path");
    expect(spawnMock.mock.calls.length).toBe(1); 
    expect(adapter.activateImportedCustomer).not.toHaveBeenCalled();
  });

  it("returns 200 alreadyMounted=true (noop) when the slug is in the gateway's mounted set", async () => {
    const adapter = mkAdapter();
    const handler = createImportHandler(
      mkDeps({ adapter, getMountedCustomers: () => ["chris"] }),
    );
    const sig = signFleetRequest(SECRET, "mig-1", "chris");
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
      alreadyMounted: true,
    });
    expect(adapter.prepareImportDir).not.toHaveBeenCalled();
    expect(adapter.activateImportedCustomer).not.toHaveBeenCalled();
    expect(spawnMock.mock.calls.length).toBe(0);
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
      return new Promise<void>((_resolve, reject) => {
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
    const sig = signFleetRequest(SECRET, "mig-1", "chris");
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
    const sig = signFleetRequest(SECRET, "mig-1", "chris");
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

describe("findPathTraversalViolation", () => {
  const slug = "chris";

  it("returns null for a clean tarball", () => {
    expect(findPathTraversalViolation([
      "agents/octogee-chris-coach/sessions/sessions.json",
      "agents/octogee-chris-coach/",
      "customers/chris/.git/config",
      "customer-keys/chris/id_ed25519",
    ], slug)).toBeNull();
  });

  it("accepts bare directory entries that match a prefix exactly", () => {
    expect(findPathTraversalViolation([
      "customers/chris",
      "customers/chris/",
      "customer-keys/chris",
    ], slug)).toBeNull();
  });

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

