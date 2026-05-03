/**
 * Tests for the gateway-side migration HTTP handlers.
 *
 *   - /quiesce + /unmount: full request → response cycle. JSON in, JSON out,
 *     no streaming. We exercise auth, slug validation, body parsing, and
 *     the delegate calls into the adapter.
 *   - /export + /import: request validation only (auth, slug, headers).
 *     The streaming tar plumbing involves real subprocess piping and is
 *     covered by an integration smoke test path inside startFleetController
 *     (out of scope for unit tests; would require fixture state directories).
 */
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

// ── Spawn mock — tar handlers shell out, but we only want to verify the
// invocation shape, not actually tar files. Mock at module scope so all
// handler tests share it; per-test reset in beforeEach.
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

// ── Test doubles ────────────────────────────────────────────────────────────

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
  // EventEmitter-shaped pipe target so we can assert the import handler
  // wires req → tar.stdin without going through real network buffers.
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
  // Real Writable so the export handler's `child.stdout.pipe(res)` doesn't
  // throw EBADF — sink that swallows bytes. Express adds `status`/`json`/
  // `setHeader`/`destroy` shims on top of the underlying socket writable;
  // we mirror that shape here. Without this the export test's pipe would
  // crash and the handler would go down its error path while still
  // satisfying the surface-level assertions.
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
  // Minimal adapter — only the methods migration handlers call. Other
  // methods are vi.fn() stubs that throw if accidentally invoked.
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
    // removeCustomerFromGateway flow: needs hasCustomerDir + applyRemove +
    // deleteCustomerDir (snapshot.status === "complete" → wasMounted=true).
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

/**
 * Build a fake child_process for spawnMock. Defaults: empty stdout/stderr
 * + writable stdin sink. `exitCode` arms the child to emit `close` ONCE
 * a listener is attached (avoids races when the handler awaits I/O before
 * spawning — emitting `close` synchronously into a pre-listener EE drops
 * the event). Caller can omit `exitCode` to leave the child unarmed and
 * handle close manually.
 */
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
    // Wait for the FIRST `close` listener — handlers attach `error` and
    // possibly `data` listeners before `close`, so we can't use `once` (it
    // would fire on the wrong event and never see `close`).
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

// ── /quiesce ────────────────────────────────────────────────────────────────

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

// ── /unmount ────────────────────────────────────────────────────────────────

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
    // The handler delegates to removeCustomerFromGateway, which in turn
    // calls applyRemoveCustomerConfigPatch + deleteCustomerDir. We assert
    // those got called via the adapter spies — confirms the flow without
    // re-testing customer-lifecycle internals.
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

// ── /export ─────────────────────────────────────────────────────────────────

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

    // Stub spawn to a no-op child that emits exit=0 immediately.
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
    // Expect: -cf - -C /state agents/octogee-chris-coach -C /openclaw customer-keys/chris
    expect(args).toEqual([
      "-cf", "-",
      "-C", "/state", "agents/octogee-chris-coach",
      "-C", "/openclaw", "customer-keys/chris",
    ]);
    expect(getStatus()).toBe(200);
    expect(getHeaders()["content-type"]).toBe("application/x-tar");
  });
});

// ── /import ─────────────────────────────────────────────────────────────────

describe("createImportHandler", () => {
  it("rejects missing migration headers with 400", async () => {
    const handler = createImportHandler(mkDeps());
    const req = mkImportRequest({}); // no headers at all
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
    // The new import flow has THREE stages with two spawn calls:
    //   1. streamRequestToFile (no spawn — pure fs)
    //   2. listTarEntries → spawn("tar", ["-tf", tarPath])
    //   3. extractTarToDir → spawn("tar", ["-xf", tarPath, "-C", dest])
    // Mock both spawn calls in order: first returns a clean entry list on
    // stdout, second exits 0.
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
    expect(adapter.activateImportedCustomer).toHaveBeenCalledWith("chris");

    // Both spawn invocations were tar with the right verbs.
    expect(spawnMock.mock.calls.length).toBe(2);
    expect(spawnMock.mock.calls[0][0]).toBe("tar");
    expect(spawnMock.mock.calls[0][1][0]).toBe("-tf"); // list pass
    expect(spawnMock.mock.calls[1][1][0]).toBe("-xf"); // extract pass
  });

  it("returns 400 when the tarball contains a path-traversal entry (no extract attempted)", async () => {
    // listTarEntries returns one safe entry + one absolute-path entry.
    // findPathTraversalViolation rejects → handler 400s, NEVER spawns the
    // extract pass, NEVER calls activateImportedCustomer.
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
    expect(spawnMock.mock.calls.length).toBe(1); // only the list pass
    expect(adapter.activateImportedCustomer).not.toHaveBeenCalled();
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

// ── findPathTraversalViolation ──────────────────────────────────────────────
//
// Pure-function validation against the per-slug allowlist. The HMAC-on-
// headers shape of /import means body bytes aren't signed, so this is the
// last line of defense against a crafted tarball escaping importDir.

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
    // A filename like `foo..bar` is fine — only `..` as a path SEGMENT
    // is traversal-shaped. Plain string includes("..") would reject this.
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

