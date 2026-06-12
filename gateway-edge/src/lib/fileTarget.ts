import type { Request, Response, NextFunction, RequestHandler } from "express";
import { db } from "./db.js";
import { readProject } from "./firestoreReads.js";
import { readConnectorAccessToken } from "./connector-tokens.js";
import { workspaceGiteaOrg, workspaceRepoName, projectRepoName } from "./gitea-naming.js";
import { logger } from "../middleware/logging.js";

export interface FileTarget {
  slug: string;
  projectSlug: string | null;
  provider: "gitea" | "github";

  org: string;

  repoName: string;
  gcsPrefix: string;
  githubToken?: string;
  canvasFile?: string;
}

export interface FileTargetInput {
  slug: string | null | undefined;
  projectSlug: string | null | undefined;
  callerUid: string | undefined;
  callerWorkspaceSlug: string | null | undefined;
}

export type FileTargetResult =
  | { ok: true; target: FileTarget }
  | { ok: false; status: 400 | 403 | 404 | 422; error: string; reason?: string };

export interface ResolveFileTargetOpts {
  resolveGithubToken?: boolean;
}

export async function resolveFileTarget(
  input: FileTargetInput,
  opts: ResolveFileTargetOpts = {},
): Promise<FileTargetResult> {
  const { slug, projectSlug, callerUid, callerWorkspaceSlug } = input;
  const resolveGithubToken = opts.resolveGithubToken ?? true;

  if (!slug) {
    return { ok: false, status: 400, error: "Missing slug" };
  }

  if (projectSlug) {
    const projectRef = db.doc(`workspaces/${slug}/projects/${projectSlug}`);
    const project = await readProject(projectRef);
    if (!project) {
      return { ok: false, status: 404, error: "Project not found" };
    }
    const isOwner = project.ownerUid === callerUid;
    let isMember = false;
    if (!isOwner && callerUid) {
      const memberDoc = await projectRef.collection("members").doc(callerUid).get();
      isMember = memberDoc.exists;
    }
    if (!isOwner && !isMember) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    const github =
      project.repoSource?.provider === "github" ? project.repoSource : null;
    if (github) {
      const githubTarget: FileTarget = {
        slug,
        projectSlug,
        provider: "github",
        org: github.owner,
        repoName: github.repo,
        gcsPrefix: `customers/${slug}/projects/${projectSlug}`,
        canvasFile: project.canvasFile,
      };
      if (!resolveGithubToken) {
        return { ok: true, target: githubTarget };
      }
      const githubToken = await readConnectorAccessToken(project.ownerUid, "github");
      if (!githubToken) {
        return {
          ok: false,
          status: 422,
          error: "GitHub files unavailable",
          reason: "owner_github_not_connected",
        };
      }
      logger.info(
        `[fileTarget] owner-brokered github read repo=${github.owner}/${github.repo} caller=${callerUid} tokenOwner=${project.ownerUid}`,
      );
      return { ok: true, target: { ...githubTarget, githubToken } };
    }
    return {
      ok: true,
      target: {
        slug,
        projectSlug,
        provider: "gitea",
        org: workspaceGiteaOrg(slug),
        repoName: projectRepoName(projectSlug),
        gcsPrefix: `customers/${slug}/projects/${projectSlug}`,
      },
    };
  }

  if (callerWorkspaceSlug !== slug) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return {
    ok: true,
    target: {
      slug,
      projectSlug: null,
      provider: "gitea",
      org: workspaceGiteaOrg(slug),
      repoName: workspaceRepoName(),
      gcsPrefix: `customers/${slug}`,
    },
  };
}

function readTargetInput(req: Request): { slug: string | null; projectSlug: string | null } {
  const slug = ((req.query.slug as string) || (req.body?.slug as string) || null) as string | null;
  const projectSlug = ((req.query.project as string) || (req.body?.project as string) || null) as string | null;
  return { slug, projectSlug };
}

export type TargetedHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  target: FileTarget,
) => Promise<void>;

export function withFileTarget(
  handler: TargetedHandler,
  opts?: ResolveFileTargetOpts,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const { slug, projectSlug } = readTargetInput(req);
      const result = await resolveFileTarget(
        {
          slug,
          projectSlug,
          callerUid: req.uid,
          callerWorkspaceSlug: req.user?.username,
        },
        opts,
      );
      if (!result.ok) {
        res
          .status(result.status)
          .json({ error: result.error, ...(result.reason ? { reason: result.reason } : {}) });
        return;
      }
      await handler(req, res, next, result.target);
    } catch (e) {
      next(e);
    }
  };
}

export function withGiteaTarget(handler: TargetedHandler): RequestHandler {
  return withFileTarget(
    async (req, res, next, target) => {
      if (target.provider !== "gitea") {
        res.status(409).json({
          error: "Not available for GitHub-backed projects",
          code: "GITHUB_READ_ONLY",
        });
        return;
      }
      await handler(req, res, next, target);
    },
    { resolveGithubToken: false },
  );
}
