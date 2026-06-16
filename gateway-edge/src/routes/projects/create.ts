import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { logger } from "../../middleware/logging.js";
import { db } from "../../lib/db.js";
import {
  createProjectForActor,
  projectSlugAvailability,
  type ProjectCreateInput,
} from "../../lib/project-create-service.js";

const router = Router();

router.get("/slug-available", async (req: Request, res: Response) => {
  const slug = String(req.query.slug ?? "").trim();

  const availability = projectSlugAvailability(slug);
  if (!availability.ok) {
    res.json({ available: false, reason: availability.reason });
    return;
  }

  const workspaceId = req.workspaceSlug;
  if (!workspaceId) {
    res.status(422).json({ error: "Workspace not provisioned" });
    return;
  }

  const existing = await db.doc(`workspaces/${workspaceId}/projects/${slug}`).get();
  res.json({ available: !existing.exists });
});

router.post("/", strictRateLimit, async (req: Request, res: Response) => {
  try {
    const result = await createProjectForActor(
      {
        uid: req.uid!,
        userData: req.user,
        workspaceId: req.workspaceSlug,
        isAdmin: req.isAdmin,
        source: "ui",
      },
      req.body as ProjectCreateInput,
    );
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error("[projects] Create failed:", { err });
    res.status(500).json({ error: "Failed to create project" });
  }
});

export default router;
