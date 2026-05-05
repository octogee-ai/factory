import { Router, Request, Response, NextFunction } from "express";
import { storage } from "../../lib/db";
import { updateManifest } from "../../lib/manifest";
import {
  customerGiteaApi,
  ensureSlug,
  getCustomerGiteaToken,
  getExtension,
  getMimeType,
  isTextFile,
  validateWorkspacePath,
} from "./helpers";

const router = Router();

router.post("/import-repo", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = ensureSlug(req, res);
    if (!slug) return;

    const { repoUrl, targetDir } = req.body as { repoUrl: string; targetDir?: string };
    if (!repoUrl) { res.status(400).json({ error: "Missing repoUrl" }); return; }

    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (!match) {
      res.status(400).json({ error: "Invalid repo URL. Use https://github.com/owner/repo format." });
      return;
    }

    const [, owner, repo] = match;
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      res.status(400).json({ error: "Invalid GitHub owner or repo name." });
      return;
    }
    const destDir = targetDir || `builds/${repo}/src`;
    const destDirError = validateWorkspacePath(destDir);
    if (destDirError) {
      res.status(400).json({ error: `Invalid targetDir: ${destDirError}` });
      return;
    }
    const workspaceRepo = `${slug}-workspace`;
    const ghToken = process.env.GITHUB_TOKEN;

    const treeResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
      {
        headers: {
          ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}),
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "octogee-workspace",
        },
      },
    );

    if (!treeResp.ok) {
      if (treeResp.status === 404) {
        res.status(404).json({ error: "Repository not found or not accessible." });
        return;
      }
      throw new Error(`Source repo API ${treeResp.status}`);
    }

    interface GitHubTreeEntry {
      path: string;
      type: string;
      sha: string;
      size?: number;
    }
    const treeData = (await treeResp.json()) as { tree: GitHubTreeEntry[] };
    const blobs = (treeData.tree ?? []).filter((i) => i.type === "blob");
    const SKIP = [/^\.git\//, /node_modules\//, /^\.DS_Store$/, /^__MACOSX\//];
    const manifestEntries: Record<string, unknown> = {};
    let fileCount = 0;

    for (const blob of blobs) {
      if (SKIP.some((p) => p.test(blob.path))) continue;
      if (blob.size && blob.size > 10 * 1024 * 1024) continue;
      if (typeof blob.sha !== "string" || !/^[0-9a-f]{40}$/.test(blob.sha)) continue;

      const targetPath = `${destDir}/${blob.path}`;
      if (validateWorkspacePath(targetPath)) continue;
      const ext = getExtension(blob.path);

      const blobResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/blobs/${blob.sha}`,
        {
          headers: {
            ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}),
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "octogee-workspace",
          },
        },
      );
      if (!blobResp.ok) continue;

      const blobData = (await blobResp.json()) as { content: string };

      if (isTextFile(blob.path)) {
        let sha: string | undefined;
        try {
          const existing = (await customerGiteaApi(req, `${workspaceRepo}/contents/${targetPath}`)) as { sha?: string };
          sha = existing.sha;
        } catch { /* ignore */ }

        await customerGiteaApi(req, `${workspaceRepo}/contents/${targetPath}`, "PUT", {
          message: `import: ${blob.path} from ${owner}/${repo}`,
          content: blobData.content,
          ...(sha ? { sha } : {}),
        });
      } else {
        const fileBuffer = Buffer.from(blobData.content, "base64");
        const gcsPath = `customers/${slug}/${targetPath}`;
        const bucket = storage.bucket();
        await bucket.file(gcsPath).save(fileBuffer, { metadata: { contentType: getMimeType(ext) } });
        manifestEntries[targetPath] = {
          type: "blob",
          gcsPath,
          size: fileBuffer.length,
          mimeType: getMimeType(ext),
          uploadedAt: new Date().toISOString(),
        };
      }
      fileCount++;
    }

    if (Object.keys(manifestEntries).length > 0) {
      await updateManifest(getCustomerGiteaToken(req), workspaceRepo, manifestEntries);
    }

    res.json({ success: true, targetDir: destDir, fileCount });
  } catch (e) {
    next(e);
  }
});

export default router;
