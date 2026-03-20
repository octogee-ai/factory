/**
 * Octogee Provisioner — Pure Helper Functions
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { uniqueNamesGenerator, adjectives, animals } from "unique-names-generator";
import { DATA_API_URL } from "./config.js";
import { db } from "./firebase.js";

// ── Slugify ─────────────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

/**
 * Generate a memorable, neutral two-word slug for Personal tier workspaces.
 * e.g. "swift-harbor", "bold-cedar", "calm-river"
 */
export function generatePersonalSlug(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: "-",
    style: "lowerCase",
    length: 2,
  });
}

// ── Data API Key ────────────────────────────────────────────────────────────────

export async function generateDataApiKey(uid: string): Promise<string> {
  const apiKey = crypto.randomBytes(32).toString("hex");
  await db.doc(`users/${uid}/settings/api`).set({
    apiKey,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return apiKey;
}

// ── Directory Copy ──────────────────────────────────────────────────────────────

export function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
  }
}

// ── Template Helpers ────────────────────────────────────────────────────────────

/** Apply common {{placeholder}} replacements to a template string. */
export function applyTemplatePlaceholders(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

/**
 * Read a tier-based template file, falling back to the old non-tier template.
 * Tries: {baseName}.{tierSuffix}.template → {baseName}.template
 */
export function readTierTemplate(
  baseName: string,
  tierSuffix: string,
  dir: string,
  vars: Record<string, string>,
): string | null {
  const tierPath = path.join(dir, `${baseName}.${tierSuffix}.template`);
  if (fs.existsSync(tierPath)) {
    return applyTemplatePlaceholders(fs.readFileSync(tierPath, "utf-8"), vars);
  }
  const fallbackPath = path.join(dir, `${baseName}.template`);
  if (fs.existsSync(fallbackPath)) {
    return applyTemplatePlaceholders(fs.readFileSync(fallbackPath, "utf-8"), vars);
  }
  return null;
}

/** Map subscription tier to template suffix. Starter/free → "starter", everything else → "pro". */
export function getTierSuffix(tier: string): "starter" | "pro" {
  return (tier === "starter" || tier === "free") ? "starter" : "pro";
}

// ── Business Type → Website Template ────────────────────────────────────────────

export const BUSINESS_TYPE_TEMPLATES: Record<string, string> = {
  "salon":        "hair-salon",
  "hair-salon":   "hair-salon",
  "barbershop":   "hair-salon",
  "landscaping":  "landscaping",
  "lawn-care":    "landscaping",
  "cleaning":     "home-services",
  "handyman":     "home-services",
  "plumbing":     "home-services",
  "electrical":   "home-services",
  "fitness":      "fitness",
  "gym":          "fitness",
  "photography":  "photography",
  "restaurant":   "restaurant",
  "cafe":         "restaurant",
  "bakery":       "restaurant",
  "auto":         "auto-repair",
  "pet-grooming": "pet-services",
  "dog-walking":  "pet-services",
  "realestate":   "general",
  "other":        "general",
};

export function getTemplateForBusinessType(businessType: string): string {
  if (!businessType) return "general";
  const normalized = businessType.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-");
  return BUSINESS_TYPE_TEMPLATES[normalized] ?? "general";
}

// ── MIME Types ──────────────────────────────────────────────────────────────────

export const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
};
