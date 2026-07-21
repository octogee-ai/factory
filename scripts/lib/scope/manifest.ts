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
  octogeeAccessTools: "octogee-access-tools",
  octogeePublishTools: "octogee-publish-tools",
  octogeeConnectorTools: "octogee-connector-tools",
  octogeeProjectTools: "octogee-project-tools",
  octogeeWebTools: "octogee-web-tools",
  octogeeOpsTools: "octogee-ops-tools",
  opsAgent: "ops-agent",
  opsAgentRuntimeTools: "ops-agent-runtime-tools",
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
const COMMITTED_DIST_TYPECHECK =
  "npm run typecheck && npm run build && node ../scripts/ops/verify-committed-dist.mjs";

export interface UnitPackage {
  name: JobKey;
  dir: string;
  typecheck: string;
  nodeVersion?: number;
}

// The dynamic `test` matrix entries. `typecheck` runs after `npm ci`, before `npm test`.
export const UNIT_PACKAGES: readonly UnitPackage[] = [
  {
    name: JOBS.core,
    dir: "core",
    typecheck: COMMITTED_DIST_TYPECHECK,
  },
  {
    name: JOBS.shared,
    dir: "shared",
    typecheck: COMMITTED_DIST_TYPECHECK,
  },
  {
    name: JOBS.testHelpers,
    dir: "test-helpers",
    typecheck: COMMITTED_DIST_TYPECHECK,
  },
  { name: JOBS.gatewayEdge, dir: "gateway-edge", typecheck: TYPECHECK },
  { name: JOBS.octogeeApi, dir: "octogee-api", typecheck: TYPECHECK },
  { name: JOBS.glmController, dir: "glm-controller", typecheck: TYPECHECK },
  { name: JOBS.opsAgent, dir: "ops-agent", typecheck: TYPECHECK, nodeVersion: 24 },
  {
    name: JOBS.opsAgentRuntimeTools,
    dir: "ops-agent/extensions/octogee-ops-runtime-tools",
    typecheck: 'echo "ops-agent-runtime-tools — no tsconfig; vitest is the gate"',
    nodeVersion: 24,
  },
  { name: JOBS.tests, dir: "tests", typecheck: TYPECHECK },
  { name: JOBS.acceptance, dir: "acceptance", typecheck: TYPECHECK },
  { name: JOBS.scripts, dir: "scripts", typecheck: "npx tsc --noEmit" },
  {
    name: JOBS.octogeeAccessTools,
    dir: "infra/gateway/extensions/octogee-access-tools",
    typecheck: 'echo "octogee-access-tools — no tsconfig; vitest is the gate"',
  },
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
  {
    name: JOBS.octogeeProjectTools,
    dir: "infra/gateway/extensions/octogee-project-tools",
    typecheck: 'echo "octogee-project-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeWebTools,
    dir: "infra/gateway/extensions/octogee-web-tools",
    typecheck: 'echo "octogee-web-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeOpsTools,
    dir: "infra/gateway/extensions/octogee-ops-tools",
    typecheck: 'echo "octogee-ops-tools — no tsconfig; vitest is the gate"',
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
  {
    dir: "ops-agent/extensions/octogee-ops-runtime-tools/",
    jobs: [JOBS.opsAgentRuntimeTools, JOBS.tests],
  },
  { dir: "ops-agent/", jobs: [JOBS.opsAgent, JOBS.tests] },
  { dir: "tests/", jobs: [JOBS.tests] },
  { dir: "acceptance/", jobs: [JOBS.acceptance] },
  { dir: "scripts/", jobs: [JOBS.scripts, JOBS.customerLifecycleEmulator] },
  {
    dir: "infra/gateway/extensions/octogee-access-tools/",
    jobs: [JOBS.octogeeAccessTools],
  },
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
  {
    dir: "infra/gateway/extensions/octogee-project-tools/",
    jobs: [JOBS.octogeeProjectTools],
  },
  {
    dir: "infra/gateway/extensions/octogee-web-tools/",
    jobs: [JOBS.octogeeWebTools],
  },
  {
    dir: "infra/gateway/extensions/octogee-ops-tools/",
    jobs: [JOBS.octogeeOpsTools, JOBS.tests],
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
      JOBS.tests,
    ],
    reason:
      "@octogee/core is consumed by scripts + octogee-api (via scripts/lib re-export shims) + gateway-edge + glm-controller (direct package import); tests/specs' readSrc() helpers (model-credential-materializer, byot-sync-apply, gateway-rpc-local-exceptions specs) also fall back to reading core/src directly for logic that moved out of scripts/lib",
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
      JOBS.tests,
    ],
    reason:
      "@octogee/test-helpers (firestore-emulator) is consumed by the gateway-edge + octogee-api + functions emulator specs; test-helpers/package.json's firebase-admin range is also swept by tests/specs/firebase-admin-major-alignment.spec.ts",
  },
  {
    when: "gateway-edge/",
    jobs: [JOBS.octogeeApi, JOBS.octogeeApiEmulator, JOBS.tests],
    reason:
      "octogee-api compiles gateway-edge route Routers (cross-package imports) and its emulator specs mount them via createApp(); tests/specs also imports gateway-edge/src/billing/provider-key-format.js directly (byok-provider-registry-parity.spec.ts) and sweeps gateway-edge/package.json's firebase-admin range (firebase-admin-major-alignment.spec.ts)",
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
  // tests/specs imports/reads app/site/scripts/functions/octogee-api source
  // directly (see #2130/#2134: an app/src/routes/appRoutes.ts change merged
  // without running `test (tests)`, even though app-route-helpers.spec.ts
  // asserts on it, and main went latently red). Ownership alone routes these
  // paths to their own package job only; these edges make tests/specs'
  // cross-package dependencies a hazard the scope resolver actually knows
  // about — whether via `import`, a dynamic `import()`, or a raw
  // readFileSync() source-text parity check.
  {
    when: "app/src/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs imports app/src source directly (app-route-helpers.spec.ts → routes/appRoutes, context-channel-selection.spec.ts → lib/contextChannelSelection, deferred-action.spec.ts → lib/deferredAction, sizing-cost-lockstep.spec.ts → lib/sizing, activity-wire-contract.spec.ts → hooks/useActivityChannel + activity-rows/ActivityRow)",
  },
  {
    when: "app/public/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs/first-party-assets.spec.ts verifies the founder-avatar asset names and first-party provenance",
  },
  {
    when: "site/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs reads site/ source directly: site/src/lib/* (explore-loader, public-builder-loader, public-jsonld, site-pricing-parity specs), site/firebase.json (site-hosting-security.spec.ts), and site/package.json's firebase-admin range (firebase-admin-major-alignment.spec.ts)",
  },
  {
    when: "scripts/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs reads scripts/ source directly beyond lib/: scripts/lib/* (byot-auth-profiles, byot-sync, auth-profile-sqlite, key-fingerprint, model-credential-materializer, usage-log-line specs), scripts/secret-resolver.mjs + scripts/entrypoints/fleet-controller.ts (byok-provider-registry-parity, gateway-entrypoint, gateway-rpc-local-exceptions specs), scripts/setup-secrets.sh + scripts/verify-secrets.sh (byot-sync-secret-management, openrouter-platform-secret-management specs), scripts/rebuild-matrix-bases.sh (gateway-base-refresh.spec.ts), and internal-routing-guard.spec.ts walks the entire scripts/ tree",
  },
  {
    when: "scripts/lib/vite-third-party-licenses.",
    jobs: [JOBS.app, JOBS.site],
    reason:
      "the app and site production builds both import the shared third-party license artifact plugin",
  },
  {
    when: "functions/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs reads functions/ source directly: functions/src/social/aggregators + functions/src/triggers/social.ts (social-edges, internal-routing-guard specs) and functions/package.json's firebase-admin range (firebase-admin-major-alignment.spec.ts)",
  },
  {
    when: "octogee-api/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs reads octogee-api/src source directly: routes/byok-broker.ts (byok-provider-registry-parity.spec.ts), src/index.ts (helm-octogee-api-ingress.spec.ts), routes/fleet-broker.ts (model-credential-snapshot-projection.spec.ts); octogee-api/package.json's firebase-admin range is also swept (firebase-admin-major-alignment.spec.ts)",
  },
  {
    when: "glm-controller/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs/firebase-admin-major-alignment.spec.ts sweeps glm-controller/package.json's firebase-admin range — the exact regression (#1521) that spec exists to catch",
  },
  {
    when: "acceptance/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs/firebase-admin-major-alignment.spec.ts sweeps acceptance/package.json's firebase-admin range",
  },
  {
    when: "firestore-rules-tests/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs/transitive-security.spec.ts verifies the Firebase tooling dependency overrides recorded in firestore-rules-tests/package-lock.json",
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
