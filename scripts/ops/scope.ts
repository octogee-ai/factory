// CI scope CLI: diff the push/PR, resolve the test jobs it needs, emit
// $GITHUB_OUTPUT. Pure resolution + serialization live in lib/scope (tested);
// this is the git/env glue. Fail-open on any diff trouble — never under-test.
//
//   tsx ops/scope.ts --base <sha> [--head <sha>]
//
// base is the PR base sha (pull_request) or the push's `before` sha. We diff
// from merge-base(base, head) so both PR and push report only their own changes.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  resolveScope,
  toGhaOutputs,
  serializeGhaOutputs,
  type ScopeResult,
} from "../lib/scope/resolve.js";
import { ALL_JOBS } from "../lib/scope/manifest.js";

export const NULL_SHA = "0000000000000000000000000000000000000000";
const GIT_BIN = "/usr/bin/git";

type ExecFileString = (file: string, args: string[], options: { encoding: "utf8" }) => string;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function everything(reason: string): ScopeResult {
  return { jobs: [...ALL_JOBS], everything: true, reasons: [reason] };
}

export function resolveScopeCli(
  argv: string[],
  execFile: ExecFileString = execFileSync,
): ScopeResult {
  const base = arg(argv, "base");
  const head = arg(argv, "head") ?? "HEAD";
  if (!base || base === NULL_SHA) {
    return everything(`no usable diff base (base=${base ?? "unset"})`);
  }
  try {
    const forkPoint = execFile(GIT_BIN, ["merge-base", base, head], {
      encoding: "utf8",
    }).trim();
    const files = execFile(GIT_BIN, ["diff", "--name-only", forkPoint, head], {
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return resolveScope(files);
  } catch (err) {
    return everything(`git diff failed: ${(err as Error).message}`);
  }
}

export function scopeSummary(result: ScopeResult): string {
  const trigger =
    result.reasons.find(
    (r) => r.startsWith("global:") || r.startsWith("unmapped:") || r.startsWith("no usable") || r.startsWith("git diff failed"),
  ) ?? result.reasons[0];
  return result.everything
    ? `scope: EVERYTHING (${trigger})`
    : `scope: ${result.jobs.length ? result.jobs.join(", ") : "nothing"}`;
}

function main(argv: string[] = process.argv.slice(2)): void {
  const result = resolveScopeCli(argv);
  const outputs = toGhaOutputs(result);
  const summary = scopeSummary(result);
  console.error(summary);

  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    appendFileSync(ghOut, serializeGhaOutputs(outputs) + "\n");
  } else {
    console.log(JSON.stringify(outputs, null, 2));
  }

  const ghSummary = process.env.GITHUB_STEP_SUMMARY;
  if (ghSummary) {
    appendFileSync(ghSummary, `### Test scope\n\n${summary}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
