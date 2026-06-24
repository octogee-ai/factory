// Single source of truth for which repo paths map to which CI test jobs.
// Consumed by resolve.ts, the local runner, and (Phase 2) Cloud Build gating.

export type JobKey =
  | "gateway-edge"
  | "octogee-api"
  | "tests"
  | "acceptance"
  | "scripts"
  | "octogee-router"
  | "functions"
  | "site"
  | "renderer"
  | "app"
  | "firestore-rules"
  | "customer-lifecycle-emulator"
  | "functions-emulator"
  | "gateway-edge-emulator";

export interface UnitPackage {
  name: JobKey;
  dir: string;
  typecheck: string;
}

// The dynamic `test` matrix entries. `typecheck` runs after `npm ci`, before `npm test`.
export const UNIT_PACKAGES: readonly UnitPackage[] = [
  { name: "gateway-edge", dir: "gateway-edge", typecheck: "npm run typecheck" },
  { name: "octogee-api", dir: "octogee-api", typecheck: "npm run typecheck" },
  { name: "tests", dir: "tests", typecheck: "npm run typecheck" },
  { name: "acceptance", dir: "acceptance", typecheck: "npm run typecheck" },
  { name: "scripts", dir: "scripts", typecheck: "npx tsc --noEmit" },
  {
    name: "octogee-router",
    dir: "infra/gateway/extensions/octogee-router",
    typecheck: 'echo "octogee-router — no tsconfig; vitest is the gate"',
  },
  { name: "functions", dir: "functions", typecheck: "npm run typecheck" },
  { name: "site", dir: "site", typecheck: "npm run typecheck" },
  { name: "renderer", dir: "renderer", typecheck: "npm run typecheck" },
] as const;

// Jobs that JDK/emulator or sharding force out of the matrix; each gated by its own flag.
export const STANDALONE_JOBS: readonly JobKey[] = [
  "app",
  "firestore-rules",
  "customer-lifecycle-emulator",
  "functions-emulator",
  "gateway-edge-emulator",
] as const;

export const ALL_JOBS: readonly JobKey[] = [
  ...UNIT_PACKAGES.map((p) => p.name),
  ...STANDALONE_JOBS,
];

export interface Ownership {
  dir: string;
  jobs: readonly JobKey[];
}

// dir-prefix → owned jobs. Resolution picks the LONGEST match so the nested
// octogee-router dir wins over any shorter rule instead of failing open.
export const OWNERSHIP: readonly Ownership[] = [
  { dir: "gateway-edge/", jobs: ["gateway-edge", "gateway-edge-emulator"] },
  { dir: "octogee-api/", jobs: ["octogee-api"] },
  { dir: "tests/", jobs: ["tests"] },
  { dir: "acceptance/", jobs: ["acceptance"] },
  { dir: "scripts/", jobs: ["scripts", "customer-lifecycle-emulator"] },
  { dir: "infra/gateway/extensions/octogee-router/", jobs: ["octogee-router"] },
  { dir: "functions/", jobs: ["functions", "functions-emulator"] },
  { dir: "site/", jobs: ["site"] },
  { dir: "renderer/", jobs: ["renderer"] },
  { dir: "app/", jobs: ["app"] },
  { dir: "firestore-rules-tests/", jobs: ["firestore-rules"] },
];

export interface ScopeEdge {
  when: string;
  jobs: readonly JobKey[];
  reason: string;
}

// Cross-package edges, additive on top of ownership. The correctness hazards —
// each pinned by a test in scope-resolve.spec.ts.
export const EDGES: readonly ScopeEdge[] = [
  {
    when: "scripts/lib/",
    jobs: ["octogee-api", "gateway-edge", "gateway-edge-emulator"],
    reason:
      "octogee-api + gateway-edge compile scripts/lib via their tsconfig include (admin-fleet-router hazard)",
  },
  {
    when: "gateway-edge/src/",
    jobs: ["octogee-api"],
    reason: "octogee-api compiles gateway-edge route Routers (cross-package imports)",
  },
  {
    when: "site/firestore.rules",
    jobs: ["firestore-rules"],
    reason: "the rules file lives under site/ but gates the firestore-rules suite",
  },
  {
    when: "site/firestore.indexes.json",
    jobs: ["firestore-rules"],
    reason: "index shape drives rules-test expectations",
  },
];

// Repo-wide blast radius → run everything. Exact root-file names (so app/package.json
// does NOT match) plus prefixes for the type substrate and the resolver itself.
export const GLOBAL_EXACT: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.base.json",
  ".github/workflows/test.yml",
]);
export const GLOBAL_PREFIX: readonly string[] = ["shared/", "scripts/lib/scope/"];

// Inert → run nothing: docs and root-level markdown only. A *.md under a package
// dir (e.g. site content) still falls to that package, never inert.
export function isInert(path: string): boolean {
  if (path.startsWith("docs/")) return true;
  if (/^[^/]+\.md$/.test(path)) return true;
  return false;
}
