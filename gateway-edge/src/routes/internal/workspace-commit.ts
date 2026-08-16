import { Router, type Request, type Response } from "express";
import {
  resolveCustomerDir,
  resolveProjectDir,
  commitAndPushWorkspace,
  isTrustedGithubCustomerCheckout,
  isSafeSlug,
} from "../../lib/workspace-git.js";
import {
  ConnectorTokenReadError,
  readOwnerRuntimeConnectorAccessToken,
} from "../../lib/connector-tokens.js";
import { isValidProjectId } from "@octogee/shared/types/identity";
import { resolveCommitAuthor } from "../workspace/helpers.js";
import { logger } from "../../middleware/logging.js";
import { verifyWorkspaceCommitProofViaBroker } from "../../lib/workspace-commit-proof-broker.js";

const router = Router();

const DEFAULT_MESSAGE = "agent: workspace commit";
const MAX_MESSAGE_LEN = 5_000;

async function onDemandGithubToken(
  dir: string,
  res: Response,
): Promise<string | undefined | null> {
  if (!isTrustedGithubCustomerCheckout(dir)) return undefined;
  try {
    const token = await readOwnerRuntimeConnectorAccessToken("github");
    if (token) return token;
    res.status(422).json({
      error: "Connect GitHub before saving this project.",
      code: "GITHUB_NOT_CONNECTED",
    });
    return null;
  } catch (err) {
    if (err instanceof ConnectorTokenReadError && err.errorCode === "reauth_required") {
      res.status(422).json({
        error: "Reconnect GitHub before saving this project.",
        code: "GITHUB_REAUTH_REQUIRED",
      });
      return null;
    }
    logger.error("internal/workspace/commit: GitHub credential broker failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({
      error: "GitHub authentication is temporarily unavailable; retry shortly.",
      code: "GITHUB_AUTH_UNAVAILABLE",
    });
    return null;
  }
}

function customersRoot(): string {
  return process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers";
}

type CommitRequest = { agentId: string; slug: string; project: string | null; message: string };
type CommitRequestError = { status: number; error: string; code: string };

function parseCommitRequest(
  body: Record<string, unknown> | undefined,
): CommitRequest | CommitRequestError {
  const slug = typeof body?.slug === "string" ? body.slug : "";
  if (!isSafeSlug(slug)) return { status: 400, error: "Invalid slug", code: "BAD_SLUG" };
  const agentId = typeof body?.agentId === "string" ? body.agentId : "";
  if (!agentId) return { status: 400, error: "Invalid agent identity", code: "BAD_AGENT" };
  const project = typeof body?.project === "string" ? body.project : null;
  if (project !== null && !isValidProjectId(project)) {
    return { status: 400, error: "Invalid project", code: "BAD_PROJECT" };
  }
  const raw = typeof body?.message === "string" ? body.message.trim() : "";
  if (raw.length > MAX_MESSAGE_LEN) {
    return { status: 400, error: "Commit message too long", code: "MESSAGE_TOO_LONG" };
  }
  return { agentId, slug, project, message: raw || DEFAULT_MESSAGE };
}

router.post("/commit", async (req: Request, res: Response) => {
  const parsed = parseCommitRequest(req.body as Record<string, unknown> | undefined);
  if ("code" in parsed) {
    res.status(parsed.status).json({ error: parsed.error, code: parsed.code });
    return;
  }
  const { agentId, slug, project, message } = parsed;

  let authorized: boolean;
  try {
    authorized = await verifyWorkspaceCommitProofViaBroker(req, { agentId, slug, project });
  } catch (error) {
    logger.warn(
      `internal/workspace/commit: identity proof lookup failed slug=${slug}: ${error instanceof Error ? error.message : String(error)}`,
    );
    res.status(503).json({ error: "Agent identity verification temporarily unavailable.", code: "PROOF_UNAVAILABLE" });
    return;
  }
  if (!authorized) {
    logger.warn(`internal/workspace/commit: rejected agent identity proof slug=${slug}`);
    res.status(403).json({ error: "Agent identity proof rejected.", code: "PROOF_REJECTED" });
    return;
  }

  const start = Date.now();
  const customerDir = await resolveCustomerDir(customersRoot(), slug);
  if (!customerDir) {
    logger.warn(`internal/workspace/commit: working tree not accessible slug=${slug}`);
    res.status(503).json({
      error: "Working tree temporarily unavailable; retry shortly.",
      code: "CUSTOMER_DIR_MISSING",
    });
    return;
  }
  // Project agents commit their project clone ONLY; the lane comes from the
  // tool's identity-derived request, and a missing clone must fail loudly
  // rather than fall back to the workspace repo.
  let dir = customerDir;
  if (project) {
    const projectDir = await resolveProjectDir(customersRoot(), slug, project);
    if (!projectDir) {
      logger.warn(`internal/workspace/commit: project clone missing slug=${slug} project=${project}`);
      res.status(503).json({
        error: "Project working tree temporarily unavailable; retry shortly.",
        code: "PROJECT_DIR_MISSING",
      });
      return;
    }
    dir = projectDir;
  }

  const author = resolveCommitAuthor(undefined, slug);
  const githubToken = await onDemandGithubToken(dir, res);
  if (githubToken === null) return;
  // Workspace-lane commits must never sweep the nested project clones — each
  // project repo has its own commit path (octogee_project_commit). The
  // exclusion is enforced here, not just .gitignore, so workspaces seeded
  // before projects/ was ignored are covered too.
  const r = await commitAndPushWorkspace(dir, {
    message,
    author,
    ...(project ? {} : { excludePathspecs: ["projects"] }),
    ...(githubToken ? { githubToken } : {}),
  });
  if (!r.ok) {
    logger.warn(`internal/workspace/commit: git error slug=${slug} code=${r.error.code}`);
    if (r.error.code === "WORKSPACE_BUSY") {
      res.status(409).json({ error: "Workspace is busy; retry shortly.", code: r.error.code });
      return;
    }
    res.status(500).json({ error: "git command failed", code: r.error.code });
    return;
  }
  if (r.result.pushError) {
    logger.warn(`internal/workspace/commit: committed but push failed slug=${slug}: ${r.result.pushError}`);
    res.status(502).json({
      error: "Commit was created locally, but the remote rejected the push. Do not build or publish until a later commit succeeds.",
      code: "PUSH_FAILED",
      committed: r.result.committed,
      pushed: false,
      nothingToCommit: r.result.nothingToCommit,
    });
    return;
  }
  const laneSuffix = project ? ` project=${project}` : "";
  logger.info(
    `internal/workspace/commit slug=${slug}${laneSuffix} committed=${r.result.committed} pushed=${r.result.pushed} nothing=${r.result.nothingToCommit} dur=${Date.now() - start}ms`,
  );
  res.json({
    committed: r.result.committed,
    pushed: r.result.pushed,
    nothingToCommit: r.result.nothingToCommit,
  });
});

export default router;
