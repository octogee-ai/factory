

import path from "node:path";

const SPEC_PATTERNS: RegExp[] = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /^[ \t]*import\s+['"]([^'"\n]+)['"]/gm,
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function parseImportSpecifiers(src: string): string[] {
  const out = new Set<string>();
  const clean = stripComments(src);
  for (const re of SPEC_PATTERNS) {
    for (const m of clean.matchAll(re)) {
      if (m[1]) out.add(m[1]);
    }
  }
  return [...out];
}

function moduleKey(repoRelPath: string): string {
  return repoRelPath
    .split(path.sep)
    .join("/")
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")
    .replace(/\/index$/, "");
}

export function resolveSpecifier(
  specifier: string,
  fromFile: string,
): string | null {
  const from = fromFile.split(path.sep).join("/");

  if (specifier === "@shared" || specifier.startsWith("@shared/")) {
    const rest = specifier === "@shared" ? "" : specifier.slice("@shared/".length);
    return moduleKey(path.posix.join("shared", rest));
  }

  if (specifier.startsWith("@/")) {
    const parts = from.split("/");
    const srcIdx = parts.indexOf("src");
    if (srcIdx === -1) return null;
    const pkgSrc = parts.slice(0, srcIdx + 1).join("/"); 
    return moduleKey(path.posix.join(pkgSrc, specifier.slice(2)));
  }

  if (specifier.startsWith(".")) {
    return moduleKey(
      path.posix.join(path.posix.dirname(from), specifier),
    );
  }

  return null; 
}

export function computeTestedModules(
  testFiles: { path: string; content: string }[],
  sourceFiles: string[],
): Map<string, number> {
  const keyToSource = new Map<string, string>();
  for (const s of sourceFiles) keyToSource.set(moduleKey(s), s);

  const counts = new Map<string, number>();
  for (const s of sourceFiles) counts.set(s, 0);

  for (const tf of testFiles) {
    const hit = new Set<string>();
    for (const spec of parseImportSpecifiers(tf.content)) {
      const key = resolveSpecifier(spec, tf.path);
      if (key && keyToSource.has(key)) hit.add(keyToSource.get(key)!);
    }
    for (const src of hit) counts.set(src, (counts.get(src) ?? 0) + 1);
  }
  return counts;
}

export interface CoverageEntry {
  file: string;
  loc: number;
  churn: number;
  testRefs: number;
}

export function rankCoverageRisk(entries: CoverageEntry[]): CoverageEntry[] {
  return [...entries].sort((a, b) => {
    const au = a.testRefs === 0 ? 0 : 1;
    const bu = b.testRefs === 0 ? 0 : 1;
    if (au !== bu) return au - bu;
    if (b.churn !== a.churn) return b.churn - a.churn;
    return b.loc - a.loc;
  });
}
