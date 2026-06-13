import { Router, type Request, type Response } from "express";

import { isValidProjectId, isValidUsername } from "@shared/types/identity.js";
import { requireInternalServiceAuth } from "../../middleware/auth.js";
import { logger } from "../../middleware/logging.js";
import {
  archiveRepo,
  ensureGiteaOrgForWorkspace,
  ensureGiteaUser,
  ensureProjectRepo,
  ensureWorkspaceRepo,
  readGiteaUserPubKey,
  repoExists,
} from "../../lib/gitea-admin.js";

// Gitea ADMIN broker for the in-pod provisioner. The provisioner runs in the shell-bearing
// openclaw container and no longer holds the admin token; it calls these localhost-only
// endpoints on the no-shell gateway-edge sidecar (which holds GITEA_TOKEN) to mint users,
// register the per-customer SSH key, and create orgs/repos. Local git (SSH clone/init/push)
// stays in the provisioner. Service-key guarded; never exposed via the ingress.
//
// Every path-bound input is re-validated HERE because this HTTP boundary is a new entry
// point that bypasses the provisioner's upstream isValidUsername gate — and INTERNAL_SERVICE_KEY
// still lives in the shell-bearing container, so a compromised agent could reach these. Strict
// validation blocks path traversal / injection into the privileged Gitea paths. (Cross-tenant
// scoping + getting the service key off the shell container are the longer-term hardening,
// tracked with the Tier-2 ensureCredentials work — see PLATFORM-CREDENTIAL-BROKERING-SPEC.)

const router = Router();
router.use(requireInternalServiceAuth);

// Our Gitea repo names are always either the fixed "workspace" or a project slug — both
// satisfy isValidProjectId (^[a-z0-9]+$). Orgs are workspace slugs (isValidUsername).
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
  await broker(res, "ensure-user", () => ensureGiteaUser(slug, pubKey));
});

router.get("/user-pubkey", async (req: Request, res: Response) => {
  const { slug } = req.query;
  if (!validSlug(res, slug)) return;
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
  await broker(res, "ensure-org", () => ensureGiteaOrgForWorkspace(slug));
});

router.post("/ensure-workspace-repo", async (req: Request, res: Response) => {
  const { slug } = (req.body ?? {}) as { slug?: unknown };
  if (!validSlug(res, slug)) return;
  await broker(res, "ensure-workspace-repo", () => ensureWorkspaceRepo(slug));
});

router.post("/ensure-project-repo", async (req: Request, res: Response) => {
  const { slug, projectName } = (req.body ?? {}) as { slug?: unknown; projectName?: unknown };
  if (!validSlug(res, slug)) return;
  if (!isValidProjectId(projectName)) {
    res.status(400).json({ error: "projectName must be a valid project id" });
    return;
  }
  await broker(res, "ensure-project-repo", () => ensureProjectRepo(slug, projectName));
});

router.get("/repo-exists", async (req: Request, res: Response) => {
  const { org, repo } = req.query;
  if (!isValidUsername(org) || !isValidProjectId(repo)) {
    res.status(400).json({ error: "org must be a valid workspace username and repo a valid repo name" });
    return;
  }
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
  if (!isValidUsername(org) || !isValidProjectId(repo)) {
    res.status(400).json({ error: "org must be a valid workspace username and repo a valid repo name" });
    return;
  }
  await broker(res, "archive-repo", () => archiveRepo(org, repo));
});

export default router;
