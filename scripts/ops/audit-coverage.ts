

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  computeTestedModules,
  rankCoverageRisk,
  type CoverageEntry,
} from "../lib/coverage-audit.js";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".claude",
  "coverage",
  "build",
  ".next",
  "out",
  "tmp",
]);
const TEST_RE = /\.(spec|test)\.(ts|tsx)$/;
const SRC_RE = /\.(ts|tsx)$/;
const isDecl = (f: string) => f.endsWith(".d.ts");

export function walk(root: string, repoRoot: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (SRC_RE.test(e.name) && !isDecl(e.name)) {
        out.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    }
  }
  return out;
}

export function churnByFile(sinceArg: string, repoRoot: string): Map<string, number> {
  const since = /^\d+d$/.test(sinceArg)
    ? `${sinceArg.slice(0, -1)} days ago`
    : sinceArg;
  let raw = "";
  try {
    const gitArgs = ["log", `--since=${since}`, "--name-only", "--pretty=format:"];
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- 'git' is a trusted dev tool; local audit script, no prod surface (scripts/ is operator-risk-accepted)
    raw = execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return new Map();
  }
  const counts = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const f = line.trim();
    if (f && SRC_RE.test(f) && !TEST_RE.test(f)) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return counts;
}

function main(): void {
  const argv = process.argv.slice(2);
  const opt = (name: string, def: string): string =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? def;
  const since = opt("since", "120d");
  const top = parseInt(opt("top", "25"), 10);
  const prefixes = argv.filter((a) => !a.startsWith("--"));

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- 'git' is a trusted dev tool; local audit script, no prod surface (scripts/ is operator-risk-accepted)
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

  const all = walk(repoRoot, repoRoot).filter((f) =>
    f.includes("/.claude/worktrees/") ? false : true,
  );
  const scoped =
    prefixes.length > 0
      ? all.filter((f) => prefixes.some((p) => f.startsWith(p)))
      : all;

  const sourceFiles = scoped.filter((f) => !TEST_RE.test(f));
  const testFiles = scoped
    .filter((f) => TEST_RE.test(f))
    .map((f) => ({
      path: f,
      content: (() => {
        try {
          return fs.readFileSync(path.join(repoRoot, f), "utf8");
        } catch {
          return "";
        }
      })(),
    }));

  const tested = computeTestedModules(testFiles, sourceFiles);
  const churn = churnByFile(since, repoRoot);

  const entries: CoverageEntry[] = sourceFiles.map((f) => {
    let loc = 0;
    try {
      loc = fs.readFileSync(path.join(repoRoot, f), "utf8").split("\n").length;
    } catch {
      /* unreadable — loc stays 0 */
    }
    return {
      file: f,
      loc,
      churn: churn.get(f) ?? 0,
      testRefs: tested.get(f) ?? 0,
    };
  });

  const ranked = rankCoverageRisk(entries);
  const uncovered = ranked.filter((e) => e.testRefs === 0);
  const hotUncovered = uncovered.filter((e) => e.churn > 0).slice(0, top);
  const scope = prefixes.length ? ` [${prefixes.join(", ")}]` : "";

  console.log(
    `\nCoverage-risk audit — ${sourceFiles.length} source files, ` +
      `${testFiles.length} test files (.spec.ts + .test.ts), since=${since}` +
      `${scope}\n`,
  );
  console.log(
    `${uncovered.length} modules have NO test importing them ` +
      `(${uncovered.length - hotUncovered.length} of them with zero ${since} churn — likely dead/stable).\n`,
  );
  console.log(`Top ${hotUncovered.length} churn-no-coverage (the work order):`);
  console.log("  churn  loc   file");
  for (const e of hotUncovered) {
    console.log(
      `  ${String(e.churn).padStart(5)}  ${String(e.loc).padStart(4)}  ${e.file}`,
    );
  }
  console.log(
    "\nNote: coverage = a test file *imports* the module (spec OR test " +
      "suffix; relative + @/ + @shared aliases resolved). A missing " +
      "`<module>.spec.ts` is NOT a gap. Caveat: integration suites that " +
      "import an app/server entrypoint exercise routes transitively — a " +
      "flagged route (e.g. an express route module) may still be covered " +
      "by an app-level integration test. Use this as the work order, then " +
      "confirm the top candidate has no transitive net before investing.\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
