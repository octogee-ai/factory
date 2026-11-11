import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface PlatformBoundaryManifest {
  platformEntrypoints: string[];
  platformRoots: string[];
  productModules: string[];
  ratchet: string[];
  referenceRatchet: string[];
}

export interface ReferenceReport {
  references: string[];
  newViolations: string[];
  staleRatchet: string[];
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
const MANIFEST_PATH = "scripts/lib/platform-boundary.json";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

export function loadPlatformBoundaryManifest(repoRoot: string): PlatformBoundaryManifest {
  const path = join(repoRoot, MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as PlatformBoundaryManifest;
  for (const key of ["platformEntrypoints", "platformRoots", "productModules", "ratchet", "referenceRatchet"] as const) {
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
  return importsOfSource(readFileSync(file, "utf8"), file, repoRoot);
}

export function importsOfSource(source: string, file: string, repoRoot: string): string[] {
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

const TEST_PATH_RE = /(?:(?:^|\/)(?:__tests__|test-setup)\/)|(?:\.(?:spec|test)\.[cm]?[jt]sx?$)/u;
const TYPESCRIPT_RE = /\.(?:ts|tsx|mts)$/u;
const GIT_BINARY = "/usr/bin/git";
const NAME_CHARS = /[A-Za-z0-9_-]/u;

function startsOf(source: string, path: string): number[] {
  const starts: number[] = [];
  for (let index = source.indexOf(path); index >= 0; index = source.indexOf(path, index + 1)) starts.push(index);
  return starts;
}

function endsName(source: string, end: number): boolean {
  return !NAME_CHARS.test(source.charAt(end));
}

const VARIABLE_ROOT = /(?:\$\{\w+\}|\$\w+|\$\([^()]*\))\/$/u;

function startsPath(source: string, start: number, climbs = true): boolean {
  const before = source.charAt(start - 1);
  if (!NAME_CHARS.test(before) && before !== "." && before !== "/") return true;
  const head = source.slice(Math.max(0, start - 80), start);
  if (head.endsWith("../")) return climbs;
  return head.endsWith("./") || VARIABLE_ROOT.test(head);
}

function mentionsRepoPath(source: string, path: string): boolean {
  return startsOf(source, path).some((start) => startsPath(source, start) && endsName(source, start + path.length));
}

function mentionsRootPath(source: string, path: string): boolean {
  return startsOf(source, path).some((start) => startsPath(source, start, false) && source.charAt(start + path.length) === "/");
}

function mentionsRelativePath(source: string, path: string): boolean {
  return startsOf(source, path).some((start) => {
    const before = source.charAt(start - 1);
    return !NAME_CHARS.test(before) && before !== "." && source.slice(start - 3, start) !== "../"
      && endsName(source, start + path.length);
  });
}

export function productAssetEntries(manifest: PlatformBoundaryManifest): string[] {
  return manifest.productModules.filter((entry) => manifest.platformRoots.some((root) => entry.startsWith(root)));
}

export function platformFiles(manifest: PlatformBoundaryManifest, repoRoot: string): string[] {
  const listed = execFileSync(GIT_BINARY, ["ls-files", "-z", "--", ...manifest.platformRoots], { cwd: repoRoot, encoding: "utf8" });
  return listed
    .split("\0")
    .filter((file) => file.length > 0 && existsSync(join(repoRoot, file)))
    .filter((file) => file !== MANIFEST_PATH && !TEST_PATH_RE.test(file) && !isProductModule(file, manifest.productModules))
    .sort();
}

export function productReferencesOf(
  file: string,
  source: string,
  manifest: PlatformBoundaryManifest,
  repoRoot: string,
): string[] {
  const referenced = new Set<string>();
  for (const entry of productAssetEntries(manifest)) {
    const repoPath = entry.replace(/\/$/u, "");
    const fromFile = relative(dirname(file), repoPath);
    const sharedRoot = manifest.platformRoots.find((root) => file.startsWith(root) && entry.startsWith(root));
    const fromRoot = sharedRoot ? entry.slice(sharedRoot.length).replace(/\/$/u, "") : null;
    if (
      mentionsRepoPath(source, repoPath)
      || (fromFile.startsWith("../") && mentionsRelativePath(source, fromFile))
      || (fromRoot !== null && mentionsRootPath(source, fromRoot))
    ) {
      referenced.add(entry);
    }
  }
  if (TYPESCRIPT_RE.test(file)) {
    const root = realpathSync(repoRoot);
    for (const target of importsOfSource(source, join(root, file), repoRoot)) {
      const targetFile = relative(root, target);
      const entry = manifest.productModules.find((candidate) => isProductModule(targetFile, [candidate]));
      if (entry) referenced.add(entry);
    }
  }
  return [...referenced].sort();
}

export function platformReferenceReport(manifest: PlatformBoundaryManifest, repoRoot: string): ReferenceReport {
  const references: string[] = [];
  for (const file of platformFiles(manifest, repoRoot)) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    if (source.includes("\0")) continue;
    for (const entry of productReferencesOf(file, source, manifest, repoRoot)) references.push(`${file} -> ${entry}`);
  }
  const ratchet = new Set(manifest.referenceRatchet);
  const referenced = new Set(references);
  return {
    references,
    newViolations: references.filter((reference) => !ratchet.has(reference)),
    staleRatchet: manifest.referenceRatchet.filter((reference) => !referenced.has(reference)),
  };
}
