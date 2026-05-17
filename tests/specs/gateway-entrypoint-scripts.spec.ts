import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import path from "path";

/**
 * Invariant: every top-level script `infra/gateway/entrypoint.sh` runs must
 * actually ship in the gateway image. The Dockerfile copies entry scripts
 * one-by-one (plus `scripts/lib/` recursively); a script wired into the
 * entrypoint but never added to a `COPY` is a build-passing, CI-passing,
 * boot-time `ERR_MODULE_NOT_FOUND` crash-loop (cf. #962's
 * byosub-syncback-runner.ts). No image build/boot needed to catch it —
 * this is the static entrypoint↔Dockerfile coverage check.
 */
const repoRoot = path.resolve(__dirname, "../..");
const entrypoint = readFileSync(
  path.join(repoRoot, "infra/gateway/entrypoint.sh"),
  "utf8",
);
const dockerfile = readFileSync(
  path.join(repoRoot, "infra/gateway/Dockerfile"),
  "utf8",
);

// Scripts the entrypoint actually invokes from the image, e.g.
// `… tsx /octogee/scripts/pre-boot-config.ts`. `.bin/tsx` itself has no
// .ts/.mjs/.js extension so it is not matched; node_modules are npm-
// installed in-image (RUN npm install), not COPYed, so they're excluded.
function entrypointScripts(): string[] {
  const re = /\/octogee\/scripts\/([A-Za-z0-9_.\-/]+\.(?:ts|mjs|js))\b/g;
  const out = new Set<string>();
  for (const m of entrypoint.matchAll(re)) {
    const rel = `scripts/${m[1]}`;
    if (!rel.startsWith("scripts/node_modules/")) out.add(rel);
  }
  return [...out].sort();
}

// What the Dockerfile stages into the image: explicit file COPYs +
// directory-prefix COPYs (e.g. `COPY scripts/lib/ /octogee/scripts/lib/`).
function dockerCoverage(): { files: Set<string>; dirs: string[] } {
  const files = new Set<string>();
  const dirs: string[] = [];
  for (const line of dockerfile.split("\n")) {
    if (!/^\s*COPY\b/.test(line) || !line.includes("/octogee/scripts")) continue;
    const before = line.slice(0, line.indexOf("/octogee/scripts"));
    for (const tok of before.match(/\bscripts\/[A-Za-z0-9_.\-/]+/g) ?? []) {
      if (tok.endsWith("/")) dirs.push(tok);
      else files.add(tok.replace(/\*$/, ""));
    }
  }
  return { files, dirs };
}

const { files, dirs } = dockerCoverage();
const covered = (p: string) =>
  files.has(p) ||
  dirs.some((d) => p.startsWith(d)) ||
  p.startsWith("scripts/node_modules/");

describe("gateway entrypoint ↔ Dockerfile coverage", () => {
  it("finds the entry scripts (sanity — regex still matches)", () => {
    expect(entrypointScripts().length).toBeGreaterThan(0);
  });

  it("every script the entrypoint runs is COPYed into the gateway image", () => {
    const uncovered = entrypointScripts().filter((p) => !covered(p));
    expect(
      uncovered,
      `entrypoint.sh runs these but infra/gateway/Dockerfile never COPYs them ` +
        `→ ERR_MODULE_NOT_FOUND crash-loop at boot: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("every script the entrypoint runs exists in the repo (no typo)", () => {
    const missing = entrypointScripts().filter(
      (p) => !existsSync(path.join(repoRoot, p)),
    );
    expect(missing, `entrypoint.sh references nonexistent scripts: ${missing.join(", ")}`).toEqual([]);
  });
});
