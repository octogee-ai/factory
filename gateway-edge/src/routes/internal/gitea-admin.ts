import { Router, type Request, type Response } from "express";

import { isValidProjectId, isValidUsername } from "@shared/types/identity.js";
import { readAssignedSlugsForGateway } from "../../../../scripts/lib/assigned-roster.js";
import { db } from "../../lib/db.js";
import { requireInternalServiceAuth } from "../../middleware/auth.js";
import { logger } from "../../middleware/logging.js";
import {
  archiveRepo,
  ensureGiteaOrgForWorkspace,
  ensureGiteaUser,
  ensureProjectRepo,
  ensureSystemConfigRepo,
  ensureWorkspaceRepo,
  readGiteaUserPubKey,
  repoExists,
} from "../../lib/gitea-admin.js";
import {
  systemConfigRepoName,
  workspaceRepoName,
} from "../../lib/gitea-naming.js";

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

function gatewayIdForRequest(req: Request): string | null {
  const boundTenant = (req as Request & {
    boundTenant?: { kind?: unknown; gatewayId?: unknown };
  }).boundTenant;
  if (boundTenant?.kind === "gateway" && typeof boundTenant.gatewayId === "string") {
    const gatewayId = boundTenant.gatewayId.trim();
    if (gatewayId) return gatewayId;
  }

  const gatewayId = process.env.GATEWAY_ID?.trim();
  return gatewayId ? gatewayId : null;
}

async function requireAssignedHere(req: Request, res: Response, slug: string): Promise<boolean> {
  const gatewayId = gatewayIdForRequest(req);
  if (!gatewayId) {
    logger.error("internal/gitea assignment guard failed: no gateway identity is configured");
    res.status(500).json({ error: "gateway assignment guard is not configured" });
    return false;
  }

  try {
    const assigned = await readAssignedSlugsForGateway(db, gatewayId);
    if (!assigned.includes(slug)) {
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
  await broker(res, "ensure-user", () => ensureGiteaUser(slug, pubKey));
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
