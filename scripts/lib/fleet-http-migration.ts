/**
 * Express handler factories for the gateway's migration endpoints.
 *
 *   POST /quiesce        — drain in-flight runs for one slug
 *   POST /export         — stream a tarball of agent + key state
 *   POST /import         — accept a tarball, unpack, register agent
 *   POST /unmount        — release slug + delete on-disk state
 *
 * Mirrors fleet-http.ts (which owns /restore-customer) for the pieces that
 * are the same: HMAC signature verification, raw-body capture, the
 * `:gatewayId` path-param mismatch guard. What's new is per-handler:
 *
 *   - /quiesce + /unmount are JSON request, JSON response — easy.
 *   - /export streams the tarball as the response body. Status + body are
 *     entangled, so error reporting splits: errors before bytes ship send
 *     JSON; errors mid-stream are signalled by closing the connection
 *     short of Content-Length. Caller validates against the tar trailer.
 *   - /import takes the tarball as the request body. We can't sign body
 *     bytes (could be hundreds of MB streamed) so the HMAC signs the
 *     {migrationId, slug} pair carried in headers. Body integrity is
 *     bounded by HTTPS transport + the operator-controlled deploy
 *     surface; if/when the threat model widens we add a content-sha256
 *     trailer.
 *
 * Authentication reuses the existing FLEET_CONTROLLER_SECRET. The
 * orchestrator (CLI) signs the same way `fleet-controller` Cloud Functions
 * sign — symmetric with /restore-customer — so the secret already in the
 * gateway's env covers all five endpoints.
 */

import type { Request, Response, RequestHandler } from "express";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type ImportResponse,
  type MigrationRequestBody,
  type QuiesceRequestBody,
  type QuiesceResponse,
  type UnmountRequestBody,
  type UnmountResponse,
  SIGNATURE_HEADER,
  MIGRATION_ID_HEADER,
  MIGRATION_SLUG_HEADER,
} from "../../shared/types/fleet-controller.js";
import { isValidUsername } from "../../shared/types/identity.js";
import { verifyFleetRequest } from "./fleet-signature.js";
import type { CustomerLifecycleAdapter } from "./customer-lifecycle.js";
import { removeCustomerFromGateway } from "./customer-lifecycle.js";

// ── Shared deps + helpers ───────────────────────────────────────────────────

export interface MigrationHandlerDeps {
  secret: string;
  gatewayId: string;
  adapter: CustomerLifecycleAdapter;
  /** Default `console.log`; tests inject a spy. */
  log?: (msg: string) => void;
  /**
   * In-memory `mountedCustomers` accessor for the /import idempotency
   * check. When supplied, /import returns 200 with `alreadyMounted: true`
   * if the slug is already in this gateway's mounted set, skipping
   * `prepareImportDir` (which would otherwise wipe a live customer's dir).
   */
  getMountedCustomers?: () => readonly string[];
}

/** Slug-shape guard. Reuses the canonical username validator
 *  ([shared/types/identity.ts](../../shared/types/identity.ts)) — same rules
 *  every other subsystem (workspace creation, MM team naming, channel
 *  routing) enforces. Drift here would let an RPC accept a slug other
 *  parts of the system reject, which is the bug class we're guarding
 *  against. */
function rejectInvalidSlug(slug: string, res: Response): boolean {
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid slug" });
    return true;
  }
  return false;
}

function parseAndVerifyJsonBody<T extends MigrationRequestBody>(
  req: Request,
  res: Response,
  secret: string,
  log: (msg: string) => void,
): T | null {
  const rawBody: string = (req as unknown as { rawBody?: string }).rawBody ?? "";
  let body: T;
  try {
    body = JSON.parse(rawBody) as T;
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return null;
  }
  if (!body?.migrationId || !body?.slug) {
    res.status(400).json({ error: "missing migrationId/slug" });
    return null;
  }
  if (rejectInvalidSlug(body.slug, res)) return null;

  const sigHeader = req.header(SIGNATURE_HEADER);
  // Sign over `${migrationId}\n${rawBody}` — same canonical payload as the
  // /restore-customer scheme, with migrationId in the jobId slot. Not a
  // separate jobId-equivalent for migration; one migrationId is enough to
  // bind all four RPCs together.
  const sigValid = verifyFleetRequest(secret, body.migrationId, rawBody, sigHeader ?? undefined);
  if (!sigValid) {
    log(`[migration-http] ⚠ bad signature migrationId=${body.migrationId} slug=${body.slug}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  return body;
}

function verifyHeaderSignature(
  migrationId: string,
  slug: string,
  sigHeader: string | undefined,
  secret: string,
): boolean {
  // For /import (body is the tarball), the canonical payload is the
  // `${migrationId}\n${slug}` header pair — the same shape verifyFleetRequest
  // expects, just with slug in place of rawBody. Reuses the constant-time
  // compare without introducing a second signing primitive.
  return verifyFleetRequest(secret, migrationId, slug, sigHeader);
}

// ── /quiesce ────────────────────────────────────────────────────────────────

export function createQuiesceHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<QuiesceRequestBody>(req, res, deps.secret, log);
    if (!body) return;

    try {
      const result = await deps.adapter.quiesceCustomer(body.slug, body.timeoutMs ?? 60_000);
      const response: QuiesceResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        drained: result.drained,
        runningCount: result.runningCount,
      };
      log(
        `[migration-http] quiesce migrationId=${body.migrationId} slug=${body.slug} → drained=${result.drained} runningCount=${result.runningCount}`,
      );
      res.status(result.drained ? 200 : 408).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] ❌ quiesce migrationId=${body.migrationId} slug=${body.slug} failed: ${message}`);
      res.status(500).json({ error: "quiesce failed", message });
    }
  };
}

// ── /export ─────────────────────────────────────────────────────────────────

export function createExportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<MigrationRequestBody>(req, res, deps.secret, log);
    if (!body) return;

    try {
      const sources = await deps.adapter.listExportPaths(body.slug);
      if (sources.length === 0) {
        // No state to export — likely the slug isn't mounted on this
        // gateway. Return 404 so the orchestrator surfaces a clear error
        // instead of pushing an empty tarball that the target would
        // happily accept and end up with no agent state.
        res.status(404).json({ error: "no export paths", message: `nothing to export for slug=${body.slug}` });
        return;
      }
      log(
        `[migration-http] export migrationId=${body.migrationId} slug=${body.slug} streaming ${sources.length} path(s)`,
      );

      // Tar over a pipe to the response. We use the system `tar` binary
      // here rather than a JS tar library: tar(1) handles symlinks, sparse
      // files, and streaming back-pressure correctly out of the box, and
      // OpenClaw's per-agent state directories include a few config
      // symlinks we do NOT want to dereference.
      const tarArgs = [
        // Preserve symlinks; don't follow them. -h would replace links with
        // their targets and bloat the tarball + break the agent on import.
        "-cf", "-",
        ...sources.flatMap((s) => ["-C", s.cwd, s.path]),
      ];
      const child = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"] }); // eslint-disable-line sonarjs/no-os-command-from-path -- gateway image, PATH controlled

      // Spawn-failure listener — fires before any stdout bytes flow if e.g.
      // tar isn't on PATH. Without this listener Node treats the `error`
      // event as unhandled and crashes the process. We commit headers AFTER
      // attaching it so a sync spawn failure can still respond with JSON.
      let stderrBuf = "";
      let errored = false;
      child.on("error", (err) => {
        errored = true;
        log(`[migration-http] ❌ export spawn migrationId=${body.migrationId} slug=${body.slug}: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: "tar spawn failed", message: err.message });
        } else {
          res.destroy(err);
        }
      });
      child.stderr.on("data", (d) => {
        stderrBuf += d.toString();
      });

      res.status(200);
      res.setHeader("Content-Type", "application/x-tar");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${body.slug}.tar"`,
      );
      child.stdout.pipe(res);
      child.on("close", (code) => {
        if (errored) return; // already handled by the error listener
        if (code !== 0) {
          // Stream already flushed, can't change status. Log + close;
          // orchestrator will see truncated tar (validate via tar trailer).
          log(
            `[migration-http] ❌ export migrationId=${body.migrationId} slug=${body.slug} tar exit=${code} stderr=${stderrBuf.trim()}`,
          );
          res.destroy(new Error(`tar exit ${code}`));
        } else {
          log(`[migration-http] ✅ export migrationId=${body.migrationId} slug=${body.slug} done`);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] ❌ export setup migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      // If headers haven't been sent yet, JSON the error.
      if (!res.headersSent) {
        res.status(500).json({ error: "export setup failed", message });
      } else {
        res.destroy(err instanceof Error ? err : new Error(message));
      }
    }
  };
}

// ── /import ─────────────────────────────────────────────────────────────────

function attachImportDisconnectHandlers(
  res: Response,
  migrationId: string,
  slug: string,
  log: (msg: string) => void,
): { controller: AbortController; detach: () => void } {
  // Listen on `res` rather than `req`: the underlying socket close
  // triggers both, and `req.aborted` was deprecated in Node 17 (replaced
  // by `close` + `!req.complete`). `res.writableEnded` is the canonical
  // "did we finish responding" check, so a `res.on("close")` that fires
  // before writableEnded is the only signal we need for both mid-body
  // and post-body client disconnects.
  const controller = new AbortController();
  const onResClose = () => {
    if (res.writableEnded || controller.signal.aborted) return;
    log(
      `[migration-http] client closed connection before response sent migrationId=${migrationId} slug=${slug} — aborting`,
    );
    controller.abort(new Error(`client disconnected mid-import`));
  };
  res.on("close", onResClose);
  return {
    controller,
    detach: () => {
      res.removeListener("close", onResClose);
    },
  };
}

/**
 * Returns true (and short-circuits the handler) if the slug is already in
 * this gateway's `mountedCustomers` set.
 *
 * Residual race: this is a synchronous snapshot, not an atomic check. If a
 * concurrent caller is mid-mount and `onMounted` fires *between* this
 * check and `prepareImportDir` (~ms apart), the dir-wipe still happens
 * on a live customer. The check narrows the window from the multi-minute
 * orchestrator-retry-during-stuck-mount case to a sub-ms one; the per-
 * gateway concurrency cap added in #931 closes the upstream side so two
 * orchestrator calls can't reach this point at the same time today. If
 * the cap is ever moved to a higher level (Firestore lock for multi-replica),
 * revisit by making this check + `prepareImportDir` an atomic transition
 * under a per-slug mutex.
 */
function maybeRespondAlreadyMounted(
  deps: MigrationHandlerDeps,
  res: Response,
  migrationId: string,
  slug: string,
  log: (msg: string) => void,
): boolean {
  if (!deps.getMountedCustomers?.().includes(slug)) return false;
  log(
    `[migration-http] import migrationId=${migrationId} slug=${slug} already mounted — noop (skipping prepareImportDir, no tar read)`,
  );
  const response: ImportResponse = {
    migrationId,
    slug,
    imported: true,
    alreadyMounted: true,
  };
  res.status(200).json(response);
  return true;
}

function validateImportRequest(
  deps: MigrationHandlerDeps,
  req: Request,
  res: Response,
  log: (msg: string) => void,
): { migrationId: string; slug: string } | null {
  const migrationId = req.header(MIGRATION_ID_HEADER);
  const slug = req.header(MIGRATION_SLUG_HEADER);
  if (!migrationId || !slug) {
    res.status(400).json({
      error: "missing migration headers",
      required: [MIGRATION_ID_HEADER, MIGRATION_SLUG_HEADER],
    });
    return null;
  }
  if (rejectInvalidSlug(slug, res)) return null;
  const sigHeader = req.header(SIGNATURE_HEADER);
  if (!verifyHeaderSignature(migrationId, slug, sigHeader, deps.secret)) {
    log(`[migration-http] ⚠ bad signature on import migrationId=${migrationId} slug=${slug}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  if (maybeRespondAlreadyMounted(deps, res, migrationId, slug, log)) return null;
  return { migrationId, slug };
}

function respondImportFailure(
  res: Response,
  controllerSignal: AbortSignal,
  err: unknown,
): void {
  if (res.writableEnded) return;
  const message = err instanceof Error ? err.message : String(err);
  if (controllerSignal.aborted && !res.headersSent) {
    // Nginx convention: 499 Client Closed Request — distinguishes a
    // caller-side abort from a genuine server error in dashboards.
    res.status(499).json({ error: "client disconnected", message });
    return;
  }
  if (!res.headersSent) {
    res.status(500).json({ error: "import failed", message });
    return;
  }
  res.destroy(err instanceof Error ? err : new Error(message));
}

export function createImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const validated = validateImportRequest(deps, req, res, log);
    if (!validated) return;
    const { migrationId, slug } = validated;

    const { controller, detach } = attachImportDisconnectHandlers(
      res,
      migrationId,
      slug,
      log,
    );

    let tmpDir: string | null = null;
    try {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("aborted");
      const importDir = await deps.adapter.prepareImportDir(slug);
      log(
        `[migration-http] import migrationId=${migrationId} slug=${slug} unpacking → ${importDir}`,
      );

      // Path-traversal safety: stream the request body to a temp file,
      // list its contents with `tar -tf` and validate every entry against
      // the slug-keyed prefix allowlist BEFORE extracting. A crafted tar
      // could otherwise contain `../foo` or `/etc/passwd` entries that
      // tar(1) would happily write outside `importDir`. The HMAC only
      // signs the {migrationId, slug} header pair (body bytes are too
      // large to fit in the canonical-payload contract), so the body
      // itself is untrusted from a defense-in-depth standpoint.
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-${migrationId}-`));
      const tarPath = path.join(tmpDir, "import.tar");

      // 1. Stream request body to disk.
      await streamRequestToFile(req, tarPath);

      // 2. List entries + validate.
      const entries = await listTarEntries(tarPath);
      const violation = findPathTraversalViolation(entries, slug);
      if (violation !== null) {
        log(
          `[migration-http] ⚠ import migrationId=${migrationId} slug=${slug} rejected: ${violation}`,
        );
        res.status(400).json({
          error: "tarball failed validation",
          message: violation,
        });
        return;
      }

      // 3. Extract from temp file (no longer reading from network).
      await extractTarToDir(tarPath, importDir);

      // 4. Hand off to the adapter for agent register + activation
      // (config patch + verify-channel-ready, the regular addCustomer
      // path tail-end). The signal propagates client disconnects so a
      // bailed-out caller doesn't leave activate running for ~5 minutes
      // after they gave up.
      await deps.adapter.activateImportedCustomer(slug, { signal: controller.signal });

      const response: ImportResponse = { migrationId, slug, imported: true };
      log(`[migration-http] ✅ import migrationId=${migrationId} slug=${slug} done`);
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] ❌ import migrationId=${migrationId} slug=${slug}: ${message}`);
      respondImportFailure(res, controller.signal, err);
    } finally {
      detach();
      // Always clean up the temp tarball — it's the customer's full state
      // and we should never leave it on disk past the request.
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };
}

// ── /import helpers (path-traversal safety) ─────────────────────────────────

async function streamRequestToFile(req: Request, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const writeStream = createWriteStream(dest);
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    req.on("error", (err) => settle(() => reject(err)));
    writeStream.on("error", (err) => settle(() => reject(err)));
    writeStream.on("finish", () => settle(() => resolve()));
    req.pipe(writeStream);
  });
}

async function listTarEntries(tarPath: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- gateway image, PATH controlled
    const child = spawn("tar", ["-tf", tarPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.split("\n").filter((s) => s.length > 0));
      else reject(new Error(`tar -tf exit ${code}: ${stderr.trim()}`));
    });
  });
}

async function extractTarToDir(tarPath: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- gateway image, PATH controlled
    const child = spawn("tar", ["-xf", tarPath, "-C", dest], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar -xf exit ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Validate every entry in the tar listing against the per-slug allowlist.
 * Returns null if all entries are clean, or a human-readable error string
 * describing the first violation (caller surfaces this to the orchestrator
 * so the operator can see what went wrong).
 *
 * Allowed prefixes for slug X (matches `listExportPaths` in the prod
 * adapter):
 *   agents/octogee-X-coach/...
 *   customers/X/...
 *   customer-keys/X/...
 *
 * Anything outside those prefixes — absolute paths, `..` segments, paths
 * for a different slug, paths to system locations — is a hard reject.
 * Bare directory entries that match a prefix exactly are allowed.
 */
export function findPathTraversalViolation(
  entries: readonly string[],
  slug: string,
): string | null {
  const allowedPrefixes = [
    `agents/octogee-${slug}-coach/`,
    `customers/${slug}/`,
    `customer-keys/${slug}/`,
  ];
  for (const raw of entries) {
    // tar -tf can output a trailing slash for directory entries — strip
    // for the prefix check so `customers/X/` and `customers/X` both match.
    const entry = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (entry.startsWith("/")) {
      return `absolute path in tarball: ${raw}`;
    }
    // Splitting on "/" + checking for ".." is byte-cheap and catches
    // every traversal shape (../, foo/.., foo/../bar). String.includes("..")
    // would false-positive on legitimate names like "foo..bar".
    if (entry.split("/").includes("..")) {
      return `path traversal '..' in tarball: ${raw}`;
    }
    const allowed = allowedPrefixes.some((p) => entry === p.slice(0, -1) || entry.startsWith(p));
    if (!allowed) {
      return `path '${raw}' is outside the per-slug allowlist (agents/octogee-${slug}-coach, customers/${slug}, customer-keys/${slug})`;
    }
  }
  return null;
}

// ── /unmount ────────────────────────────────────────────────────────────────

export function createUnmountHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<UnmountRequestBody>(req, res, deps.secret, log);
    if (!body) return;

    try {
      const uid = await deps.adapter.uidForSlug(body.slug);
      if (!uid) {
        // Idempotent: no user means already unmounted (or never assigned).
        const response: UnmountResponse = {
          migrationId: body.migrationId,
          slug: body.slug,
          unmounted: false,
        };
        log(
          `[migration-http] unmount migrationId=${body.migrationId} slug=${body.slug} → no user; idempotent no-op`,
        );
        res.status(200).json(response);
        return;
      }
      const result = await removeCustomerFromGateway(deps.adapter, uid);
      const response: UnmountResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        unmounted: result.wasMounted,
      };
      log(
        `[migration-http] ✅ unmount migrationId=${body.migrationId} slug=${body.slug} wasMounted=${result.wasMounted} steps=${result.steps.join(",")}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] ❌ unmount migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "unmount failed", message });
    }
  };
}

// ── Helpers exported for use by the prod adapter / tests ────────────────────

/**
 * Default agent-id convention: `octogee-${slug}-coach`. Matches the value
 * passed to scheduleBootGreetingCron in customer-lifecycle.ts. Centralized
 * here so the migration RPCs and the adapter agree on the OpenClaw side.
 */
export function customerCoachAgentId(slug: string): string {
  return `octogee-${slug}-coach`;
}

/**
 * Default OpenClaw state dir resolution. Mirrors OpenClaw's own resolution
 * (OPENCLAW_STATE_DIR env override, falling back to `~/.openclaw`). The
 * gateway image runs as the `node` user with HOME=/home/node.
 */
export function resolveOpenClawStateDir(): string {
  const fromEnv = process.env.OPENCLAW_STATE_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const home = process.env.HOME ?? "/home/node";
  return path.join(home, ".openclaw");
}

export interface SessionsJson {
  sessions: Array<{
    sessionId?: string;
    status?: "running" | "done" | "failed" | "killed" | "timeout";
  }>;
}

/**
 * Read the sessions.json for an agent. Returns an empty list if the file
 * doesn't exist (agent has never been touched on this pod). Used by the
 * quiesce poll loop to detect drain.
 */
export async function readAgentSessions(
  stateDir: string,
  agentId: string,
): Promise<SessionsJson["sessions"]> {
  const sessionsPath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
  try {
    const raw = await fs.readFile(sessionsPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionsJson>;
    return parsed.sessions ?? [];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
}
