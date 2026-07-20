import { Router, type NextFunction, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";

import { slugFromAssignedUser } from "@octogee/core/assigned-roster";
import { classifyAgentImportArchivePath } from "@octogee/shared/types/agent-import";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { isValidUsername } from "@octogee/shared/types/identity";
import type { AgentImportManifestEntry } from "../../../gateway-edge/src/lib/agent-import-git.js";
import type { AgentImportIdentity } from "../../../gateway-edge/src/lib/agent-import-service.js";

const IMPORT_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const GITHUB_OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_BLOB_BYTES = 100 * 1024 * 1024;

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;
type JsonObject = Record<string, unknown>;

interface BucketLike {
  file(path: string): {
    save(value: Buffer | string, options?: unknown): Promise<unknown>;
    download(): Promise<[Buffer]>;
  };
  deleteFiles(options: { prefix: string }): Promise<unknown>;
}

export interface AgentImportBrokerDeps {
  db: Firestore;
  bucket: BucketLike;
  readGithubToken(uid: string): Promise<string | null>;
  listGithubRepos(token: string): Promise<unknown>;
  readGithubRepoSize(owner: string, repo: string, token: string): Promise<number>;
  readIdentity(uid: string): Promise<AgentImportIdentity>;
  syncIdentity(uid: string, identity: AgentImportIdentity): Promise<void>;
  now(): Date;
}

interface OwnerContext {
  uid: string;
  slug: string;
  gatewayId: string;
}

type BrokerRouter = ReturnType<typeof Router>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function safeUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("/");
}

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return bound;
}

async function ownerContext(
  req: Request,
  res: Response,
  deps: AgentImportBrokerDeps,
): Promise<OwnerContext | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const uid = authenticatedUid(req, res, bound);
  if (!uid) return null;
  const userSnapshot = await deps.db.doc(`users/${uid}`).get();
  const user = userSnapshot.exists ? userSnapshot.data() : undefined;
  const slug = slugFromAssignedUser(user);
  const provisioning = object(object(user)?.provisioning);
  const openclaw = object(provisioning?.openclaw);
  if (!slug || !isValidUsername(slug) || openclaw?.gatewayId !== bound.gatewayId) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (openclaw.status !== "complete") {
    res.status(409).json({ error: "openclaw_not_ready" });
    return null;
  }
  const workspace = await deps.db.doc(`workspaces/${slug}`).get();
  if (!workspace.exists || workspace.data()?.ownerUid !== uid) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return { uid, slug, gatewayId: bound.gatewayId };
}

function authenticatedUid(req: Request, res: Response, bound: GatewayBinding): string | null {
  if (!safeUid(req.uid)) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  if (bound.ownerUid && bound.ownerUid !== req.uid) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return req.uid;
}

function importId(req: Request, res: Response): string | null {
  const value = req.params.importId;
  if (typeof value !== "string" || !IMPORT_ID_RE.test(value)) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return value;
}

function ownedPayload(value: unknown, context: OwnerContext): JsonObject | null {
  const payload = object(value);
  return payload?.uid === context.uid && payload.slug === context.slug && payload.gatewayId === context.gatewayId
    ? payload
    : null;
}

function missingObject(error: unknown): boolean {
  const code = object(error)?.code;
  return code === 404 || code === "404";
}

function stagingPath(id: string, name: string): string {
  return `agent-imports/${id}/${name}`;
}

async function readRequestBody(req: Request, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw Object.assign(new Error("request body exceeds the import limit"), {
        status: 413,
        code: "archive_too_large",
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function identity(value: unknown): AgentImportIdentity | null {
  const input = object(value);
  if (!input || Object.keys(input).some((key) => !["name", "persona", "emoji"].includes(key))) return null;
  if (Object.values(input).some((entry) => entry !== undefined && typeof entry !== "string")) return null;
  return input as AgentImportIdentity;
}

async function githubToken(context: OwnerContext, deps: AgentImportBrokerDeps): Promise<string> {
  const token = await deps.readGithubToken(context.uid);
  if (!token) throw Object.assign(new Error("GitHub not connected"), { status: 422, code: "github_not_connected" });
  return token;
}

function context(res: Response): OwnerContext {
  return res.locals.agentImportOwner as OwnerContext;
}

function registerAccessRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.post("/authorize", (req, res) => {
    const owner = context(res);
    const body = object(req.body);
    if (!body || Object.keys(body).length !== 1 || !isValidGatewayId(body.gatewayId) || body.gatewayId !== owner.gatewayId) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json({ slug: owner.slug, gatewayId: owner.gatewayId });
  });

  router.get("/github/sources", async (_req, res, next) => {
    try {
      const owner = context(res);
      res.json(await deps.listGithubRepos(await githubToken(owner, deps)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/github/token", async (_req, res, next) => {
    try {
      res.json({ token: await githubToken(context(res), deps) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/github/repos/:owner/:repo/size", async (req, res, next) => {
    try {
      const owner = context(res);
      if (!GITHUB_OWNER_RE.test(req.params.owner) || !GITHUB_REPO_RE.test(req.params.repo)) {
        res.status(400).json({ error: "invalid_github_source" });
        return;
      }
      res.json({ sizeKiB: await deps.readGithubRepoSize(req.params.owner, req.params.repo, await githubToken(owner, deps)) });
    } catch (error) {
      next(error);
    }
  });
}

function registerRecordRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.put("/records/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const payload = ownedPayload(req.body, context(res));
      if (!payload || payload.id !== id || typeof payload.status !== "string") {
        res.status(400).json({ error: "invalid_import_record" });
        return;
      }
      await deps.db.doc(`agentImports/${id}`).set(payload);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/records/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const snapshot = await deps.db.doc(`agentImports/${id}`).get();
      const payload = snapshot.exists ? ownedPayload(snapshot.data(), context(res)) : null;
      if (!payload || payload.id !== id) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });
}

function registerPlanRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.put("/plans/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const payload = ownedPayload(req.body, context(res));
      if (!payload || typeof payload.approvalHash !== "string") {
        res.status(400).json({ error: "invalid_import_plan" });
        return;
      }
      await deps.bucket.file(stagingPath(id, "plan.json")).save(JSON.stringify(payload), {
        contentType: "application/json",
        resumable: false,
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/plans/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      let payload: JsonObject | null;
      try {
        const [contents] = await deps.bucket.file(stagingPath(id, "plan.json")).download();
        payload = ownedPayload(JSON.parse(contents.toString("utf8")), context(res));
      } catch (error) {
        if (missingObject(error)) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        throw error;
      }
      if (!payload || typeof payload.approvalHash !== "string") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });
}

function registerArchiveRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.put("/archives/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      if (!req.is("application/zip")) {
        req.resume();
        res.status(415).json({ error: "invalid_archive" });
        return;
      }
      const archive = await readRequestBody(req, MAX_ARCHIVE_BYTES);
      if (archive.length === 0) {
        res.status(400).json({ error: "invalid_archive" });
        return;
      }
      await deps.bucket.file(stagingPath(id, "source.zip")).save(archive, {
        contentType: "application/zip",
        resumable: true,
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/archives/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      try {
        const [archive] = await deps.bucket.file(stagingPath(id, "source.zip")).download();
        res.type("application/zip").send(archive);
      } catch (error) {
        if (missingObject(error)) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  router.delete("/staging/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      await deps.bucket.deleteFiles({ prefix: stagingPath(id, "") });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}

function registerBlobRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.put("/blobs/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      const filePath = typeof req.query.path === "string" ? req.query.path : "";
      const mimeType = req.get("x-agent-import-mime") ?? "";
      if (classifyAgentImportArchivePath(`workspace/${filePath}`) !== "workspace" || !mimeType || mimeType.length > 200) {
        req.resume();
        res.status(400).json({ error: "invalid_import_blob" });
        return;
      }
      const contents = await readRequestBody(req, MAX_BLOB_BYTES);
      const objectPath = `customers/${context(res).slug}/agent-imports/${id}/${filePath}`;
      await deps.bucket.file(objectPath).save(contents, { metadata: { contentType: mimeType } });
      const manifest: AgentImportManifestEntry = {
        type: "blob",
        gcsPath: objectPath,
        size: contents.length,
        mimeType,
        uploadedAt: deps.now().toISOString(),
      };
      res.status(201).json(manifest);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/blobs/:importId", async (req, res, next) => {
    try {
      const id = importId(req, res);
      if (!id) return;
      await deps.bucket.deleteFiles({ prefix: `customers/${context(res).slug}/agent-imports/${id}/` });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}

function registerIdentityRoutes(router: BrokerRouter, deps: AgentImportBrokerDeps): void {
  router.get("/identity", async (_req, res, next) => {
    try {
      res.json(await deps.readIdentity(context(res).uid));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/identity", async (req, res, next) => {
    try {
      const value = identity(req.body);
      if (!value) {
        res.status(400).json({ error: "invalid_identity" });
        return;
      }
      await deps.syncIdentity(context(res).uid, value);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}

function agentImportBrokerError(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  const data = object(error);
  if (typeof data?.status !== "number" || typeof data.code !== "string") {
    next(error);
    return;
  }
  res.status(data.status).json({
    error: data.code,
    message: error instanceof Error ? error.message : "Agent import broker failed",
  });
}

export function createAgentImportBrokerRoutes(deps: AgentImportBrokerDeps): Router {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      const owner = await ownerContext(req, res, deps);
      if (!owner) return;
      res.locals.agentImportOwner = owner;
      next();
    } catch (error) {
      next(error);
    }
  });

  registerAccessRoutes(router, deps);
  registerRecordRoutes(router, deps);
  registerPlanRoutes(router, deps);
  registerArchiveRoutes(router, deps);
  registerBlobRoutes(router, deps);
  registerIdentityRoutes(router, deps);
  router.use(agentImportBrokerError);

  return router;
}
