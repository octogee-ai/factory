import { Router, Request, Response } from "express";
import { db, FieldValue } from "../../lib/db.js";
import { logger } from "../../middleware/logging.js";
import { readProject } from "../../lib/firestoreReads.js";
import { starDocId } from "../../../../shared/types/social.js";

const router = Router();

router.post("/:wid/:pid/star", async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  const uid = req.uid!;

  try {
    const projectRef = db.doc(`workspaces/${wid}/projects/${pid}`);
    const project = await readProject(projectRef);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const target = {
      type: "project" as const,
      workspaceSlug: wid,
      projectSlug: pid,
      ownerUid: project.ownerUid,
    };
    const starRef = db.doc(`stars/${starDocId(uid, target)}`);
    const starDoc = await starRef.get();

    if (starDoc.exists) {
      
      await starRef.delete();
      res.json({ starred: false });
    } else {

await starRef.set({
        actorUid: uid,
        target,
        createdAt: FieldValue.serverTimestamp(),
      });
      res.json({ starred: true });
    }
  } catch (err) {
    logger.error(`[projects] Star toggle failed:`, { err });
    res.status(500).json({ error: "Failed to toggle star" });
  }
});

export default router;
