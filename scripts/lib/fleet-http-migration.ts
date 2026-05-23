

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

export interface MigrationHandlerDeps {
  secret: string;
  gatewayId: string;
  adapter: CustomerLifecycleAdapter;
  
  log?: (msg: string) => void;

getMountedCustomers?: () => readonly string[];
}

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

return verifyFleetRequest(secret, migrationId, slug, sigHeader);
}

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

export function createExportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<MigrationRequestBody>(req, res, deps.secret, log);
    if (!body) return;

    try {
      const sources = await deps.adapter.listExportPaths(body.slug);
      if (sources.length === 0) {

res.status(404).json({ error: "no export paths", message: `nothing to export for slug=${body.slug}` });
        return;
      }
      log(
        `[migration-http] export migrationId=${body.migrationId} slug=${body.slug} streaming ${sources.length} path(s)`,
      );

const tarArgs = [

"-cf", "-",
        ...sources.flatMap((s) => ["-C", s.cwd, s.path]),
      ];
      const child = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"] }); // eslint-disable-line sonarjs/no-os-command-from-path -- gateway image, PATH controlled

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
        if (errored) return; 
        if (code !== 0) {

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
      
      if (!res.headersSent) {
        res.status(500).json({ error: "export setup failed", message });
      } else {
        res.destroy(err instanceof Error ? err : new Error(message));
      }
    }
  };
}

function attachImportDisconnectHandlers(
  res: Response,
  migrationId: string,
  slug: string,
  log: (msg: string) => void,
): { controller: AbortController; detach: () => void } {

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

tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-${migrationId}-`));
      const tarPath = path.join(tmpDir, "import.tar");

await streamRequestToFile(req, tarPath);

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

await extractTarToDir(tarPath, importDir);

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

if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };
}

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

const entry = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (entry.startsWith("/")) {
      return `absolute path in tarball: ${raw}`;
    }

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

export function createUnmountHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<UnmountRequestBody>(req, res, deps.secret, log);
    if (!body) return;

    try {
      const uid = await deps.adapter.uidForSlug(body.slug);
      if (!uid) {
        
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

export function customerCoachAgentId(slug: string): string {
  return `octogee-${slug}-coach`;
}

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
