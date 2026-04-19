/**
 * withProject — shared prelude for project-doc route handlers.
 *
 * Every project/sharing route that touches a specific project follows the
 * same prelude: validate slugs, fetch the project doc, 404 if missing,
 * 403 if the caller isn't the owner, 500 with logger.error on unhandled
 * throw. This helper collapses that into one call so the routes can focus
 * on the business logic they actually differ on.
 *
 * Example:
 *
 *     router.post("/:wid/:pid/some-action", async (req, res) => {
 *       const { wid, pid } = req.params;
 *       await withProject(req, res, wid, pid, {
 *         ownerOnly: true,
 *         ownerErrorMessage: "Only the project owner can ...",
 *         errorMessage: "Action failed",
 *         logTag: "[projects] Some-action",
 *       }, async ({ projectRef, project, uid }) => {
 *         // business logic — throw for unhandled errors (→ 500)
 *       });
 *     });
 *
 * Security: validates `wid` against the workspace-slug regex and `pid`
 * against the project-id regex before constructing a Firestore path, so
 * malformed slugs can't steer the doc lookup at unrelated collections.
 */
import type { Request, Response } from "express";
import { db } from "./db";
import { logger } from "../middleware/logging";
import { isValidProjectId, USERNAME_RE } from "@shared/types/identity";

export type ProjectCtx = {
  projectRef: FirebaseFirestore.DocumentReference;
  project: FirebaseFirestore.DocumentData;
  uid: string;
  wid: string;
  pid: string;
};

export type WithProjectOptions = {
  /** Require the caller's uid to equal project.ownerUid. Returns 403 if not. */
  ownerOnly?: boolean;
  /** Custom 403 message when ownerOnly fails. */
  ownerErrorMessage?: string;
  /** If set, project.provisioningState must be in this list, else 409. */
  allowStates?: string[];
  /**
   * Log tag prefix for unhandled errors caught by the outer wrapper.
   * The helper appends ` ${wid}/${pid}:` and the error automatically.
   */
  logTag?: string;
  /** Body for the 500 response on unhandled throw. */
  errorMessage?: string;
};

/**
 * Fetch a project doc with the standard 404/403/500 prelude. The handler
 * runs only on the happy path; any throw inside it is caught, logged via
 * `logTag`, and turned into a 500 with `errorMessage` (unless the handler
 * already sent a response). Business-logic errors where the handler wants
 * to respond with a specific status (502, 409, etc.) should set the
 * response themselves and `return` — the outer catch respects
 * `res.headersSent`.
 */
export async function withProject(
  req: Request,
  res: Response,
  wid: string,
  pid: string,
  opts: WithProjectOptions,
  handler: (ctx: ProjectCtx) => Promise<void>,
): Promise<void> {
  const logTag = opts.logTag ?? "[projects]";
  try {
    if (!USERNAME_RE.test(wid) || !isValidProjectId(pid)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const projectRef = db.doc(`workspaces/${wid}/projects/${pid}`);
    const projectDoc = await projectRef.get();
    if (!projectDoc.exists) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const project = projectDoc.data()!;

    if (opts.ownerOnly && project.ownerUid !== req.uid) {
      res.status(403).json({
        error:
          opts.ownerErrorMessage ??
          "Only the project owner can perform this action",
      });
      return;
    }

    if (opts.allowStates && !opts.allowStates.includes(project.provisioningState)) {
      res.status(409).json({
        error: `Project is not in a valid state for this action (current: ${project.provisioningState ?? "unknown"})`,
      });
      return;
    }

    await handler({ projectRef, project, uid: req.uid!, wid, pid });
  } catch (err: any) {
    logger.error(`${logTag} ${wid}/${pid}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: opts.errorMessage ?? "Operation failed" });
    }
  }
}
