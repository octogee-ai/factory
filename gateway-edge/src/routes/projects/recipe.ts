import { Router, type Request, type Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { FieldValue } from "../../lib/db.js";
import { logger } from "../../middleware/logging.js";
import { withProject } from "../../lib/withProject.js";
import { requestedProjectRecipe } from "../../lib/project-recipe.js";

const router = Router();

router.patch("/:wid/:pid/recipe", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };

  await withProject(req, res, wid, pid, {
    ownerOnly: true,
    requireActive: true,
    ownerErrorMessage: "Only the project owner can change the project recipe",
    logTag: "[recipe] crashed for",
    errorMessage: "Could not update the project recipe",
  }, async ({ projectRef, project, uid }) => {
    const requested = requestedProjectRecipe(
      (req.body as { recipe?: unknown } | undefined)?.recipe,
    );
    if (!requested.ok) {
      res.status(400).json({ error: requested.error });
      return;
    }

    await projectRef.update({
      recipe: requested.value,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info(
      `[recipe] ${projectRef.path}: ${project.recipe ?? "none"} → ${requested.value}`,
      { uid },
    );
    res.json({ success: true, recipe: requested.value });
  });
});

export default router;
