// Single source of truth for which repo paths map to which CI test jobs.
// Consumed by resolve.ts, the local runner, and (Phase 2) Cloud Build gating.

// Job-key registry: the literal lives once here, referenced everywhere else.
export const JOBS = {
  gatewayEdge: "gateway-edge",
  octogeeApi: "octogee-api",
  glmController: "glm-controller",
  tests: "tests",
  acceptance: "acceptance",
  scripts: "scripts",
  core: "core",
  shared: "shared",
  testHelpers: "test-helpers",
  octogeeChatTools: "octogee-chat-tools",
  octogeePublishTools: "octogee-publish-tools",
  octogeeConnectorTools: "octogee-connector-tools",
  functions: "functions",
  site: "site",
  app: "app",
  firestoreRules: "firestore-rules",
  customerLifecycleEmulator: "customer-lifecycle-emulator",
  functionsEmulator: "functions-emulator",
  gatewayEdgeEmulator: "gateway-edge-emulator",
  octogeeApiEmulator: "octogee-api-emulator",
} as const;

export type JobKey = (typeof JOBS)[keyof typeof JOBS];

const TYPECHECK = "npm run typecheck";

export interface UnitPackage {
  name: JobKey;
  dir: string;
  typecheck: string;
}

// The dynamic `test` matrix entries. `typecheck` runs after `npm ci`, before `npm test`.
export const UNIT_PACKAGES: readonly UnitPackage[] = [
  // core ships a committed tarball (octogee-core.tgz); verify:tarball fails if it
  // drifts from a fresh build of core/src (npm can't build a file: dependency).
  {
    name: JOBS.core,
    dir: "core",
    typecheck: "npm run typecheck && npm run verify:tarball",
  },
  // shared ships a committed tarball (octogee-shared.tgz) too; same guard. A shared/
  // change still fails open to every consumer (it's the type substrate); this entry
  // just makes the shared job exist so its freshness + lock guard runs in CI.
  {
    name: JOBS.shared,
    dir: "shared",
    typecheck: "npm run typecheck && npm run verify:tarball",
  },
  // test-helpers ships a committed tarball (octogee-test-helpers.tgz) too — shared
  // test infra (firestore-emulator) for the emulator suites. Same freshness + lock guard.
  {
    name: JOBS.testHelpers,
    dir: "test-helpers",
    typecheck: "npm run typecheck && npm run verify:tarball",
  },
  { name: JOBS.gatewayEdge, dir: "gateway-edge", typecheck: TYPECHECK },
  { name: JOBS.octogeeApi, dir: "octogee-api", typecheck: TYPECHECK },
  { name: JOBS.glmController, dir: "glm-controller", typecheck: TYPECHECK },
  { name: JOBS.tests, dir: "tests", typecheck: TYPECHECK },
  { name: JOBS.acceptance, dir: "acceptance", typecheck: TYPECHECK },
  { name: JOBS.scripts, dir: "scripts", typecheck: "npx tsc --noEmit" },
  {
    name: JOBS.octogeeChatTools,
    dir: "infra/gateway/extensions/octogee-chat-tools",
    typecheck: 'echo "octogee-chat-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeePublishTools,
    dir: "infra/gateway/extensions/octogee-publish-tools",
    typecheck: 'echo "octogee-publish-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeConnectorTools,
    dir: "infra/gateway/extensions/octogee-connector-tools",
    typecheck: 'echo "octogee-connector-tools — no tsconfig; vitest is the gate"',
  },
  { name: JOBS.functions, dir: "functions", typecheck: TYPECHECK },
  { name: JOBS.site, dir: "site", typecheck: TYPECHECK },
] as const;

// Jobs that JDK/emulator or sharding force out of the matrix; each gated by its own flag.
export const STANDALONE_JOBS: readonly JobKey[] = [
  JOBS.app,
  JOBS.firestoreRules,
  JOBS.customerLifecycleEmulator,
  JOBS.functionsEmulator,
  JOBS.gatewayEdgeEmulator,
  JOBS.octogeeApiEmulator,
] as const;

export const ALL_JOBS: readonly JobKey[] = [
  ...UNIT_PACKAGES.map((p) => p.name),
  ...STANDALONE_JOBS,
];

export interface Ownership {
  dir: string;
  jobs: readonly JobKey[];
}

// dir-prefix → owned jobs. Resolution picks the LONGEST match.
export const OWNERSHIP: readonly Ownership[] = [
  { dir: "core/", jobs: [JOBS.core] },
  { dir: "test-helpers/", jobs: [JOBS.testHelpers] },
  { dir: "gateway-edge/", jobs: [JOBS.gatewayEdge, JOBS.gatewayEdgeEmulator] },
  { dir: "octogee-api/", jobs: [JOBS.octogeeApi, JOBS.octogeeApiEmulator] },
  { dir: "glm-controller/", jobs: [JOBS.glmController] },
  { dir: "tests/", jobs: [JOBS.tests] },
  { dir: "acceptance/", jobs: [JOBS.acceptance] },
  { dir: "scripts/", jobs: [JOBS.scripts, JOBS.customerLifecycleEmulator] },
  {
    dir: "infra/gateway/extensions/octogee-chat-tools/",
    jobs: [JOBS.octogeeChatTools],
  },
  {
    dir: "infra/gateway/extensions/octogee-publish-tools/",
    jobs: [JOBS.octogeePublishTools],
  },
  {
    dir: "infra/gateway/extensions/octogee-connector-tools/",
    jobs: [JOBS.octogeeConnectorTools],
  },
  { dir: "functions/", jobs: [JOBS.functions, JOBS.functionsEmulator] },
  { dir: "site/", jobs: [JOBS.site] },
  { dir: "app/", jobs: [JOBS.app] },
  { dir: "firestore-rules-tests/", jobs: [JOBS.firestoreRules] },
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
    when: "core/",
    jobs: [
      JOBS.scripts,
      JOBS.customerLifecycleEmulator,
      JOBS.octogeeApi,
      JOBS.octogeeApiEmulator,
      JOBS.gatewayEdge,
      JOBS.gatewayEdgeEmulator,
      JOBS.glmController,
    ],
    reason:
      "@octogee/core is consumed by scripts + octogee-api (via scripts/lib re-export shims) + gateway-edge + glm-controller (direct package import)",
  },
  {
    when: "test-helpers/",
    jobs: [
      JOBS.gatewayEdge,
      JOBS.gatewayEdgeEmulator,
      JOBS.octogeeApi,
      JOBS.octogeeApiEmulator,
      JOBS.functions,
      JOBS.functionsEmulator,
    ],
    reason:
      "@octogee/test-helpers (firestore-emulator) is consumed by the gateway-edge + octogee-api + functions emulator specs",
  },
  {
    when: "gateway-edge/src/",
    jobs: [JOBS.octogeeApi, JOBS.octogeeApiEmulator],
    reason:
      "octogee-api compiles gateway-edge route Routers (cross-package imports) and its emulator specs mount them via createApp()",
  },
  {
    when: "site/firestore.rules",
    jobs: [JOBS.firestoreRules],
    reason: "the rules file lives under site/ but gates the firestore-rules suite",
  },
  {
    when: "site/firestore.indexes.json",
    jobs: [JOBS.firestoreRules],
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
