import type { Request, Response } from "express";
import { giteaApiAs } from "../../lib/gitea";
import { validateFilePath } from "../../lib/path-validation";

export function getCustomerGiteaToken(req: Request): string {
  if (req.giteaToken) return req.giteaToken;
  throw new Error("Gitea access not configured for this user");
}

export async function customerGiteaApi(
  req: Request,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  return giteaApiAs(getCustomerGiteaToken(req), path, method, body);
}

export const HIDDEN = new Set([
  "AGENTS.md", "TOOLS.md", "BUILDS.md", "HEARTBEAT.md", "IDENTITY.md",
  "_throttle.json", "customer-config.json", ".gitignore",
  "brain", ".git", ".system", "preview", "node_modules",
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
  if (req.user?.username !== slug) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return slug;
}
