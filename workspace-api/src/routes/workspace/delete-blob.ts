/**
 * POST /delete-blob — remove a blob from Storage + manifest.
 *
 * Idempotent: missing blob / thumbnail files are silently skipped so a
 * double-delete from the UI doesn't surface as an error.
 */
import { Router } from "express";
import { storage } from "../../lib/db";
import { validateFilePath } from "../../lib/path-validation";
import { withFileTarget } from "../../lib/fileTarget";
import { removeFromManifest } from "../../lib/manifest";
import { getCustomerGiteaToken } from "./helpers";

const router = Router();

router.post("/delete-blob", withFileTarget(async (req, res, _next, target) => {
  const { path: filePath } = req.body as { path?: string };
  if (!filePath) { res.status(400).json({ error: "Missing path" }); return; }

  const pathError = validateFilePath(filePath);
  if (pathError) { res.status(400).json({ error: pathError }); return; }

  const bucket = storage.bucket();

  const file = bucket.file(`${target.gcsPrefix}/${filePath}`);
  const [exists] = await file.exists();
  if (exists) await file.delete();

  const thumbFile = bucket.file(`${target.gcsPrefix}/.thumbs/${filePath}.png`);
  const [thumbExists] = await thumbFile.exists();
  if (thumbExists) await thumbFile.delete();

  await removeFromManifest(
    getCustomerGiteaToken(req),
    target.repoName,
    filePath,
    `blob: removed ${filePath}`,
  );

  res.json({ success: true, deleted: filePath });
}));

export default router;
