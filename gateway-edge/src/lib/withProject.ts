import type { Request, Response } from "express";
import type { Project } from "@shared/types";
import { db } from "./db";
import { readProject } from "./firestoreReads";
import { logger } from "../middleware/logging";
import { isValidProjectId, USERNAME_RE } from "@shared/types/identity";

export type ProjectCtx = {
  projectRef: FirebaseFirestore.DocumentReference;
  project: Project;
  uid: string;
  wid: string;
  pid: string;
};

export type WithProjectOptions = {
  ownerOnly?: boolean;
  ownerErrorMessage?: string;
  allowStates?: string[];
  logTag?: string;
  errorMessage?: string;
};

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
    const project = await readProject(projectRef);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

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
