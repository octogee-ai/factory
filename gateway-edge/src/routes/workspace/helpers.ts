import type { Request, Response } from "express";
import { giteaApiAs } from "../../lib/gitea.js";
import { githubContentsApi } from "../../lib/github.js";
import type { FileTarget } from "../../lib/fileTarget.js";
import { validateFilePath } from "../../lib/path-validation.js";

export function getCustomerGiteaToken(req: Request): string {
  if (req.giteaToken) return req.giteaToken;
  throw new Error("Gitea access not configured for this user");
}

export function requireGiteaToken(req: Request, res: Response): string | null {
  if (req.giteaToken) return req.giteaToken;
  if (!res.headersSent) {
    res.status(422).json({
      error: "Workspace files unavailable",
      reason: "gitea_not_provisioned",
    });
  }
  return null;
}

export async function customerGiteaApi(
  req: Request,
  org: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  return giteaApiAs(getCustomerGiteaToken(req), org, path, method, body);
}

export async function repoContentsApi(
  req: Request,
  target: FileTarget,
  filePath: string,
): Promise<unknown> {
  if (target.provider === "github") {
    return githubContentsApi(target.org, target.repoName, filePath, process.env.GITHUB_TOKEN);
  }
  const apiPath = filePath
    ? `${target.repoName}/contents/${filePath}`
    : `${target.repoName}/contents`;
  return customerGiteaApi(req, target.org, apiPath);
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
