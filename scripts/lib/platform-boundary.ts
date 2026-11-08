import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface PlatformBoundaryManifest {
  platformEntrypoints: string[];
  productModules: string[];
  ratchet: string[];
}

export interface BoundaryReport {
  reached: string[];
  newViolations: string[];
  staleRatchet: string[];
}

const SPECIFIER_RES = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

export function loadPlatformBoundaryManifest(repoRoot: string): PlatformBoundaryManifest {
  const path = join(repoRoot, "scripts/lib/platform-boundary.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as PlatformBoundaryManifest;
  for (const key of ["platformEntrypoints", "productModules", "ratchet"] as const) {
    if (!Array.isArray(manifest[key])) throw new Error(`platform-boundary.json ${key} must be an array`);
  }
  return manifest;
}

export function isProductModule(file: string, productModules: readonly string[]): boolean {
  return productModules.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

function findSourceFile(candidate: string): string | null {
  for (const ext of SOURCE_EXTENSIONS) {
    if (candidate.endsWith(ext) && existsSync(candidate)) return candidate;
  }
  const stripped = candidate.replace(/\.(js|mjs|cjs)$/u, "");
  for (const ext of SOURCE_EXTENSIONS) {
    if (existsSync(stripped + ext)) return stripped + ext;
  }
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    for (const ext of SOURCE_EXTENSIONS) {
      if (existsSync(join(candidate, `index${ext}`))) return join(candidate, `index${ext}`);
    }
  }
  return null;
}

function resolveSourceFile(candidate: string): string | null {
  const found = findSourceFile(candidate);
  return found ? realpathSync(found) : null;
}

export function resolveImport(specifier: string, fromFile: string, repoRoot: string): string | null {
  if (specifier.startsWith(".")) return resolveSourceFile(resolve(dirname(fromFile), specifier));
  if (specifier.startsWith("@octogee/core/")) {
    return resolveSourceFile(join(repoRoot, "core/src", specifier.slice("@octogee/core/".length)));
  }
  if (specifier.startsWith("@octogee/shared/")) {
    return resolveSourceFile(join(repoRoot, "shared", specifier.slice("@octogee/shared/".length)));
  }
  if (specifier.startsWith("@shared/")) {
    return resolveSourceFile(join(repoRoot, "shared", specifier.slice("@shared/".length)));
  }
  if (specifier.startsWith("@/")) {
    const pkg = relative(realpathSync(repoRoot), fromFile).split("/")[0];
    return resolveSourceFile(join(repoRoot, pkg, "src", specifier.slice(2)));
  }
  return null;
}

export function importsOf(file: string, repoRoot: string): string[] {
  const source = readFileSync(file, "utf8");
  const targets = new Set<string>();
  for (const pattern of SPECIFIER_RES) {
    for (const match of source.matchAll(pattern)) {
      const resolved = resolveImport(match[1]!, file, repoRoot);
      if (resolved) targets.add(resolved);
    }
  }
  return [...targets];
}

export function reachableSources(entrypoints: readonly string[], repoRoot: string): Set<string> {
  const root = realpathSync(repoRoot);
  const seen = new Set<string>();
  for (const entry of entrypoints) {
    if (!existsSync(join(root, entry))) throw new Error(`platform entrypoint does not exist: ${entry}`);
  }
  const queue = entrypoints.map((entry) => realpathSync(join(root, entry)));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const target of importsOf(file, repoRoot)) {
      if (!seen.has(target)) queue.push(target);
    }
  }
  return new Set([...seen].map((file) => relative(root, file)));
}

export function platformBoundaryReport(manifest: PlatformBoundaryManifest, repoRoot: string): BoundaryReport {
  const reached = [...reachableSources(manifest.platformEntrypoints, repoRoot)]
    .filter((file) => isProductModule(file, manifest.productModules))
    .sort();
  const ratchet = new Set(manifest.ratchet);
  const reachedSet = new Set(reached);
  return {
    reached,
    newViolations: reached.filter((file) => !ratchet.has(file)),
    staleRatchet: manifest.ratchet.filter((file) => !reachedSet.has(file)),
  };
}
