

import type { Request, Response, RequestHandler } from "express";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AbortRsyncImportRequestBody,
  type ImportResponse,
  type ActivateImportRequestBody,
  type ActivationManifestExportRequestBody,
  type ActivationManifestExportResponse,
  type ExportPathsRequestBody,
  type ExportPathsResponse,
  type FinishRsyncImportRequestBody,
  type FlushGatewayRequestBody,
  type FlushGatewayResponse,
  type CompleteSurgeHandoffRequestBody,
  type MigrationRequestBody,
  type MigrationTransferMode,
  type PrepareRsyncImportRequestBody,
  type PrepareRsyncImportResponse,
  type PrepareImportRequestBody,
  type PushRsyncStateRequestBody,
  type PushStateRequestBody,
  type QuiesceRequestBody,
  type QuiesceResponse,
  type RestoreMigrationRequestBody,
  type RestoreMigrationResponse,
  type UnmountRequestBody,
  type UnmountResponse,
  type VerifyMigrationRequestBody,
  type VerifyMigrationResponse,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_VERIFY_TIMEOUT_MS,
  MIGRATION_RSYNC_PORT_DEFAULT,
  SIGNATURE_HEADER,
  MIGRATION_ID_HEADER,
  MIGRATION_MODE_HEADER,
  MIGRATION_SLUG_HEADER,
} from "../../shared/types/fleet-controller.js";
import { isValidUsername } from "../../shared/types/identity.js";
import { verifyFleetRequest } from "./fleet-signature.js";
import type { CustomerLifecycleAdapter } from "./customer-lifecycle.js";
import {
  removeCustomerFromGateway,
  restoreCustomerRuntimeFromSnapshot,
  type UserSnapshot,
} from "./customer-lifecycle.js";
import {
  MIGRATION_ACTIVATION_DIR,
  writeActivationManifest,
} from "./migration-activation-manifest.js";

export interface MigrationHandlerDeps {
  publicKey: string;
  gatewayId: string;
  adapter: CustomerLifecycleAdapter;

  log?: (msg: string) => void;

  now?: () => number;

getMountedCustomers?: () => readonly string[];

fetch?: typeof globalThis.fetch;

pushStateTimeoutMs?: number;

migrationRsyncPort?: number;

waitForRsyncReady?: (port: number) => Promise<void>;

flushLocalState?: (input: {
  slug: string;
  reason: string;
}) => Promise<Omit<FlushGatewayResponse, "migrationId" | "slug">>;
releaseSurgeReadiness?: (input: { targetPodUid: string }) => Promise<void>;
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
  publicKey: string,
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

const sigValid = verifyFleetRequest(publicKey, body.migrationId, rawBody, sigHeader ?? undefined);
  if (!sigValid) {
    log(`[migration-http] ⚠ bad signature migrationId=${body.migrationId} slug=${body.slug}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  return body;
}

function parseAndVerifySurgeBody(
  req: Request,
  res: Response,
  publicKey: string,
  log: (msg: string) => void,
): CompleteSurgeHandoffRequestBody | null {
  const rawBody: string = (req as unknown as { rawBody?: string }).rawBody ?? "";
  let body: CompleteSurgeHandoffRequestBody;
  try {
    body = JSON.parse(rawBody) as CompleteSurgeHandoffRequestBody;
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return null;
  }
  if (
    typeof body.migrationId !== "string" ||
    body.migrationId.length === 0 ||
    typeof body.targetPodUid !== "string" ||
    body.targetPodUid.length === 0 ||
    body.targetPodUid.length > 128
  ) {
    res.status(400).json({ error: "missing or invalid migrationId/targetPodUid" });
    return null;
  }
  const signature = req.header(SIGNATURE_HEADER);
  if (!verifyFleetRequest(publicKey, body.migrationId, rawBody, signature ?? undefined)) {
    log(`[surge-handoff] bad signature migrationId=${body.migrationId}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  return body;
}

export function createCompleteSurgeHandoffHandler(
  deps: MigrationHandlerDeps,
): RequestHandler {
  const log = deps.log ?? ((message) => console.log(message));
  return async (req, res) => {
    const body = parseAndVerifySurgeBody(req, res, deps.publicKey, log);
    if (!body) return;
    if (!deps.releaseSurgeReadiness) {
      res.status(500).json({ error: "surge readiness is not configured" });
      return;
    }
    try {
      await deps.releaseSurgeReadiness({ targetPodUid: body.targetPodUid });
      log(`[surge-handoff] readiness released targetPodUid=${body.targetPodUid}`);
      res.status(200).json({ released: true, targetPodUid: body.targetPodUid });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[surge-handoff] readiness release failed: ${message}`);
      res.status(500).json({ error: "surge readiness release failed", message });
    }
  };
}

function verifyHeaderSignature(
  migrationId: string,
  slug: string,
  sigHeader: string | undefined,
  publicKey: string,
): boolean {

return verifyFleetRequest(publicKey, migrationId, slug, sigHeader);
}

function tarArgsForSources(sources: Array<{ cwd: string; path: string }>): string[] {
  return [
    "-cf", "-",
    ...sources.flatMap((s) => ["-C", s.cwd, s.path]),
  ];
}

interface TarStream {
  child: ReturnType<typeof spawn>;
  stdout: NonNullable<ReturnType<typeof spawn>["stdout"]>;
  done: Promise<void>;
}

function markPromiseHandled(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function spawnTarStream(sources: Array<{ cwd: string; path: string }>): TarStream {
  const child = spawn("tar", tarArgsForSources(sources), { stdio: ["ignore", "pipe", "pipe"] }); // eslint-disable-line sonarjs/no-os-command-from-path -- gateway image, PATH controlled
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    child.kill();
    throw new Error("tar spawned without stdout/stderr pipes");
  }

  let stderrBuf = "";
  stderr.on("data", (d) => {
    stderrBuf += d.toString();
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exit ${code}: ${stderrBuf.trim()}`));
    });
  });
  markPromiseHandled(done);
  return { child, stdout, done };
}

export function createQuiesceHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<QuiesceRequestBody>(req, res, deps.publicKey, log);
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

export function createFlushHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<FlushGatewayRequestBody>(req, res, deps.publicKey, log);
    if (!body) return;

    if (!deps.flushLocalState) {
      res.status(501).json({ error: "flush not configured" });
      return;
    }

    try {
      const result = await deps.flushLocalState({
        slug: body.slug,
        reason: typeof body.reason === "string" && body.reason ? body.reason : "controller",
      });
      const response: FlushGatewayResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        ...result,
      };
      log(
        `[migration-http] ✅ flush migrationId=${body.migrationId} slug=${body.slug} ok=${result.ok} durationMs=${result.durationMs}`,
      );
      res.status(result.ok ? 200 : 500).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] ❌ flush migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "flush failed", message });
    }
  };
}

function snapshotFromRestoreBody(body: RestoreMigrationRequestBody): UserSnapshot | null {
  const snapshot: unknown = body.snapshot;
  if (!isRecord(snapshot)) return null;
  if (snapshot.uid !== body.uid || snapshot.slug !== body.slug) return null;
  return {
    uid: snapshot.uid as string,
    slug: snapshot.slug as string,
    tier: snapshot.tier as string,
    gatewayId: snapshot.gatewayId as string,
    status: snapshot.status as UserSnapshot["status"],
    agentIds: Array.isArray(snapshot.agentIds)
      ? snapshot.agentIds.filter((id): id is string => typeof id === "string")
      : [],
    repoUrl: typeof snapshot.repoUrl === "string" ? snapshot.repoUrl : "",
    mattermostUserId:
      typeof snapshot.mattermostUserId === "string" ? snapshot.mattermostUserId : null,
    greetingPosted: snapshot.greetingPosted === true,
    channels: Array.isArray(snapshot.channels) ? snapshot.channels as UserSnapshot["channels"] : [],
    ownerName: typeof snapshot.ownerName === "string" ? snapshot.ownerName : body.slug,
    projects: Array.isArray(snapshot.projects) ? snapshot.projects as UserSnapshot["projects"] : [],
    byotActive: snapshot.byotActive === true,
    systemConfig: isRecord(snapshot.systemConfig)
      ? (snapshot.systemConfig as UserSnapshot["systemConfig"])
      : undefined,
  };
}

export function createRestoreHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<RestoreMigrationRequestBody>(
      req,
      res,
      deps.publicKey,
      log,
    );
    if (!body) return;
    if (typeof body.uid !== "string" || body.uid.length === 0) {
      res.status(400).json({ error: "missing uid" });
      return;
    }
    const snapshot = snapshotFromRestoreBody(body);
    if (!snapshot) {
      res.status(400).json({ error: "snapshot mismatch" });
      return;
    }

    try {
      deps.adapter.markCustomerMigratingIn?.(body.slug);
      deps.adapter.seedUserSnapshotForMigration?.(body.snapshot);
      const adapter: CustomerLifecycleAdapter = {
        ...deps.adapter,
        loadUserSnapshot: async (uid) => {
          const fresh = await deps.adapter.loadUserSnapshot(uid);
          return uid === snapshot.uid ? fresh ?? snapshot : fresh;
        },
        uidForSlug: async (slug) =>
          slug === snapshot.slug ? snapshot.uid : deps.adapter.uidForSlug(slug),
      };
      const result = await restoreCustomerRuntimeFromSnapshot(adapter, snapshot);
      const response: RestoreMigrationResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        restored: result.restored,
        steps: result.steps,
      };
      log(
        `[migration-http] ✅ restore migrationId=${body.migrationId} slug=${body.slug} steps=${result.steps.join(",")}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] ❌ restore migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "restore failed", message });
    }
  };
}

export function createExportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<MigrationRequestBody>(req, res, deps.publicKey, log);
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

      const tar = spawnTarStream(sources);
      tar.done
        .then(() => {
          log(`[migration-http] ✅ export migrationId=${body.migrationId} slug=${body.slug} done`);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log(
            `[migration-http] ❌ export migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
          );
          if (!res.headersSent) {
            res.status(500).json({ error: "tar failed", message });
            return;
          }
          res.destroy(err instanceof Error ? err : new Error(message));
        });

      res.status(200);
      res.setHeader("Content-Type", "application/x-tar");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${body.slug}.tar"`,
      );
      tar.stdout.pipe(res);
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

export function createExportPathsHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<ExportPathsRequestBody>(
      req,
      res,
      deps.publicKey,
      log,
    );
    if (!body) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;

    try {
      const allSources = await deps.adapter.listExportPaths(body.slug);
      const sources = sourcesForPushMode(allSources, body.slug, mode);
      if (sources.length === 0) {
        res.status(404).json({
          error: "no export paths",
          message: `nothing to export for slug=${body.slug} mode=${mode}`,
        });
        return;
      }
      const response: ExportPathsResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        sources,
      };
      log(
        `[migration-http] export-paths mode=${mode} migrationId=${body.migrationId} slug=${body.slug} paths=${sources.length}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] ❌ export-paths migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
      );
      res.status(500).json({ error: "export-paths failed", message });
    }
  };
}

export function createActivationManifestExportHandler(
  deps: MigrationHandlerDeps,
): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<ActivationManifestExportRequestBody>(
      req,
      res,
      deps.publicKey,
      log,
    );
    if (!body) return;

    try {
      if (!deps.adapter.exportOpenClawActivationManifest) {
        throw new Error("source gateway cannot export an OpenClaw activation manifest");
      }
      const manifest = await deps.adapter.exportOpenClawActivationManifest(body.slug);
      const response: ActivationManifestExportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        manifest: manifest as unknown as Record<string, unknown>,
      };
      log(
        `[migration-http] activation-manifest migrationId=${body.migrationId} slug=${body.slug} exported`,
      );
      res.status(200).json(response);
    } catch (err) {
      if (deps.adapter.isOperatorGateway?.() === true) {
        const response: ActivationManifestExportResponse = {
          migrationId: body.migrationId,
          slug: body.slug,
          manifest: null,
        };
        const message = err instanceof Error ? err.message : String(err);
        log(
          `[migration-http] activation-manifest migrationId=${body.migrationId} slug=${body.slug} unavailable on operator source: ${message}`,
        );
        res.status(200).json(response);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] ❌ activation-manifest migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
      );
      res.status(500).json({ error: "activation-manifest failed", message });
    }
  };
}

export function createPrepareImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<PrepareImportRequestBody>(
      req,
      res,
      deps.publicKey,
      log,
    );
    if (!body) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;

    try {
      const importDir = mode === "keys"
        ? await deps.adapter.prepareKeyImportDir(body.slug)
        : await deps.adapter.prepareImportDir(body.slug);
      if (mode !== "keys") deps.adapter.markCustomerMigratingIn?.(body.slug);
      log(
        `[migration-http] prepare-import mode=${mode} migrationId=${body.migrationId} slug=${body.slug} dir=${importDir}`,
      );
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
      };
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] ❌ prepare-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
      );
      res.status(500).json({ error: "prepare-import failed", message });
    }
  };
}

export function createActivateImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<ActivateImportRequestBody>(
      req,
      res,
      deps.publicKey,
      log,
    );
    if (!body) return;

    try {
      deps.adapter.markCustomerMigratingIn?.(body.slug);
      await deps.adapter.activateImportedCustomer(body.slug);
      deps.adapter.writeMountMarker?.(body.slug);
      deps.adapter.onMounted?.(body.slug);
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
      };
      log(
        `[migration-http] ✅ activate-import migrationId=${body.migrationId} slug=${body.slug}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] ❌ activate-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
      );
      res.status(500).json({ error: "activate-import failed", message });
    }
  };
}

function isValidGatewayRouteId(gatewayId: string): boolean {
  if (gatewayId.length === 0 || gatewayId.length > 128) return false;
  for (let i = 0; i < gatewayId.length; i++) {
    const code = gatewayId.charCodeAt(i);
    const alpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    const routePunctuation = code === 45 || code === 46 || code === 95;
    if (!(alpha || digit || (i > 0 && routePunctuation))) return false;
  }
  return true;
}

function resolveTargetImportUrl(targetUrl: string, targetGatewayId: string): string {
  const url = new URL(targetUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`targetUrl must use http or https`);
  }
  let basePath = url.pathname;
  while (basePath.endsWith("/")) {
    basePath = basePath.slice(0, -1);
  }
  url.pathname = `${basePath}/import/${encodeURIComponent(targetGatewayId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function validatePushStateBody(
  body: PushStateRequestBody,
  res: Response,
): { targetGatewayId: string; importUrl: string; targetImportSignature: string } | null {
  if (typeof body.targetGatewayId !== "string" || body.targetGatewayId.length === 0) {
    res.status(400).json({ error: "missing targetGatewayId" });
    return null;
  }
  if (!isValidGatewayRouteId(body.targetGatewayId)) {
    res.status(400).json({ error: "invalid targetGatewayId" });
    return null;
  }
  if (typeof body.targetUrl !== "string" || body.targetUrl.length === 0) {
    res.status(400).json({ error: "missing targetUrl" });
    return null;
  }
  if (typeof body.targetImportSignature !== "string" || body.targetImportSignature.length === 0) {
    res.status(400).json({ error: "missing targetImportSignature" });
    return null;
  }
  try {
    return {
      targetGatewayId: body.targetGatewayId,
      importUrl: resolveTargetImportUrl(body.targetUrl, body.targetGatewayId),
      targetImportSignature: body.targetImportSignature,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: "invalid targetUrl", message });
    return null;
  }
}

async function maybeMaterializeActivationManifest(
  deps: MigrationHandlerDeps,
  body: MigrationRequestBody & { includeActivationManifest?: boolean },
): Promise<{ source: { cwd: string; path: string } | null; cleanup: () => Promise<void> }> {
  if (body.includeActivationManifest !== true) {
    return { source: null, cleanup: async () => undefined };
  }
  if (!deps.adapter.exportOpenClawActivationManifest) {
    throw new Error("source gateway cannot export an OpenClaw activation manifest");
  }
  const manifest = await deps.adapter.exportOpenClawActivationManifest(body.slug);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-activation-${body.migrationId}-`));
  try {
    const source = await writeActivationManifest(tmpDir, manifest);
    return {
      source,
      cleanup: async () => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

function attachPushStateAbortHandlers(
  res: Response,
  params: { migrationId: string; slug: string; timeoutMs: number },
  log: (msg: string) => void,
): {
  controller: AbortController;
  didTimeout: () => boolean;
  detach: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`push-state timed out after ${params.timeoutMs}ms`));
  }, params.timeoutMs);
  const onResClose = () => {
    if (res.writableEnded || controller.signal.aborted) return;
    log(
      `[migration-http] controller closed push-state connection migrationId=${params.migrationId} slug=${params.slug} — aborting target import`,
    );
    controller.abort(new Error("controller disconnected mid-push-state"));
  };
  res.on("close", onResClose);
  return {
    controller,
    didTimeout: () => timedOut,
    detach: () => {
      clearTimeout(timeout);
      res.removeListener("close", onResClose);
    },
  };
}

function pushStateFailureStatus(
  didTimeout: boolean,
  signal: AbortSignal,
): { status: number; error: string } {
  if (didTimeout) return { status: 504, error: "push-state timed out" };
  if (signal.aborted) return { status: 499, error: "controller disconnected" };
  return { status: 500, error: "push-state failed" };
}

type MigrationImportMode = "keys" | "pre" | "final" | "default";

function parseMigrationImportMode(value: string | undefined): MigrationImportMode {
  if (value === "keys" || value === "pre" || value === "final") return value;
  return "default";
}

function sourcesForPushMode(
  sources: Array<{ cwd: string; path: string }>,
  slug: string,
  mode: PushStateRequestBody["mode"],
): Array<{ cwd: string; path: string }> {
  const keyPath = path.join("customer-keys", slug);
  if (mode === "keys") return sources.filter((source) => source.path === keyPath);
  if (mode === "pre" || mode === "final") {
    return sources.filter((source) => source.path !== keyPath);
  }
  return sources;
}

async function finishPushStateAlreadyMounted(
  res: Response,
  parsed: ImportResponse,
  targetGatewayId: string,
  log: (msg: string) => void,
): Promise<void> {
  log(
    `[migration-http] ✅ push-state migrationId=${parsed.migrationId} slug=${parsed.slug} target=${targetGatewayId} already mounted`,
  );
  res.status(200).json(parsed);
}

export async function sendPushStateImportResponse(
  importRes: globalThis.Response,
  params: { migrationId: string; slug: string; targetGatewayId: string },
  res: Response,
  log: (msg: string) => void,
): Promise<void> {
  if (!importRes.ok) {
    const text = await importRes.text().catch(() => "<no body>");
    log(
      `[migration-http] ❌ push-state migrationId=${params.migrationId} slug=${params.slug} target import failed status=${importRes.status}: ${text}`,
    );
    res
      .status(502)
      .json({ error: "target import failed", status: importRes.status, message: text });
    return;
  }

  const parsed = (await importRes.json()) as ImportResponse;
  if (parsed.alreadyMounted) {
    await finishPushStateAlreadyMounted(res, parsed, params.targetGatewayId, log);
    return;
  }

  log(
    `[migration-http] ✅ push-state migrationId=${params.migrationId} slug=${params.slug} target=${params.targetGatewayId} done`,
  );
  res.status(200).json(parsed);
}

const RSYNC_IMPORT_MODULE = "state";
const RSYNC_READY_TIMEOUT_MS = 5_000;
const RSYNC_BIN = "/usr/bin/rsync";

interface RSyncImportSession {
  key: string;
  migrationId: string;
  slug: string;
  mode: MigrationTransferMode;
  stageDir: string;
  importDir: string;
  configPath: string;
  secretsPath: string;
  child: ReturnType<typeof spawn>;
}

const rsyncImportSessions = new Map<string, RSyncImportSession>();

function rsyncSessionKey(
  migrationId: string,
  slug: string,
  mode: MigrationTransferMode,
): string {
  return `${migrationId}:${slug}:${mode}`;
}

function isMigrationTransferMode(value: unknown): value is MigrationTransferMode {
  return value === "keys" || value === "pre" || value === "final";
}

function validateTransferMode(
  mode: unknown,
  res: Response,
): MigrationTransferMode | null {
  if (isMigrationTransferMode(mode)) return mode;
  res.status(400).json({ error: "invalid migration mode" });
  return null;
}

function validateRsyncCredential(value: unknown, name: string, res: Response): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    res.status(400).json({ error: `invalid ${name}` });
    return null;
  }
  return value;
}

function validateRsyncTargetHost(value: unknown, res: Response): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 253 ||
    (!net.isIP(value) && !/^[A-Za-z0-9.-]+$/.test(value))
  ) {
    res.status(400).json({ error: "invalid targetHost" });
    return null;
  }
  return value;
}

function validateRsyncPort(value: unknown, res: Response): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    res.status(400).json({ error: "invalid targetPort" });
    return null;
  }
  return value;
}

function normalizeLocalAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  if (normalized === "0.0.0.0" || normalized === "::") return null;
  return net.isIP(normalized) ? normalized : null;
}

function requestLocalAddress(req: Request): string {
  const socket = (req as Request & {
    socket?: {
      localAddress?: string;
      address?: () => string | net.AddressInfo;
    };
  }).socket;
  const direct = normalizeLocalAddress(socket?.localAddress);
  if (direct) return direct;
  const address = socket?.address?.() as unknown;
  const fromAddress = typeof address === "object" && address && "address" in address
    ? normalizeLocalAddress(address.address)
    : normalizeLocalAddress(address);
  return fromAddress ?? "127.0.0.1";
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function posixRel(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) start += 1;
  return value.slice(start).split("\\").join("/");
}

function rsyncPortFromDeps(deps: MigrationHandlerDeps): number {
  if (deps.migrationRsyncPort) return deps.migrationRsyncPort;
  const fromEnv = Number.parseInt(process.env.MIGRATION_RSYNC_PORT ?? "", 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : MIGRATION_RSYNC_PORT_DEFAULT;
}

async function waitForTcpPort(port: number): Promise<void> {
  const deadline = Date.now() + RSYNC_READY_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
        socket.setTimeout(500, () => {
          socket.destroy(new Error(`rsync port ${port} connect timeout`));
        });
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`rsync port ${port} did not become ready`);
}

async function stopRsyncSession(session: RSyncImportSession | undefined): Promise<void> {
  if (!session) return;
  rsyncImportSessions.delete(session.key);
  session.child.kill("SIGTERM");
  await fs.rm(session.stageDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(path.dirname(session.configPath), { recursive: true, force: true }).catch(() => undefined);
}

async function stopConflictingRsyncSession(key: string, port: number): Promise<void> {
  for (const session of rsyncImportSessions.values()) {
    if (session.key === key) {
      await stopRsyncSession(session);
      continue;
    }
    throw new Error(
      `rsync import port ${port} is already serving migrationId=${session.migrationId} slug=${session.slug}`,
    );
  }
}

function rsyncSourceArg(source: { cwd: string; path: string }): string {
  return `${trimTrailingSlash(source.cwd)}/./${posixRel(source.path)}`;
}

async function runSpawnChecked(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; label: string },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      action();
    };
    if (opts.timeoutMs) {
      timeout = setTimeout(() => {
        stderr += `\n${opts.label} timed out after ${opts.timeoutMs}ms`;
        child.kill("SIGTERM");
        settle(() =>
          reject(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`)),
        );
      }, opts.timeoutMs);
    }
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code, signal) => {
      if (signal != null) {
        settle(() => reject(new Error(`${opts.label} terminated by ${signal}: ${stderr.trim()}`)));
        return;
      }
      if (code === 0) {
        settle(() => resolve());
        return;
      }
      settle(() =>
        reject(new Error(`${opts.label} failed (code=${code ?? 1}): ${stderr.trim() || stdout.trim()}`)),
      );
    });
  });
}

async function writeRsyncDaemonConfig(params: {
  dir: string;
  stageDir: string;
  transferUser: string;
  transferKey: string;
  sourcePodIp?: string;
}): Promise<{ configPath: string; secretsPath: string }> {
  const secretsPath = path.join(params.dir, "rsyncd.secrets");
  await fs.writeFile(secretsPath, `${params.transferUser}:${params.transferKey}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  const hostsAllow = params.sourcePodIp
    ? [`  hosts allow = ${params.sourcePodIp}`]
    : [];
  const configPath = path.join(params.dir, "rsyncd.conf");
  const pidPath = path.join(params.dir, "rsyncd.pid");
  const lockPath = path.join(params.dir, "rsyncd.lock");
  await fs.writeFile(
    configPath,
    [
      "use chroot = no",
      "max connections = 1",
      "log file = /dev/stdout",
      `pid file = ${pidPath}`,
      `lock file = ${lockPath}`,
      `[${RSYNC_IMPORT_MODULE}]`,
      `  path = ${params.stageDir}`,
      "  read only = false",
      "  write only = true",
      "  list = false",
      `  auth users = ${params.transferUser}`,
      `  secrets file = ${secretsPath}`,
      ...hostsAllow,
      "",
    ].join("\n"),
    "utf-8",
  );
  return { configPath, secretsPath };
}

async function listRelativeEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(absDir: string, relDir: string): Promise<void> {
    const dirents = await fs.readdir(absDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = relDir ? path.posix.join(relDir, dirent.name) : dirent.name;
      entries.push(dirent.isDirectory() ? `${rel}/` : rel);
      if (dirent.isDirectory()) {
        await walk(path.join(absDir, dirent.name), rel);
      }
    }
  }
  await walk(root, "");
  return entries;
}

async function copyStageToOpenClaw(stageDir: string, importDir: string): Promise<void> {
  await runSpawnChecked(
    RSYNC_BIN,
    ["-a", `${trimTrailingSlash(stageDir)}/`, `${trimTrailingSlash(importDir)}/`],
    { label: "rsync import copy", timeoutMs: MIGRATION_TRANSFER_TIMEOUT_MS },
  );
}

export function createPrepareRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<PrepareRsyncImportRequestBody>(
      req,
      res,
      deps.publicKey,
      log,
    );
    if (!body) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;
    const transferUser = validateRsyncCredential(body.transferUser, "transferUser", res);
    if (!transferUser) return;
    const transferKey = validateRsyncCredential(body.transferKey, "transferKey", res);
    if (!transferKey) return;
    if (body.sourcePodIp !== undefined && !net.isIP(body.sourcePodIp)) {
      res.status(400).json({ error: "invalid sourcePodIp" });
      return;
    }

    const port = rsyncPortFromDeps(deps);
    const key = rsyncSessionKey(body.migrationId, body.slug, mode);
    try {
      await stopConflictingRsyncSession(key, port);
      const importDir = mode === "keys"
        ? await deps.adapter.prepareKeyImportDir(body.slug)
        : await deps.adapter.prepareImportDir(body.slug);
      if (mode !== "keys") deps.adapter.markCustomerMigratingIn?.(body.slug);
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-rsync-${body.migrationId}-`));
      const stageDir = path.join(tmpDir, "stage");
      await fs.mkdir(stageDir, { recursive: true });
      const { configPath, secretsPath } = await writeRsyncDaemonConfig({
        dir: tmpDir,
        stageDir,
        transferUser,
        transferKey,
        sourcePodIp: body.sourcePodIp,
      });
      const child = spawn(
        RSYNC_BIN,
        ["--daemon", "--no-detach", `--config=${configPath}`, `--port=${port}`],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      const session: RSyncImportSession = {
        key,
        migrationId: body.migrationId,
        slug: body.slug,
        mode,
        stageDir,
        importDir,
        configPath,
        secretsPath,
        child,
      };
      rsyncImportSessions.set(key, session);
      child.on("exit", () => {
        if (rsyncImportSessions.get(key) === session) rsyncImportSessions.delete(key);
      });
      child.on("error", (err) => {
        log(
          `[migration-rsync] ❌ rsync daemon error migrationId=${body.migrationId} slug=${body.slug}: ${err.message}`,
        );
      });
      await (deps.waitForRsyncReady ?? waitForTcpPort)(port);
      const response: PrepareRsyncImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
        host: requestLocalAddress(req),
        port,
        module: RSYNC_IMPORT_MODULE,
      };
      log(
        `[migration-rsync] prepare-import mode=${mode} migrationId=${body.migrationId} slug=${body.slug} port=${port}`,
      );
      res.status(200).json(response);
    } catch (err) {
      await stopRsyncSession(rsyncImportSessions.get(key)).catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-rsync] ❌ prepare-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
      );
      res.status(500).json({ error: "prepare-rsync-import failed", message });
    }
  };
}

export function createPushRsyncStateHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  const timeoutMs = deps.pushStateTimeoutMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<PushRsyncStateRequestBody>(
      req,
      res,
      deps.publicKey,
      log,
    );
    if (!body) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;
    const targetHost = validateRsyncTargetHost(body.targetHost, res);
    if (!targetHost) return;
    const targetPort = validateRsyncPort(body.targetPort, res);
    if (targetPort === null) return;
    const transferUser = validateRsyncCredential(body.transferUser, "transferUser", res);
    if (!transferUser) return;
    const transferKey = validateRsyncCredential(body.transferKey, "transferKey", res);
    if (!transferKey) return;

    let cleanupActivationManifest: () => Promise<void> = async () => {};
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-rsync-push-${body.migrationId}-`));
    try {
      const allSources = await deps.adapter.listExportPaths(body.slug);
      const sources = sourcesForPushMode(allSources, body.slug, mode);
      if (sources.length === 0) {
        res
          .status(404)
          .json({ error: "no export paths", message: `nothing to push for slug=${body.slug}` });
        return;
      }
      const activationManifest = mode === "keys"
        ? { source: null, cleanup: async () => {} }
        : await maybeMaterializeActivationManifest(deps, body);
      cleanupActivationManifest = activationManifest.cleanup;
      if (activationManifest.source) sources.push(activationManifest.source);

      const passwordFile = path.join(tmpDir, "rsync.pass");
      await fs.writeFile(passwordFile, `${transferKey}\n`, { encoding: "utf-8", mode: 0o600 });
      const destination = `rsync://${transferUser}@${targetHost}:${targetPort}/${RSYNC_IMPORT_MODULE}/`;
      log(
        `[migration-rsync] push-state mode=${mode} migrationId=${body.migrationId} slug=${body.slug} paths=${sources.length} target=${targetHost}:${targetPort}`,
      );
      await runSpawnChecked(
        RSYNC_BIN,
        [
          "-a",
          "--relative",
          "--ignore-missing-args",
          "--password-file",
          passwordFile,
          ...sources.map((source) => rsyncSourceArg(source)),
          destination,
        ],
        { timeoutMs, label: "rsync push-state" },
      );
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
      };
      log(
        `[migration-rsync] ✅ push-state migrationId=${body.migrationId} slug=${body.slug} target=${targetHost}:${targetPort} done`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-rsync] ❌ push-state migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "push-rsync-state failed", message });
    } finally {
      await cleanupActivationManifest();
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export function createFinishRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<FinishRsyncImportRequestBody>(
      req,
      res,
      deps.publicKey,
      log,
    );
    if (!body) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;
    const key = rsyncSessionKey(body.migrationId, body.slug, mode);
    const session = rsyncImportSessions.get(key);
    if (!session) {
      res.status(404).json({ error: "rsync import session not found" });
      return;
    }
    const { controller, detach } = attachImportDisconnectHandlers(
      res,
      body.migrationId,
      body.slug,
      log,
    );
    try {
      session.child.kill("SIGTERM");
      const entries = await listRelativeEntries(session.stageDir);
      const violation = findPathTraversalViolation(entries, body.slug, mode);
      if (violation !== null) {
        log(
          `[migration-rsync] ⚠ finish-import migrationId=${body.migrationId} slug=${body.slug} rejected: ${violation}`,
        );
        res.status(400).json({ error: "rsync import failed validation", message: violation });
        return;
      }
      await copyStageToOpenClaw(session.stageDir, session.importDir);
      if (mode !== "keys") {
        deps.adapter.markCustomerMigratingIn?.(body.slug);
        await deps.adapter.activateImportedCustomer(body.slug, { signal: controller.signal });
        deps.adapter.writeMountMarker?.(body.slug);
        deps.adapter.onMounted?.(body.slug);
      }
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
      };
      log(`[migration-rsync] ✅ finish-import migrationId=${body.migrationId} slug=${body.slug} done`);
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-rsync] ❌ finish-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      respondImportFailure(res, controller.signal, err);
    } finally {
      detach();
      await stopRsyncSession(session).catch(() => undefined);
    }
  };
}

export function createAbortRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<AbortRsyncImportRequestBody>(
      req,
      res,
      deps.publicKey,
      log,
    );
    if (!body) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;
    const key = rsyncSessionKey(body.migrationId, body.slug, mode);
    await stopRsyncSession(rsyncImportSessions.get(key)).catch(() => undefined);
    log(`[migration-rsync] abort-import migrationId=${body.migrationId} slug=${body.slug}`);
    res.status(200).json({ migrationId: body.migrationId, slug: body.slug, imported: false });
  };
}

export function createVerifyHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<VerifyMigrationRequestBody>(
      req,
      res,
      deps.publicKey,
      log,
    );
    if (!body) return;

    try {
      const customerDir = deps.adapter.hasCustomerDir(body.slug);
      const coachWired =
        deps.adapter.customerCoachWiredInOpenclawConfig?.(body.slug)
        ?? deps.getMountedCustomers?.().includes(body.slug)
        ?? false;
      const mountMarked = deps.adapter.customerMountMarked?.(body.slug) ?? coachWired;
      const accountHealthy = await deps.adapter.waitForAccountHealthy({
        slug: body.slug,
        timeoutMs: body.timeoutMs ?? MIGRATION_VERIFY_TIMEOUT_MS,
      });
      const checks = { customerDir, coachWired, mountMarked, accountHealthy };
      const ready = customerDir && coachWired && mountMarked && accountHealthy;
      const response: VerifyMigrationResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        ready,
        checks,
      };
      log(
        `[migration-http] verify migrationId=${body.migrationId} slug=${body.slug} ready=${ready} checks=${JSON.stringify(checks)}`,
      );
      res.status(ready ? 200 : 409).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] ❌ verify migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "verify failed", message });
    }
  };
}

export function createPushStateHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.pushStateTimeoutMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<PushStateRequestBody>(req, res, deps.publicKey, log);
    if (!body) return;
    const target = validatePushStateBody(body, res);
    if (!target) return;

    const abort = attachPushStateAbortHandlers(
      res,
      { migrationId: body.migrationId, slug: body.slug, timeoutMs },
      log,
    );

    let cleanupActivationManifest: () => Promise<void> = async () => {};
    let sourceTarError: unknown;
    try {
      const allSources = await deps.adapter.listExportPaths(body.slug);
      const sources = sourcesForPushMode(allSources, body.slug, body.mode);
      if (sources.length === 0) {
        res
          .status(404)
          .json({ error: "no export paths", message: `nothing to push for slug=${body.slug}` });
        return;
      }
      const activationManifest = body.mode === "keys"
        ? { source: null, cleanup: async () => {} }
        : await maybeMaterializeActivationManifest(deps, body);
      cleanupActivationManifest = activationManifest.cleanup;
      if (activationManifest.source) {
        sources.push(activationManifest.source);
      }
      log(
        `[migration-http] push-state mode=${body.mode ?? "default"} migrationId=${body.migrationId} slug=${body.slug} streaming ${sources.length} path(s) to ${target.targetGatewayId}`,
      );

      const tar = spawnTarStream(sources);
      const tarDone = tar.done.catch((err: unknown) => {
        sourceTarError = err;
        abort.controller.abort(err);
        throw err;
      });
      let importRes: globalThis.Response;
      try {
        importRes = await fetchImpl(
        target.importUrl,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-tar",
            [SIGNATURE_HEADER]: target.targetImportSignature,
            [MIGRATION_ID_HEADER]: body.migrationId,
            [MIGRATION_SLUG_HEADER]: body.slug,
            [MIGRATION_MODE_HEADER]: body.mode ?? "default",
          },
          body: tar.stdout,
          duplex: "half",
          signal: abort.controller.signal,
        } as unknown as RequestInit & { duplex: "half" },
        );
        await tarDone;
      } catch (err) {
        tar.child.kill();
        await tar.done.catch(() => undefined);
        throw sourceTarError ?? err;
      }

      await sendPushStateImportResponse(
        importRes,
        {
          migrationId: body.migrationId,
          slug: body.slug,
          targetGatewayId: target.targetGatewayId,
        },
        res,
        log,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] ❌ push-state migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      if (!res.headersSent) {
        const { status, error } = sourceTarError
          ? { status: 500, error: "source tar failed" }
          : pushStateFailureStatus(
              abort.didTimeout(),
              abort.controller.signal,
            );
        res.status(status).json({ error, message });
      } else {
        res.destroy(err instanceof Error ? err : new Error(message));
      }
    } finally {
      abort.detach();
      await cleanupActivationManifest();
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

function validateImportRequest(
  deps: MigrationHandlerDeps,
  req: Request,
  res: Response,
  log: (msg: string) => void,
): { migrationId: string; slug: string; mode: MigrationImportMode } | null {
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
  if (!verifyHeaderSignature(migrationId, slug, sigHeader, deps.publicKey)) {
    log(`[migration-http] ⚠ bad signature on import migrationId=${migrationId} slug=${slug}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  const mode = parseMigrationImportMode(req.header(MIGRATION_MODE_HEADER));
  return { migrationId, slug, mode };
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
    const { migrationId, slug, mode } = validated;

    const { controller, detach } = attachImportDisconnectHandlers(
      res,
      migrationId,
      slug,
      log,
    );

    let tmpDir: string | null = null;
    try {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("aborted");
      const importDir = mode === "keys"
        ? await deps.adapter.prepareKeyImportDir(slug)
        : await deps.adapter.prepareImportDir(slug);
      log(
        `[migration-http] import mode=${mode} migrationId=${migrationId} slug=${slug} unpacking → ${importDir}`,
      );

      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-${migrationId}-`));
      const tarPath = path.join(tmpDir, "import.tar");

      await streamRequestToFile(req, tarPath);

      const entries = await listTarEntries(tarPath);
      const violation = findPathTraversalViolation(entries, slug, mode);
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

      if (mode === "keys") {
        const response: ImportResponse = { migrationId, slug, imported: true };
        log(`[migration-http] ✅ import mode=keys migrationId=${migrationId} slug=${slug} done`);
        res.status(200).json(response);
        return;
      }

      // Pin BEFORE activation: activation coach-wires the customer here, but cutover hasn't
      // yet made it desired-on-this-gateway. The pin keeps the reconcile evict direction
      // from draining the fresh import during that window. Self-expiring (see the pin's TTL).
      deps.adapter.markCustomerMigratingIn?.(slug);
      await deps.adapter.activateImportedCustomer(slug, { signal: controller.signal });
      deps.adapter.writeMountMarker?.(slug);
      deps.adapter.onMounted?.(slug);

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
  mode: MigrationImportMode = "default",
): string | null {
  const durablePrefixes = [
    `agents/octogee-${slug}-coach/`,
    `memory/octogee-${slug}-coach.sqlite`,
    `customers/${slug}/`,
    `${MIGRATION_ACTIVATION_DIR}/${slug}/`,
  ];
  let allowedPrefixes = [...durablePrefixes, `customer-keys/${slug}/`];
  if (mode === "keys") allowedPrefixes = [`customer-keys/${slug}/`];
  if (mode === "pre" || mode === "final") allowedPrefixes = durablePrefixes;
  for (const raw of entries) {
    const entry = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (entry.startsWith("/")) {
      return `absolute path in tarball: ${raw}`;
    }

    if (entry.split("/").includes("..")) {
      return `path traversal '..' in tarball: ${raw}`;
    }
    const allowed = allowedPrefixes.some((p) => matchesAllowedMigrationPath(raw, entry, p));
    if (!allowed) {
      const allowlist = allowedPrefixes.map((prefix) => prefix.replace(/\/$/u, "")).join(", ");
      return `path '${raw}' is outside the per-slug allowlist (${allowlist})`;
    }
  }
  return null;
}

function matchesAllowedMigrationPath(raw: string, entry: string, allowedPrefix: string): boolean {
  const isDirectoryPrefix = allowedPrefix.endsWith("/");
  const exactPrefix = isDirectoryPrefix ? allowedPrefix.slice(0, -1) : allowedPrefix;
  return (
    entry === exactPrefix ||
    entry.startsWith(allowedPrefix) ||
    (raw.endsWith("/") && exactPrefix.startsWith(`${entry}/`))
  );
}

export function createUnmountHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<UnmountRequestBody>(req, res, deps.publicKey, log);
    if (!body) return;

    try {
      if (deps.adapter.removeImportedCustomerBySlug) {
        const result = await deps.adapter.removeImportedCustomerBySlug(body.slug);
        if (result.wasMounted) deps.adapter.onUnmounted?.(body.slug);
        const response: UnmountResponse = {
          migrationId: body.migrationId,
          slug: body.slug,
          unmounted: result.wasMounted,
        };
        log(
          `[migration-http] ✅ unmount migrationId=${body.migrationId} slug=${body.slug} wasMounted=${result.wasMounted} steps=${result.steps.join(",")}`,
        );
        res.status(200).json(response);
        return;
      }

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
  sessions: AgentSessionEntry[];
}

export interface AgentSessionEntry {
  sessionId?: string;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
}

function isAgentSessionEntry(value: unknown): value is AgentSessionEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readAgentSessions(
  stateDir: string,
  agentId: string,
): Promise<SessionsJson["sessions"]> {
  const sessionsPath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
  try {
    const raw = await fs.readFile(sessionsPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const sessions = (parsed as Partial<SessionsJson>).sessions;
    if (Array.isArray(sessions)) return sessions.filter(isAgentSessionEntry);
    return Object.values(parsed).filter(isAgentSessionEntry);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
}
