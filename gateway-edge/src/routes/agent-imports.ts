import Busboy from "busboy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";

import { isValidGatewayId } from "@octogee/shared/types/glm";
import type { AgentImportConfigArtifacts } from "@octogee/shared/types/agent-import";
import type { ResolvedGateway } from "../lib/user-gateway.js";
import type { AgentImportService } from "../lib/agent-import-service.js";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const IMPORT_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;

interface AgentImportsRouterDeps {
  service: Pick<AgentImportService, "previewGithub" | "previewLocal" | "apply" | "get" | "rollback">;
  localGatewayId(): string | null;
  resolveUserGateway(uid: string): Promise<ResolvedGateway | null>;
  isProvisioned(uid: string): Promise<boolean>;
  listGithubSources(uid: string): Promise<unknown>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const IMPORT_ERROR_STATUS: Record<string, number> = {
  github_not_connected: 422,
  invalid_import_source: 400,
  invalid_local_archive: 400,
  invalid_archive: 400,
  invalid_archive_metadata: 400,
  unsafe_archive_entry: 422,
  unsafe_git_entry: 422,
  invalid_git_history: 422,
  archive_too_large: 413,
  secret_findings: 422,
  secret_scan_failed: 503,
  push_outcome_unknown: 503,
  destination_dirty: 409,
  destination_changed: 409,
  source_changed: 409,
  approval_mismatch: 409,
  invalid_import_state: 409,
  rollback_window_closed: 409,
  import_plan_missing: 410,
  local_archive_missing: 410,
  import_not_found: 404,
  forbidden: 404,
};

function handleImportError(error: unknown, res: Response, next: NextFunction): void {
  const data = object(error);
  const code = typeof data?.code === "string" ? data.code : null;
  const status = code ? IMPORT_ERROR_STATUS[code] : undefined;
  if (!code || !status) {
    next(error);
    return;
  }
  res.status(status).json({
    error: code,
    message: error instanceof Error ? error.message : "Agent import failed",
  });
}

function requestedGatewayId(req: Request): string | null {
  const value = (req.params as { gatewayId?: unknown }).gatewayId;
  return isValidGatewayId(value) ? value : null;
}

async function authorize(
  req: Request,
  res: Response,
  deps: AgentImportsRouterDeps,
): Promise<ResolvedGateway | null> {
  const requested = requestedGatewayId(req);
  if (!requested || deps.localGatewayId() !== requested) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const resolved = await deps.resolveUserGateway(req.uid!);
  if (!resolved || resolved.gatewayId !== requested) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (!await deps.isProvisioned(req.uid!)) {
    res.status(409).json({ error: "openclaw_not_ready" });
    return null;
  }
  return resolved;
}

function importId(req: Request, res: Response): string | null {
  const id = (req.params as { importId?: unknown }).importId;
  if (typeof id !== "string" || !IMPORT_ID_RE.test(id)) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return id;
}

interface StagedLocalArchive {
  path: string;
  cleanup(): void;
}

function localArchive(req: Request): Promise<StagedLocalArchive> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-agent-import-upload-"));
  fs.chmodSync(root, 0o700);
  const archivePath = path.join(root, "source.zip");
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      fs.rmSync(root, { recursive: true, force: true });
      reject(error);
    };
    let parser: Busboy.Busboy;
    try {
      parser = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_ARCHIVE_BYTES, fields: 0 } });
    } catch {
      fail(Object.assign(new Error("invalid multipart archive"), { code: "invalid_local_archive" }));
      return;
    }
    let fileCount = 0;
    let limitExceeded = false;
    let truncated = false;
    let wroteArchive = false;
    let writeComplete: Promise<void> = Promise.resolve();
    parser.on("file", (field, stream, info) => {
      fileCount += 1;
      if (field !== "archive" || info.mimeType !== "application/zip") {
        stream.resume();
        return;
      }
      wroteArchive = true;
      const output = fs.createWriteStream(archivePath, { flags: "wx", mode: 0o600 });
      writeComplete = new Promise((complete, failed) => {
        output.on("finish", complete);
        output.on("error", failed);
        stream.on("error", failed);
      });
      stream.on("limit", () => { truncated = true; });
      stream.pipe(output);
    });
    parser.on("filesLimit", () => { limitExceeded = true; });
    parser.on("fieldsLimit", () => { limitExceeded = true; });
    parser.on("error", fail);
    req.on("aborted", () => fail(Object.assign(new Error("archive upload aborted"), { code: "invalid_local_archive" })));
    parser.on("finish", async () => {
      try {
        await writeComplete;
        const size = wroteArchive && fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0;
        if (fileCount !== 1 || limitExceeded || truncated || size === 0) {
          fail(Object.assign(new Error("exactly one ZIP archive under 32 MiB is required"), { code: "invalid_local_archive" }));
          return;
        }
        if (settled) return;
        settled = true;
        resolve({
          path: archivePath,
          cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
        });
      } catch (error) {
        fail(error);
      }
    });
    req.pipe(parser);
  });
}

export function createAgentImportsRouter(deps: AgentImportsRouterDeps): Router {
  const router = Router({ mergeParams: true });
  let localImportActive = false;

  router.get("/sources/github", async (req, res, next) => {
    try {
      if (!await authorize(req, res, deps)) return;
      res.json(await deps.listGithubSources(req.uid!));
    } catch (error) {
      handleImportError(error, res, next);
    }
  });

  router.post("/preview/github", async (req, res, next) => {
    try {
      const resolved = await authorize(req, res, deps);
      if (!resolved) return;
      const body = object(req.body);
      if (
        !body || typeof body.owner !== "string" || typeof body.repo !== "string" ||
        typeof body.branch !== "string" || !object(body.artifacts)
      ) {
        res.status(400).json({ error: "invalid_import_source" });
        return;
      }
      const preview = await deps.service.previewGithub({
        uid: req.uid!,
        slug: resolved.slug,
        gatewayId: resolved.gatewayId,
        owner: body.owner,
        repo: body.repo,
        branch: body.branch,
        artifacts: body.artifacts as unknown as AgentImportConfigArtifacts,
      });
      res.status(201).json(preview);
    } catch (error) {
      handleImportError(error, res, next);
    }
  });

  router.post("/preview/local", async (req, res, next) => {
    let archive: StagedLocalArchive | null = null;
    let acquired = false;
    try {
      const resolved = await authorize(req, res, deps);
      if (!resolved) return;
      if (localImportActive) {
        req.resume();
        res.status(429).json({ error: "local_import_busy" });
        return;
      }
      localImportActive = true;
      acquired = true;
      archive = await localArchive(req);
      const preview = await deps.service.previewLocal({
        uid: req.uid!,
        slug: resolved.slug,
        gatewayId: resolved.gatewayId,
        archive: fs.readFileSync(archive.path),
      });
      res.status(201).json(preview);
    } catch (error) {
      handleImportError(error, res, next);
    } finally {
      archive?.cleanup();
      if (acquired) localImportActive = false;
    }
  });

  router.post("/:importId/apply", async (req, res, next) => {
    try {
      if (!await authorize(req, res, deps)) return;
      const id = importId(req, res);
      const body = object(req.body);
      if (!id) return;
      if (!body || typeof body.approvalHash !== "string") {
        res.status(400).json({ error: "approval_hash_required" });
        return;
      }
      res.json(await deps.service.apply({ importId: id, uid: req.uid!, approvalHash: body.approvalHash }));
    } catch (error) {
      handleImportError(error, res, next);
    }
  });

  router.get("/:importId", async (req, res, next) => {
    try {
      if (!await authorize(req, res, deps)) return;
      const id = importId(req, res);
      if (!id) return;
      res.json(await deps.service.get({ importId: id, uid: req.uid! }));
    } catch (error) {
      handleImportError(error, res, next);
    }
  });

  router.post("/:importId/rollback", async (req, res, next) => {
    try {
      if (!await authorize(req, res, deps)) return;
      const id = importId(req, res);
      if (!id) return;
      res.json(await deps.service.rollback({ importId: id, uid: req.uid! }));
    } catch (error) {
      handleImportError(error, res, next);
    }
  });

  return router;
}
