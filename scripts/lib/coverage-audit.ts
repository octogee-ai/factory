/**
 * Coverage-risk audit core. Judges test coverage by *test files that
 * import a module*, across BOTH `*.spec.ts` and `*.test.ts`, resolving
 * relative specifiers to real source paths.
 *
 * Motivation: a `<module>.spec.ts` filename glob falsely flagged heavily
 * tested modules as "no coverage" three times in one session (proxy.ts,
 * glm-controller, functions/ — the last uses `*.test.ts`). Never infer
 * coverage from a filename again; this is the single source of that call.
 *
 * Pure + dependency-free so the CLI (`scripts/audit-coverage.ts`) stays a
 * thin fs/git shell. Per repo policy `scripts/` carries no test gate;
 * self-verify by running it (it must NOT flag proxy.ts / orchestrator
 * assign as uncovered).
 */
import path from "node:path";

// Four simple, linear (no nested quantifier → no backtracking) regexes
// instead of one mega-alternation: `… from "x"`, `import("x")`,
// `require("x")`, and bare `import "x"`. Each is well under the
// regex-complexity bar and DoS-safe.
// `[^'"\n]` (not `[^'"]`) bounds each match to a single line: a module
// specifier never spans lines, and excluding \n keeps every pattern
// provably linear (no cross-line backtracking).
const SPEC_PATTERNS: RegExp[] = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /^[ \t]*import\s+['"]([^'"\n]+)['"]/gm,
];

/** Strip line + block comments so commented-out imports don't count. */
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

/** Repo-relative POSIX path, extension stripped — the comparison key. */
function moduleKey(repoRelPath: string): string {
  return repoRelPath
    .split(path.sep)
    .join("/")
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")
    .replace(/\/index$/, "");
}

/**
 * Resolve an import in `fromFile` to a source `moduleKey`, or null for
 * bare/package specifiers. Handles relative (`./`, `../`) AND the repo's
 * path aliases — `@/` → the importer's `<pkg>/src/`, `@shared` → repo
 * `shared/`. Alias support is load-bearing: app/ imports its own modules
 * via `@/`, so ignoring aliases re-creates the very false-negative this
 * tool exists to kill (e.g. AppShellConnected's `@/`-importing spec).
 * Extension-insensitive (`.js` → `.ts`) and index-aware.
 */
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
    const pkgSrc = parts.slice(0, srcIdx + 1).join("/"); // e.g. app/src
    return moduleKey(path.posix.join(pkgSrc, specifier.slice(2)));
  }

  if (specifier.startsWith(".")) {
    return moduleKey(
      path.posix.join(path.posix.dirname(from), specifier),
    );
  }

  return null; // bare package specifier
}

/**
 * Map every source file → number of distinct test files that import it.
 * 0 means genuinely uncovered (no test references it under ANY name).
 */
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

/** Uncovered first, then churn desc, then loc desc — the work order. */
export function rankCoverageRisk(entries: CoverageEntry[]): CoverageEntry[] {
  return [...entries].sort((a, b) => {
    const au = a.testRefs === 0 ? 0 : 1;
    const bu = b.testRefs === 0 ? 0 : 1;
    if (au !== bu) return au - bu;
    if (b.churn !== a.churn) return b.churn - a.churn;
    return b.loc - a.loc;
  });
}
