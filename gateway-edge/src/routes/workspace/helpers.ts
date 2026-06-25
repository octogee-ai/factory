import type { Request, Response } from "express";
import { giteaApiAsUser } from "../../lib/gitea.js";
import { githubContentsApi } from "../../lib/github.js";
import type { FileTarget } from "../../lib/fileTarget.js";
import type { CommitAuthor } from "../../lib/workspace-git.js";
import { validateFilePath } from "../../lib/path-validation.js";

const FLAT_NOTE_RE = /^notes\/[^/]+\.md$/;

export function isBrokeredWritablePath(path: string, canvasFile: string | undefined): boolean {
  return FLAT_NOTE_RE.test(path) || path === (canvasFile || "README.md");
}

export function isTargetPathWritable(target: FileTarget, path: string): boolean {
  if (target.brokered) {
    return isBrokeredWritablePath(path, target.canvasFile);
  }
  return true;
}

export function resolveCommitAuthor(
  user: FirebaseFirestore.DocumentData | undefined,
  slug: string,
): CommitAuthor {
  const data = user as { displayName?: string; email?: string; username?: string } | undefined;
  const fallback = (data?.username || "").trim() || slug;
  const name = (data?.displayName || "").trim() || fallback;
  const email = (data?.email || "").trim() || `${fallback}@octogee.local`;
  return { name, email };
}

export function giteaSudoUser(target: FileTarget): string {
  if (!target.sudoUser) throw new Error("gitea target missing sudoUser");
  return target.sudoUser;
}

// Act on the gitea workspace/project repo AS the impersonated user (admin Sudo —
// Gitea enforces their ACL). Replaces the per-user PAT path.
export async function targetGiteaApi(
  target: FileTarget,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  return giteaApiAsUser(giteaSudoUser(target), target.org, path, method, body);
}

export async function repoContentsApi(
  target: FileTarget,
  filePath: string,
): Promise<unknown> {
  if (target.provider === "github") {
    return githubContentsApi(target.org, target.repoName, filePath, target.githubToken);
  }
  const apiPath = filePath
    ? `${target.repoName}/contents/${filePath}`
    : `${target.repoName}/contents`;
  return targetGiteaApi(target, apiPath);
}

export const HIDDEN = new Set([
  "AGENTS.md", "TOOLS.md", "BUILDS.md", "HEARTBEAT.md", "IDENTITY.md",
  ".gitignore",
  ".git", ".system", "preview", "node_modules",
  "crew-webhooks.json",
]);

export function pathHasReservedOrHiddenSegment(filePath: string): string | null {
  const parts = filePath.split("/");
  for (const p of parts) {
    if (p.length === 0) return "Path contains empty segment (trailing or leading slash)";
    if (HIDDEN.has(p)) return `Path contains reserved name: ${p}`;
    if (p.startsWith(".")) return `Path contains hidden segment: ${p}`;
  }
  return null;
}

export function validateWorkspacePath(filePath: string): string | null {
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  return pathHasReservedOrHiddenSegment(filePath);
}

export const EDITABLE_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".json", ".ts", ".tsx", ".js", ".jsx",
  ".html", ".css", ".yml", ".yaml", ".toml", ".env", ".sh", ".py", ".astro",
  ".xml", ".csv", ".sql", ".graphql", ".svelte", ".vue",
]);

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

export function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
    ".zip": "application/zip", ".csv": "text/csv",
  };
  return map[ext] ?? "application/octet-stream";
}

export function isTextFile(filename: string): boolean {
  return EDITABLE_EXTENSIONS.has(getExtension(filename));
}

export function ensureSlug(req: Request, res: Response): string | null {
  const slug = (req.query.slug as string) || req.body?.slug;
  if (!slug) {
    res.status(400).json({ error: "Missing slug" });
    return null;
  }
  if (req.workspaceSlug !== slug) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return slug;
}
