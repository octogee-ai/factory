import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  resolveScope,
  toGhaOutputs,
  serializeGhaOutputs,
  type JobKey,
} from "../lib/scope/resolve.js";
import { EDGES, GLOBAL_EXACT, GLOBAL_PREFIX, OWNERSHIP, UNIT_PACKAGES } from "../lib/scope/manifest.js";

// Helper: assert the resolved job set equals exactly `expected` (order-free).
function expectJobs(paths: string[], expected: JobKey[]) {
  const got = resolveScope(paths).jobs;
  expect([...got].sort()).toEqual([...expected].sort());
}

describe("resolveScope — ownership", () => {
  it("checks the consuming chart contracts for the maintained VM bridge image", () => {
    expectJobs(["platform/infra/vm-bridge/Dockerfile"], ["tests"]);
  });
  it("runs broker adapter behavioral coverage for installed extension changes", () => {
    expect(resolveScope(["platform/infra/gateway/extensions/platform/octogee-broker-tools/catalog.ts"]).jobs).toContain("octogee-broker-tools");
    expect(UNIT_PACKAGES.find(pkg => pkg.name === "octogee-broker-tools")?.dir).toBe("platform/infra/gateway/extensions/platform/octogee-broker-tools");
  });
  it("scopes a product package path like the platform package it overlays", () => {
    expect(resolveScope(["product/gateway-edge/src/routes/billing.ts"]).jobs)
      .toEqual(resolveScope(["platform/gateway-edge/src/routes/billing.ts"]).jobs);
  });
  it("scopes a standalone product library package as its own package, not as an overlay", () => {
    expect(resolveScope(["product/core/src/index.ts"]).jobs).toContain("product-core");
    expect(resolveScope(["product/core/src/index.ts"]).jobs).not.toContain("core");
    expect(resolveScope(["product/shared/types/billing.ts"]).jobs).toContain("product-shared");
    expect(resolveScope(["product/shared/types/billing.ts"]).jobs).not.toContain("shared");
  });
  it("owns product files outside any platform package", () => {
    expectJobs(["product/README.md"], ["scripts", "tests"]);
  });
  it("runs the platform suite for platform/tests changes", () => {
    expectJobs(["platform/tests/specs/helm-octogee-api.spec.ts", "platform/tests/vitest.config.ts"], ["platform-tests"]);
  });
  it("runs every suite that reads the shared conformance fixtures", () => {
    expectJobs(
      ["platform/tests/fixtures/agent-conversation/agent-activity-envelopes.json"],
      ["app", "gateway-edge", "platform-tests", "tests"],
    );
  });
  it("runs the recipe specs and the dependency policy for the platform deploy recipes", () => {
    expectJobs(["platform/deploy/manifests/gateway.yaml"], ["platform-tests", "scripts", "tests"]);
    expectJobs(["platform/install.sh"], ["scripts"]);
  });
  it("runs the dependency policy for the platform workflows", () => {
    expectJobs(["platform/.github/workflows/checks.yml"], ["platform-tests", "tests"]);
  });
  it("empty diff runs nothing (not everything)", () => {
    const r = resolveScope([]);
    expect(r.jobs).toEqual([]);
    expect(r.everything).toBe(false);
  });

  it("octogee-api owns its emulator suite too", () => {
    expectJobs(
      ["platform/octogee-api/src/routes/projects.ts"],
      // + the platform/octogee-api/ edge pulls tests (byok-provider-registry-parity,
      // helm-octogee-api-ingress, model-credential-snapshot-projection specs
      // all read platform/octogee-api/src source directly).
      ["octogee-api", "octogee-api-emulator", "platform-tests", "tests"],
    );
  });

  it("gateway-edge owns its emulator suite too", () => {
    expectJobs(
      ["platform/gateway-edge/src/routes/gateway-access.ts"],
      // + the platform/gateway-edge/src edge pulls octogee-api + its emulator suite
      // (octogee-api compiles AND mounts gateway-edge route Routers; the
      // octogee-api emulator specs drive createApp() which mounts them) + tests
      // (byok-provider-registry-parity.spec.ts imports platform/gateway-edge/src/billing
      // directly).
      [
        "gateway-edge",
        "gateway-edge-emulator",
        "octogee-api",
        "octogee-api-emulator",
        "platform-tests",
        "tests",
      ],
    );
  });

  it("scripts owns the user-lifecycle emulator suite", () => {
    expectJobs(
      ["platform/scripts/ops/fleet.ts"],
      // + the platform/scripts/ edge pulls tests (internal-routing-guard.spec.ts walks
      // the entire platform/scripts/ tree; several specs also read specific platform/scripts/
      // root files directly).
      ["scripts", "customer-lifecycle-emulator", "platform-tests", "tests"],
    );
  });

  it("functions owns the functions-emulator suite", () => {
    expectJobs(
      ["functions/src/onUserComplete.ts"],
      // + the functions/src/ edge pulls tests (social-edges.spec.ts imports
      // functions/src/social/aggregators directly).
      ["functions", "functions-emulator", "tests"],
    );
  });

  it("glm-controller owns its Firestore emulator suite too", () => {
    // + the platform/glm-controller/ edge pulls tests: firebase-admin-major-alignment.spec.ts
    // sweeps platform/glm-controller/package.json's firebase-admin range — the exact
    // regression (#1521) that spec exists to catch.
    expectJobs(
      ["platform/glm-controller/src/index.ts"],
      ["glm-controller", "glm-controller-emulator", "platform-tests", "tests"],
    );
  });

  it("octogee-chat-tools resolves to its own job and the extension specs (sibling extension dir)", () => {
    expectJobs(
      ["product/infra/gateway/extensions/octogee-chat-tools/src/tools.ts"],
      ["octogee-chat-tools", "tests"],
    );
  });

  it("octogee-access-tools resolves to its own job and the extension specs", () => {
    expectJobs(
      ["platform/infra/gateway/extensions/platform/octogee-access-tools/access-client.ts"],
      ["octogee-access-tools", "tests"],
    );
  });

  it("octogee-activity-tools resolves to its behavioral suite and the extension specs", () => {
    expectJobs(
      ["product/infra/gateway/extensions/octogee-activity-tools/plugin-runtime-native.ts"],
      ["octogee-activity-tools", "tests"],
    );
    const unitPackage = UNIT_PACKAGES.find(({ name }) => name === "octogee-activity-tools");
    expect(unitPackage).toEqual({
      name: "octogee-activity-tools",
      dir: "product/infra/gateway/extensions/octogee-activity-tools",
      typecheck: "npm run typecheck --silent",
    });
  });

  it("octogee-connector-tools resolves to its own job and cross-package contracts", () => {
    expectJobs(
      ["product/infra/gateway/extensions/octogee-connector-tools/connector-client.ts"],
      ["octogee-connector-tools", "tests"],
    );
  });

  it("octogee-web-tools resolves to its own job and the extension specs", () => {
    expectJobs(
      ["product/infra/gateway/extensions/octogee-web-tools/web-client.ts"],
      ["octogee-web-tools", "tests"],
    );
  });

  it("octogee-board-tools resolves to its own job and the extension specs", () => {
    expectJobs(
      ["product/infra/gateway/extensions/octogee-board-tools/board-client.ts"],
      ["octogee-board-tools", "tests"],
    );
  });

  it("octogee-project-tools resolves to its own job and the extension specs", () => {
    expectJobs(
      ["product/infra/gateway/extensions/octogee-project-tools/project-client.ts"],
      ["octogee-project-tools", "tests"],
    );
  });

  it("app changes run the app gate", () => {
    expectJobs(
      ["app/src/routes/appRoutes.ts"],
      // + the app/src/ edge pulls tests (app-route-helpers.spec.ts imports
      // app/src/routes/appRoutes directly — see #2130/#2134).
      ["app", "tests"],
    );
  });

  it("the local Obsidian pairing helper runs its isolated package gate", () => {
    expectJobs(
      ["obsidian-connect/src/pairing.mjs"],
      ["obsidian-connect", "tests"],
    );
  });
});

describe("unit package gates", () => {
  it.each([
    ["core", "../scripts/ops/verify-committed-dist.mjs"],
    ["shared", "../scripts/ops/verify-committed-dist.mjs"],
    ["test-helpers", "../../platform/scripts/ops/verify-committed-dist.mjs"],
  ])(
    "%s rebuilds and verifies committed dist",
    (packageName, verifier) => {
      const unitPackage = UNIT_PACKAGES.find(({ name }) => name === packageName);

      expect(unitPackage?.typecheck).toBe(
        `npm run typecheck && npm run build && node ${verifier}`,
      );
    },
  );
});

describe("resolveScope — cross-package hazard edges", () => {
  it("platform/core/ change runs the core job + every consumer (they compile its re-export shims)", () => {
    // @octogee/core is consumed (via platform/scripts/lib shims today) by scripts +
    // octogee-api + gateway-edge + glm-controller. Editing core must re-run
    // them all, plus the core job itself (which also guards committed dist/)
    // + tests (tests/specs' readSrc() helpers fall back to platform/core/src directly
    // for logic that moved out of platform/scripts/lib, e.g. model-credential-materializer).
    expectJobs(
      ["platform/core/src/workspace-slugs.ts"],
      [
        "core",
        "scripts",
        "customer-lifecycle-emulator",
        "octogee-api",
        "octogee-api-emulator",
        "gateway-edge",
        "gateway-edge-emulator",
        "glm-controller",
        "platform-tests",
        "product-core",
        "tests",
      ],
    );
  });

  it.each([
    "product/test-helpers/src/firestore-emulator.ts",
    "product/test-helpers/run-emulator-vitest.mjs",
  ])("product emulator tooling change %s runs every package emulator suite", (file) => {
    expectJobs(
      [file],
      [
        "test-helpers",
        "customer-lifecycle-emulator",
        "gateway-edge-emulator",
        "glm-controller-emulator",
        "octogee-api-emulator",
        "functions",
        "functions-emulator",
        "tests",
      ],
    );
  });

  it("platform/scripts/lib change runs scripts + tests — octogee-api/gateway-edge/glm-controller no longer compile it, but tests/specs still imports it directly", () => {
    // octogee-api, gateway-edge, and glm-controller all import @octogee/core
    // directly now, so platform/scripts/lib no longer feeds them. But tests/specs (e.g.
    // byot-sync-state.spec.ts, model-credential-materializer.spec.ts) imports
    // platform/scripts/lib source directly, so a platform/scripts/lib edit must also run tests.
    expectJobs(
      ["platform/scripts/lib/admin-fleet-router.ts"],
      ["scripts", "customer-lifecycle-emulator", "platform-tests", "tests"],
    );
  });

  it("third-party license plugin changes run both production web surfaces", () => {
    expectJobs(
      ["platform/scripts/lib/vite-third-party-licenses.mjs"],
      ["app", "site", "scripts", "customer-lifecycle-emulator", "platform-tests", "tests"],
    );
  });

  it("records ownership and edge reasons for diagnostics", () => {
    const result = resolveScope(["platform/gateway-edge/src/routes/git.ts"]);

    expect(result.reasons).toEqual([
      "owner:platform/gateway-edge/",
      "edge:platform/gateway-edge/",
    ]);
  });

  it("a scripts change outside lib/ does NOT pull octogee-api/gateway-edge, but DOES pull tests", () => {
    // The octogee-api/gateway-edge compile-time edges are still lib/-agnostic
    // (they never applied to platform/scripts/); the platform/scripts/ → tests edge is
    // whole-directory though, since internal-routing-guard.spec.ts walks all
    // of platform/scripts/, not just lib/.
    expectJobs(
      ["platform/scripts/ops/audit-coverage.ts"],
      ["scripts", "customer-lifecycle-emulator", "platform-tests", "tests"],
    );
  });

  it("platform/gateway-edge/src change ALSO runs octogee-api + its emulator suite (route imports + mounts)", () => {
    expectJobs(
      ["platform/gateway-edge/src/routes/git.ts"],
      // + the platform/gateway-edge/src/ edge also pulls tests
      // (byok-provider-registry-parity.spec.ts imports
      // platform/gateway-edge/src/model-credentials/provider-key-format.js directly).
      [
        "gateway-edge",
        "gateway-edge-emulator",
        "octogee-api",
        "octogee-api-emulator",
        "platform-tests",
        "tests",
      ],
    );
  });

  it("site/firestore.rules ALSO runs the firestore-rules suite", () => {
    // + tests, via the whole-directory site/ edge (firestore-rules-user-authority.spec.ts
    // reads site/firestore.rules directly; firestore-indexes.spec.ts reads
    // site/firestore.indexes.json).
    expectJobs(["site/firestore.rules"], ["site", "firestore-rules", "tests"]);
  });

  it("site/src change ALSO runs tests (site/src/lib is imported directly by several tests/specs)", () => {
    expectJobs(["site/src/lib/pricing.ts"], ["site", "tests"]);
  });

  it("acceptance/ change ALSO runs tests (firebase-admin-major-alignment.spec.ts sweeps its package.json)", () => {
    expectJobs(["acceptance/src/x.ts"], ["acceptance", "tests"]);
  });
});

describe("resolveScope — consumer scoping", () => {
  it("a platform/shared/ change runs its consumers, not desktop, Obsidian or gateway extension packages", () => {
    const r = resolveScope(["platform/shared/types/openclaw-wire.ts"]);
    expect(r.everything).toBe(false);
    expect(r.jobs).toEqual(expect.arrayContaining(["shared", "app", "gateway-edge", "octogee-api-emulator", "tests"]));
    expect(r.jobs.some(job => job === "desktop" || job === "obsidian-connect" || job === "firestore-rules" || (job.startsWith("octogee-") && job.endsWith("-tools")))).toBe(false);
  });

  it("a gateway image change runs the packages that read gateway files, not app, site or emulators", () => {
    expectJobs(["platform/infra/gateway/Dockerfile"], ["acceptance", "core", "gateway-edge", "octogee-api", "platform-tests", "scripts", "tests"]);
  });

  it("the artifact worker runs its own suite and the specs that read it", () => {
    expectJobs(["artifact-worker/src/worker.ts"], ["artifact-worker", "core", "octogee-api", "scripts", "tests"]);
  });

  it("files no test reads run no test jobs", () => {
    expectJobs([".github/ISSUE_TEMPLATE/bug.yml", ".gitleaksignore"], []);
    expectJobs(["platform/.github/ISSUE_TEMPLATE/bug.md", "platform/.gitattributes", "platform/.gitignore", "platform/.gitleaks.toml", "platform/LICENSE"], []);
  });
});

describe("resolveScope — repo-wide changes run everything", () => {
  it("root lockfile change runs everything", () => {
    expect(resolveScope(["package-lock.json"]).everything).toBe(true);
  });

  it("editing the Checks workflow or its setup runs everything", () => {
    expect(resolveScope([".github/workflows/checks.yml"]).everything).toBe(true);
    expect(resolveScope([".github/actions/setup-ci/action.yml"]).everything).toBe(true);
    expect(resolveScope([".github/workflows/test.yml"]).everything).toBe(true);
  });

  it("editing the resolver itself runs everything", () => {
    expect(resolveScope(["platform/scripts/lib/scope/manifest.ts"]).everything).toBe(true);
  });
});

describe("resolveScope — ownership is required", () => {
  it("refuses a path with no CI owner instead of silently running everything", () => {
    expect(() => resolveScope(["new-package/src/index.ts"])).toThrow("No CI owner for new-package/src/index.ts");
  });

  it("every tracked path has a CI owner", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const tracked = execFileSync("/usr/bin/git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(() => resolveScope(tracked)).not.toThrow();
  });
});

describe("resolveScope — inert paths run nothing", () => {
  it("docs-only change runs nothing", () => {
    expectJobs(["docs/specs/CI-TEST-BUILD-EFFICIENCY-SPEC.md"], []);
  });

  it("root markdown (README) runs nothing", () => {
    expectJobs(["README.md"], []);
  });

  it("the platform root's docs and markdown run nothing", () => {
    expectJobs(["platform/docs/handbook/11-testing.md", "platform/README.md"], []);
  });

  it("inert + a real package change runs only the package (+ its cross-package edges)", () => {
    expectJobs(["docs/x.md", "site/src/x.ts"], ["site", "tests"]);
  });
});

describe("toGhaOutputs", () => {
  it("emits a matrix with full package metadata for changed unit packages", () => {
    const out = toGhaOutputs(resolveScope(["platform/octogee-api/src/x.ts"]));
    expect(out.any).toBe(true);
    // + tests, via the platform/octogee-api/ edge.
    expect(out.test_matrix.map((p) => p.name).sort()).toEqual(["octogee-api", "platform-tests", "tests"]);
    expect(out.run_app).toBe(false);
    expect(out.run_functions_emulator).toBe(false);
    // octogee-api-emulator is a standalone job (JDK), not a unit-matrix entry —
    // so it's a flag, not a test_matrix row, but an octogee-api change runs it.
    expect(out.run_octogee_api_emulator).toBe(true);
  });

  it("maps standalone-job flags independently of the unit matrix", () => {
    const out = toGhaOutputs(resolveScope(["functions/src/x.ts"]));
    // + tests, via the functions/src/ edge (social-edges.spec.ts).
    expect(out.test_matrix.map((p) => p.name).sort()).toEqual(["functions", "tests"]);
    expect(out.run_functions_emulator).toBe(true);
  });

  it("a desktop change runs the desktop unit job and the three-OS packaging job", () => {
    const out = toGhaOutputs(resolveScope(["desktop/src/main/index.ts"]));
    expect(out.test_matrix.map((p) => p.name)).toEqual(["desktop"]);
    expect(out.run_desktop_package).toBe(true);
    expect(toGhaOutputs(resolveScope(["site/src/x.ts"])).run_desktop_package).toBe(false);
  });

  it("everything → full matrix + every flag true", () => {
    const out = toGhaOutputs(resolveScope(["package-lock.json"]));
    expect(out.test_matrix).toHaveLength(UNIT_PACKAGES.length);
    expect(out.run_app).toBe(true);
    expect(out.run_desktop_package).toBe(true);
    expect(out.run_firestore_rules).toBe(true);
    expect(out.run_customer_lifecycle_emulator).toBe(true);
    expect(out.run_functions_emulator).toBe(true);
    expect(out.run_gateway_edge_emulator).toBe(true);
    expect(out.run_glm_controller_emulator).toBe(true);
    expect(out.run_octogee_api_emulator).toBe(true);
  });

  it("nothing → empty matrix, all flags false, any=false", () => {
    const out = toGhaOutputs(resolveScope([]));
    expect(out.test_matrix).toEqual([]);
    expect(out.any).toBe(false);
    expect(out.run_app).toBe(false);
    expect(out.run_glm_controller_emulator).toBe(false);
  });
});

describe("serializeGhaOutputs", () => {
  it("emits one key=value line per output with compact-JSON matrix", () => {
    const text = serializeGhaOutputs(toGhaOutputs(resolveScope(["functions/src/x.ts"])));
    const lines = text.split("\n");
    expect(lines).toContain("any=true");
    expect(lines).toContain("run_functions_emulator=true");
    expect(lines).toContain("run_glm_controller_emulator=false");
    expect(lines).toContain("run_app=false");
    expect(lines).toContain("run_octogee_api_emulator=false");
    // test_matrix must be single-line valid JSON (fromJSON() reads it in the workflow)
    const matrixLine = lines.find((l) => l.startsWith("test_matrix="))!;
    const parsed = JSON.parse(matrixLine.slice("test_matrix=".length));
    // + tests, via the functions/src/ edge (social-edges.spec.ts).
    expect(parsed.map((p: { name: string }) => p.name).sort()).toEqual([
      "functions",
      "tests",
    ]);
    expect(matrixLine).not.toContain("\n");
  });
});

describe("resolveScope — deleted paths", () => {
  it("accepts a deleted file whose ownership entry leaves in the same diff", () => {
    const removed = ".retired-root-file";
    expect(() => resolveScope([removed])).toThrow("No CI owner");
    expect(resolveScope([removed], new Set([removed])).jobs).toEqual([]);
  });

  it("still runs the owner of a deleted file", () => {
    const removed = "platform/gateway-edge/src/retired.ts";
    expect(resolveScope([removed], new Set([removed])).jobs).toContain("gateway-edge");
  });
});

describe("resolveScope — platform submodule", () => {
  const manifestPaths = [...OWNERSHIP.map((o) => o.dir), ...EDGES.map((edge) => edge.when), ...GLOBAL_EXACT, ...GLOBAL_PREFIX];
  const scopeOfEverythingBeneath = (directory: string) => {
    const scopes = manifestPaths.filter((entry) => entry.startsWith(`${directory}/`)).map((entry) => resolveScope([entry]));
    return { everything: scopes.some((scope) => scope.everything), jobs: [...new Set(scopes.flatMap((scope) => scope.jobs))].sort() };
  };
  const scopeOf = (paths: string[]) => {
    const scope = resolveScope(paths);
    return { everything: scope.everything, jobs: [...scope.jobs].sort() };
  };

  it("runs every platform-consuming job when the platform submodule pin moves", () => {
    const expected = scopeOfEverythingBeneath("platform");
    expect(expected.jobs.length).toBeGreaterThan(0);
    expect(scopeOf(["platform"])).toEqual(expected);
    expect(resolveScope(["platform"]).reasons).toContain("submodule:platform");
  });

  it("treats a changed submodule path as every manifest path beneath it", () => {
    const directory = posix.dirname(OWNERSHIP.find((o) => o.dir.endsWith("infra/gateway/"))!.dir);
    const expected = scopeOfEverythingBeneath(directory);
    expect(expected.jobs).toEqual(expect.arrayContaining(["gateway-edge", "glm-controller", "octogee-broker-tools", "scripts", "tests"]));
    expect(scopeOf([directory])).toEqual(expected);
  });

  it("runs everything when the submodule declaration changes", () => {
    expect(resolveScope([".gitmodules"]).everything).toBe(true);
  });

  it("still refuses a submodule path that no manifest entry covers", () => {
    expect(() => resolveScope(["vendored"])).toThrow(/No CI owner for vendored/);
  });
});
