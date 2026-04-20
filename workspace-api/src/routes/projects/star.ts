/**
 * POST /:wid/:pid/star — toggle a star on the project.
 *
 * Maintains a `stars/{uid}_{wid}_{pid}` doc as the authoritative star
 * record, plus a denormalized `starCount` on the project doc for fast
 * display on discovery pages. First request stars; second unstars.
 */
import { Router, Request, Response } from "express";
import { db, FieldValue } from "../../lib/db";
import { logger } from "../../middleware/logging";
import { readProject } from "../../lib/firestoreReads";

const router = Router();

router.post("/:wid/:pid/star", async (req: Request, res: Response) => {
  const { wid, pid } = req.params;
  const uid = req.uid!;

  try {
    const starId = `${uid}_${wid}_${pid}`;
    const starRef = db.doc(`stars/${starId}`);
    const projectRef = db.doc(`workspaces/${wid}/projects/${pid}`);
    const starDoc = await starRef.get();

    if (starDoc.exists) {
      await starRef.delete();
      await projectRef.update({ starCount: FieldValue.increment(-1) });
      res.json({ starred: false });
    } else {
      const project = await readProject(projectRef);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      await starRef.set({
        starrerUid: uid,
        workspaceId: wid,
        projectSlug: pid,
        projectOwnerUid: project.ownerUid,
        createdAt: FieldValue.serverTimestamp(),
      });
      await projectRef.update({ starCount: FieldValue.increment(1) });
      res.json({ starred: true });
    }
  } catch (err) {
    logger.error(`[projects] Star toggle failed:`, { err });
    res.status(500).json({ error: "Failed to toggle star" });
  }
});

export default router;
