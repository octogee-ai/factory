/**
 * File-target resolution for workspace-scoped file operations.
 *
 * Every route in `routes/workspace.ts` needs to answer two questions before
 * touching Gitea or GCS: "what repo/prefix am I reading from" and "is the
 * caller allowed to read it". This module owns both.
 *
 * The resolver is split into a pure function (`resolveFileTarget`) and an
 * Express wrapper (`withFileTarget`) so the authorization logic can be
 * unit-tested without mounting a route. See
 * workspace-api/src/__tests__/fileTarget.spec.ts for the characterization
 * suite.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { db } from "./db";

/** Resolved target for a file operation — points at a workspace or project repo. */
export interface FileTarget {
  /** Bare workspace slug (always present, for shared GCS rooting). */
  slug: string;
  /** Project slug, if this target is a project repo. */
  projectSlug: string | null;
  /** Gitea repo name to read/write. */
  repoName: string;
  /** GCS prefix for blob storage under this target (no trailing slash). */
  gcsPrefix: string;
}

/** Inputs the resolver needs — same info the original req-coupled version read. */
export interface FileTargetInput {
  slug: string | null | undefined;
  projectSlug: string | null | undefined;
  /** Caller's Firebase UID (from requireAuth middleware). */
  callerUid: string | undefined;
  /** Caller's workspace slug, per their user doc. Used for workspace-level auth. */
  callerWorkspaceSlug: string | null | undefined;
}

/** Discriminated-union result so callers can't forget the failure path. */
export type FileTargetResult =
  | { ok: true; target: FileTarget }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Resolve a file target from plain inputs. Pure over Firestore reads — no
 * req/res plumbing, no direct response writes. The route layer translates
 * the `{ok: false, status, error}` result into an HTTP response.
 *
 * Authorization rules (unchanged from the original implementation):
 *
 *   - `slug` required → 400 "Missing slug"
 *   - If `projectSlug` is present:
 *       - project doc must exist at `workspaces/{slug}/projects/{projectSlug}` → 404
 *       - caller must be `ownerUid` or have a `members/{callerUid}` doc → 403
 *   - If no `projectSlug`:
 *       - `callerWorkspaceSlug` must equal `slug` → 403 "Forbidden"
 *
 * Per DATA-MODEL-REVIEW v3: slug = username (workspace ID). Projects nested
 * under workspaces/{wid}/projects/{pid}; membership is a subcollection.
 *
 * Repo names and GCS prefixes are derived deterministically:
 *   workspace:  `{slug}-workspace`       / `customers/{slug}`
 *   project:    `{slug}-proj-{projSlug}` / `customers/{slug}/projects/{projSlug}`
 */
export async function resolveFileTarget(input: FileTargetInput): Promise<FileTargetResult> {
  const { slug, projectSlug, callerUid, callerWorkspaceSlug } = input;

  if (!slug) {
    return { ok: false, status: 400, error: "Missing slug" };
  }

  if (projectSlug) {
    const projectRef = db.doc(`workspaces/${slug}/projects/${projectSlug}`);
    const projectDoc = await projectRef.get();
    if (!projectDoc.exists) {
      return { ok: false, status: 404, error: "Project not found" };
    }
    const project = projectDoc.data()!;
    const isOwner = project.ownerUid === callerUid;
    let isMember = false;
    if (!isOwner && callerUid) {
      const memberDoc = await projectRef.collection("members").doc(callerUid).get();
      isMember = memberDoc.exists;
    }
    if (!isOwner && !isMember) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    return {
      ok: true,
      target: {
        slug,
        projectSlug,
        repoName: `${slug}-proj-${projectSlug}`,
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
      repoName: `${slug}-workspace`,
      gcsPrefix: `customers/${slug}`,
    },
  };
}

/**
 * Read `{slug, projectSlug}` from the request in a uniform way (query first,
 * then body — matches the historical precedence so we don't silently change
 * which source wins).
 */
function readTargetInput(req: Request): { slug: string | null; projectSlug: string | null } {
  const slug = ((req.query.slug as string) || (req.body?.slug as string) || null) as string | null;
  const projectSlug = ((req.query.project as string) || (req.body?.project as string) || null) as string | null;
  return { slug, projectSlug };
}

/**
 * Express wrapper: resolves the file target from the request, writes the
 * appropriate error response on failure, or invokes `handler` with the
 * resolved target on success. Any thrown error is forwarded to `next` so
 * the global error middleware handles it uniformly.
 *
 * Removes the repetitive `const target = await resolveTarget(req, res); if
 * (!target) return;` two-liner from every route. The handler signature is
 * augmented with a typed `target` parameter so downstream code can't forget
 * to check the failure path.
 */
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
        // Username IS the workspace slug per v3 §2.
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
