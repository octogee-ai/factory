/**
 * Octogee Provisioner — Idea Management
 */

import * as fs from "fs";
import * as path from "path";

/** Validate an idea slug (URL-safe: lowercase, hyphens, numbers only). */
export function validateIdeaSlug(slug: string): boolean {
  if (!slug || slug.length === 0) return false;
  if (slug.length > 60) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/** Check if an idea folder already exists for a customer. */
export function ideaExists(customerDir: string, slug: string): boolean {
  return fs.existsSync(path.join(customerDir, "ideas", slug));
}

/** Get list of all idea slugs for a customer. */
export function listIdeas(customerDir: string): string[] {
  const ideasDir = path.join(customerDir, "ideas");
  if (!fs.existsSync(ideasDir)) return [];
  return fs.readdirSync(ideasDir).filter((entry) => {
    try {
      return fs.statSync(path.join(ideasDir, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}
