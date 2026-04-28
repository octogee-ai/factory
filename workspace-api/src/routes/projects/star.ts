/**
 * POST /:wid/:pid/star — toggle a star on the project.
 *
 * Writes the typed-target shape per BUILDER-SOCIAL-SPEC §10:
 *   stars/{actorUid}_p_{workspaceSlug}_{projectSlug}
 *   { actorUid, target: { type: 'project', ... }, createdAt }
 *
 * `starCount` (on both the project doc and the owner's profile) is
 * maintained by `functions/src/triggers/social.ts:onStarCreated`/
 * `onStarDeleted` via `starDeltas` — the endpoint MUST NOT increment
 * counters itself or it will double-count. Likewise no `actorUsername`
 * denorm: the CF aggregator reads `users/{actorUid}/profile/public.username`
 * fresh for every notification + feed event, so denorming it here would
 * just be a stale-data risk.
 */
import { Router, Request, Response } from "express";
import { db, FieldValue } from "../../lib/db";
import { logger } from "../../middleware/logging";
import { readProject } from "../../lib/firestoreReads";
import { starDocId } from "../../../../shared/types/social";

const router = Router();

router.post("/:wid/:pid/star", async (req: Request, res: Response) => {
  const { wid, pid } = req.params;
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
      // CF onStarDeleted decrements starCount via starDeltas.
      await starRef.delete();
      res.json({ starred: false });
    } else {
      // CF onStarCreated bumps project.starCount + owner profile.starCount
      // via starDeltas — endpoint does NOT update either counter directly.
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
