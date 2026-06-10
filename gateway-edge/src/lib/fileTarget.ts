import type { Request, Response, NextFunction, RequestHandler } from "express";
import { db } from "./db.js";
import { readProject } from "./firestoreReads.js";
import { workspaceGiteaOrg, workspaceRepoName, projectRepoName } from "./gitea-naming.js";

export interface FileTarget {
  slug: string;
  projectSlug: string | null;
  provider: "gitea" | "github";

  org: string;

  repoName: string;
  gcsPrefix: string;
}

export interface FileTargetInput {
  slug: string | null | undefined;
  projectSlug: string | null | undefined;
  callerUid: string | undefined;
  callerWorkspaceSlug: string | null | undefined;
}

export type FileTargetResult =
  | { ok: true; target: FileTarget }
  | { ok: false; status: 400 | 403 | 404; error: string };

export async function resolveFileTarget(input: FileTargetInput): Promise<FileTargetResult> {
  const { slug, projectSlug, callerUid, callerWorkspaceSlug } = input;

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
    return {
      ok: true,
      target: {
        slug,
        projectSlug,
        provider: github ? "github" : "gitea",
        org: github ? github.owner : workspaceGiteaOrg(slug),
        repoName: github ? github.repo : projectRepoName(projectSlug),
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

export function withFileTarget(handler: TargetedHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      const { slug, projectSlug } = readTargetInput(req);
      const result = await resolveFileTarget({
        slug,
        projectSlug,
        callerUid: req.uid,
        callerWorkspaceSlug: req.user?.username,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      await handler(req, res, next, result.target);
    } catch (e) {
      next(e);
    }
  };
}
