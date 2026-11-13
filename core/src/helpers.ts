import * as fs from "fs";
import * as path from "path";
import { uniqueNamesGenerator, adjectives, animals } from "unique-names-generator";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

export function generatePersonalSlug(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: "-",
    style: "lowerCase",
    length: 2,
  });
}

export function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

export function applyTemplatePlaceholders(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

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
