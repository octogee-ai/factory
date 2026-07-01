import { Router } from "express";
import { storage } from "../../lib/db.js";
import { withGiteaTarget } from "../../lib/fileTarget.js";
import { removeFromManifest } from "../../lib/manifest.js";
import { giteaSudoUser, validateWorkspacePath } from "./helpers.js";
import { invalidateWorkspaceFileResponseCache } from "./file-response-cache.js";

const router = Router();

router.post("/delete-blob", withGiteaTarget(async (req, res, _next, target) => {
  const { path: filePath } = req.body as { path?: string };
  if (!filePath) { res.status(400).json({ error: "Missing path" }); return; }

  const pathError = validateWorkspacePath(filePath);
  if (pathError) { res.status(400).json({ error: pathError }); return; }

  const bucket = storage.bucket();

  const file = bucket.file(`${target.gcsPrefix}/${filePath}`);
  const [exists] = await file.exists();
  if (exists) await file.delete();

  const thumbFile = bucket.file(`${target.gcsPrefix}/.thumbs/${filePath}.png`);
  const [thumbExists] = await thumbFile.exists();
  if (thumbExists) await thumbFile.delete();

  await removeFromManifest(
    giteaSudoUser(target),
    target.org,
    target.repoName,
    filePath,
    `blob: removed ${filePath}`,
  );
  invalidateWorkspaceFileResponseCache(target);

  res.json({ success: true, deleted: filePath });
}));

export default router;
