import { Router, type Request, type Response } from "express";

import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";
import {
  defaultProjectRecipe,
  isProjectRecipeId,
  PROJECT_RECIPE_IDS,
  type ProjectRecipeId,
} from "@octogee/shared/types/project";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  hasRunningInboundMigrationForSlug,
  readAssignedSlugsForGateway,
} from "@octogee/core/assigned-roster";
import {
  configuredBuilderBootstrapAllowed,
} from "@octogee/core/gateway-live-release";
import { db } from "../../lib/db.js";
import { requireInternalServiceAuth } from "../../middleware/auth.js";
import { logger } from "../../middleware/logging.js";
import {
  archiveRepo,
  deleteGiteaUserPubKey,
  ensureGiteaOrgForWorkspace,
  ensureGiteaUser,
  ensureProjectRepo,
  ensureSystemConfigRepo,
  ensureWorkspaceRepo,
  readGiteaUserPubKey,
  readGiteaUserPubKeys,
  repoExists,
} from "../../lib/gitea-admin.js";
import {
  systemConfigRepoName,
  workspaceRepoName,
} from "../../lib/gitea-naming.js";
import {
  deleteProjectGiteaRepo,
  ensureProjectGiteaRepo,
  ProjectRepoProvisioningError,
} from "../projects/provisioning.js";

// Gitea ADMIN broker for the in-pod provisioner. The provisioner runs in the shell-bearing
// openclaw container and no longer holds the admin token; it calls octogee-api with its
// projected gateway KSA token so the API singleton performs the admin operation. Local git
// (SSH clone/init/push) stays in the provisioner. The legacy gateway-edge mount stays
// fail-closed unless a trusted caller presents a supported internal identity.
//
// Every path-bound input is re-validated HERE because this HTTP boundary is a new entry
// point that bypasses the provisioner's upstream isValidUsername gate. Strict validation blocks
// path traversal / injection into the privileged Gitea paths. The assigned-roster guard below is
// defense-in-depth over octogee-api tenant enforcement: it blocks cross-tenant Gitea key
// replacement / repo mutation before any admin call is attempted.

const router = Router();
router.use(requireInternalServiceAuth);

// Our Gitea repo names are fixed platform repos or project slugs. Keep the
// system_config underscore as an exact-name exception instead of relaxing
// arbitrary repo input.
function isSshPublicKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 8192 &&
    /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp\d+) /.test(value.trim())
  );
}

// Validates the slug at the boundary and 400s on failure; narrows to string on success.
function validSlug(res: Response, slug: unknown): slug is string {
  if (isValidUsername(slug)) return true;
  res.status(400).json({ error: "slug must be a valid workspace username" });
  return false;
}

function validRepoName(value: unknown): value is string {
  return (
    value === workspaceRepoName() ||
    value === systemConfigRepoName() ||
    isValidProjectId(value)
  );
}

// recipe is optional on the wire because octogee-api and the pod sidecar ship
// separately: a sender from before the field still provisions, on the same
// type-derived recipe project create would have stamped.
interface ProjectRepoProvisionRequest {
  workspaceId: string;
  slug: string;
  name: string;
  tagline: string;
  projectType: string | null;
  visibility: "private" | "public" | "unlisted";
  recipe?: ProjectRecipeId;
}

function validProjectRepoName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

function validProjectRepoTagline(value: unknown): value is string {
  return typeof value === "string" && value.length <= 500;
}

function validProjectRepoType(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 100);
}

function validProjectRepoVisibility(value: unknown): value is ProjectRepoProvisionRequest["visibility"] {
  return value === "private" || value === "public" || value === "unlisted";
}

function validProjectRepoRecipe(value: unknown): value is ProjectRecipeId | undefined {
  return value === undefined || isProjectRecipeId(value);
}

function validProjectRepoProvisionRequest(
  res: Response,
  value: unknown,
): value is ProjectRepoProvisionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    res.status(400).json({ error: "project repo provisioning input is required" });
    return false;
  }
  const input = value as Record<string, unknown>;
  if (!validSlug(res, input.workspaceId)) return false;
  if (!isValidProjectId(input.slug)) {
    res.status(400).json({ error: "slug must be a valid project id" });
    return false;
  }
  if (!validProjectRepoName(input.name)) {
    res.status(400).json({ error: "name must be 1-200 characters" });
    return false;
  }
  if (!validProjectRepoTagline(input.tagline)) {
    res.status(400).json({ error: "tagline must be at most 500 characters" });
    return false;
  }
  if (!validProjectRepoType(input.projectType)) {
    res.status(400).json({ error: "projectType must be null or at most 100 characters" });
    return false;
  }
  if (!validProjectRepoVisibility(input.visibility)) {
    res.status(400).json({ error: "visibility must be private, public, or unlisted" });
    return false;
  }
  if (!validProjectRepoRecipe(input.recipe)) {
    res.status(400).json({ error: `recipe must be one of ${PROJECT_RECIPE_IDS.join(", ")}` });
    return false;
  }
  return true;
}

interface GatewayCaller {
  gatewayId: string;
  podName: string | undefined;
}

function gatewayCallerForRequest(req: Request): GatewayCaller | null {
  const boundTenant = (req as Request & {
    boundTenant?: { kind?: unknown; gatewayId?: unknown; podName?: unknown };
  }).boundTenant;
  if (boundTenant?.kind === "gateway" && typeof boundTenant.gatewayId === "string") {
    const gatewayId = boundTenant.gatewayId.trim();
    if (gatewayId) {
      return {
        gatewayId,
        podName: typeof boundTenant.podName === "string" ? boundTenant.podName : undefined,
      };
    }
  }
  return null;
}

function gatewayKeyOwnerForRequest(req: Request, res: Response): string | null {
  const caller = gatewayCallerForRequest(req);
  if (!caller?.podName) {
    res.status(403).json({ error: "gateway pod identity is required for SSH key ownership" });
    return null;
  }
  return `${caller.gatewayId}/${caller.podName}`;
}

async function requireAssignedHere(req: Request, res: Response, slug: string): Promise<boolean> {
  const caller = gatewayCallerForRequest(req);
  if (!caller) {
    logger.error("internal/gitea assignment guard failed: no gateway identity is configured");
    res.status(500).json({ error: "gateway assignment guard is not configured" });
    return false;
  }
  const { gatewayId, podName } = caller;

  try {
    const assigned = await readAssignedSlugsForGateway(db, gatewayId);
    if (assigned.includes(slug)) return true;
    const gatewaySnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
    const gateway = gatewaySnap.exists ? gatewaySnap.data() : undefined;
    const configuredIsolatedBuilder = configuredBuilderBootstrapAllowed(gateway, {
      gatewayId,
      podName,
      slug,
    });
    if (configuredIsolatedBuilder) return true;
    if (!(await hasRunningInboundMigrationForSlug(db, gatewayId, slug))) {
      res.status(403).json({ error: "slug is not assigned to this gateway" });
      return false;
    }
    return true;
  } catch (err) {
    logger.error("internal/gitea assignment guard lookup failed", { err, gatewayId, slug });
    res.status(502).json({ error: "gateway assignment lookup failed" });
    return false;
  }
}

async function broker(res: Response, op: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    res.status(204).end();
  } catch (err) {
    logger.error(`internal/gitea ${op} failed`, { err });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

router.post("/ensure-user", async (req: Request, res: Response) => {
  const { slug, pubKey } = (req.body ?? {}) as { slug?: unknown; pubKey?: unknown };
  if (!validSlug(res, slug)) return;
  if (!isSshPublicKey(pubKey)) {
    res.status(400).json({ error: "pubKey must be a valid SSH public key" });
    return;
  }
  if (!(await requireAssignedHere(req, res, slug))) return;
  const keyOwner = gatewayKeyOwnerForRequest(req, res);
  if (!keyOwner) return;
  await broker(res, "ensure-user", () => ensureGiteaUser(slug, pubKey, keyOwner));
});

router.post("/release-user-key", async (req: Request, res: Response) => {
  const { slug, pubKey } = (req.body ?? {}) as { slug?: unknown; pubKey?: unknown };
  if (!validSlug(res, slug)) return;
  if (!isSshPublicKey(pubKey)) {
    res.status(400).json({ error: "pubKey must be a valid SSH public key" });
    return;
  }
  const keyOwner = gatewayKeyOwnerForRequest(req, res);
  if (!keyOwner) return;
  await broker(res, "release-user-key", () => deleteGiteaUserPubKey(slug, pubKey, keyOwner));
});

router.get("/user-pubkey", async (req: Request, res: Response) => {
  const { slug } = req.query;
  if (!validSlug(res, slug)) return;
  if (!(await requireAssignedHere(req, res, slug))) return;
  try {
    const pubKey = await readGiteaUserPubKey(slug);
    res.json({ pubKey });
  } catch (err) {
    logger.error("internal/gitea user-pubkey failed", { err });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/user-pubkeys", async (req: Request, res: Response) => {
  const { slug } = req.query;
  if (!validSlug(res, slug)) return;
  if (!(await requireAssignedHere(req, res, slug))) return;
  try {
    const pubKeys = await readGiteaUserPubKeys(slug);
    res.json({ pubKeys });
  } catch (err) {
    logger.error("internal/gitea user-pubkeys failed", { err });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/ensure-org", async (req: Request, res: Response) => {
  const { slug } = (req.body ?? {}) as { slug?: unknown };
  if (!validSlug(res, slug)) return;
  if (!(await requireAssignedHere(req, res, slug))) return;
  await broker(res, "ensure-org", () => ensureGiteaOrgForWorkspace(slug));
});

router.post("/ensure-workspace-repo", async (req: Request, res: Response) => {
  const { slug } = (req.body ?? {}) as { slug?: unknown };
  if (!validSlug(res, slug)) return;
  if (!(await requireAssignedHere(req, res, slug))) return;
  await broker(res, "ensure-workspace-repo", () => ensureWorkspaceRepo(slug));
});

router.post("/ensure-system-config-repo", async (req: Request, res: Response) => {
  const { slug } = (req.body ?? {}) as { slug?: unknown };
  if (!validSlug(res, slug)) return;
  if (!(await requireAssignedHere(req, res, slug))) return;
  await broker(res, "ensure-system-config-repo", () => ensureSystemConfigRepo(slug));
});

router.post("/ensure-project-repo", async (req: Request, res: Response) => {
  const { slug, projectName } = (req.body ?? {}) as { slug?: unknown; projectName?: unknown };
  if (!validSlug(res, slug)) return;
  if (!isValidProjectId(projectName)) {
    res.status(400).json({ error: "projectName must be a valid project id" });
    return;
  }
  if (!(await requireAssignedHere(req, res, slug))) return;
  await broker(res, "ensure-project-repo", () => ensureProjectRepo(slug, projectName));
});

router.post("/provision-project-repo", async (req: Request, res: Response) => {
  const input = req.body;
  if (!validProjectRepoProvisionRequest(res, input)) return;
  if (!(await requireAssignedHere(req, res, input.workspaceId))) return;
  try {
    const result = await ensureProjectGiteaRepo({
      workspaceId: input.workspaceId,
      slug: input.slug,
      name: input.name,
      tagline: input.tagline,
      projectType: input.projectType,
      visibility: input.visibility,
      recipe: input.recipe ?? defaultProjectRecipe(input.projectType),
    });
    res.json(result);
  } catch (err) {
    logger.error("internal/gitea provision-project-repo failed", { err });
    res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
      created: err instanceof ProjectRepoProvisioningError && err.created,
    });
  }
});

router.post("/delete-project-repo", async (req: Request, res: Response) => {
  const { workspaceId, slug } = (req.body ?? {}) as { workspaceId?: unknown; slug?: unknown };
  if (!validSlug(res, workspaceId)) return;
  if (!isValidProjectId(slug)) {
    res.status(400).json({ error: "slug must be a valid project id" });
    return;
  }
  if (!(await requireAssignedHere(req, res, workspaceId))) return;
  await broker(res, "delete-project-repo", () => deleteProjectGiteaRepo({ workspaceId, slug }));
});

router.get("/repo-exists", async (req: Request, res: Response) => {
  const { org, repo } = req.query;
  if (!isValidUsername(org) || !validRepoName(repo)) {
    res.status(400).json({ error: "org must be a valid workspace username and repo a valid repo name" });
    return;
  }
  if (!(await requireAssignedHere(req, res, org))) return;
  try {
    const exists = await repoExists(org, repo);
    res.json({ exists });
  } catch (err) {
    logger.error("internal/gitea repo-exists failed", { err });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/archive-repo", async (req: Request, res: Response) => {
  const { org, repo } = (req.body ?? {}) as { org?: unknown; repo?: unknown };
  if (!isValidUsername(org) || !validRepoName(repo)) {
    res.status(400).json({ error: "org must be a valid workspace username and repo a valid repo name" });
    return;
  }
  if (!(await requireAssignedHere(req, res, org))) return;
  await broker(res, "archive-repo", () => archiveRepo(org, repo));
});

export default router;
