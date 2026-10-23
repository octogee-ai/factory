import { describe, it, expect } from "vitest";
import {
  resolveScope,
  toGhaOutputs,
  serializeGhaOutputs,
  type JobKey,
} from "../lib/scope/resolve.js";
import { ALL_JOBS, UNIT_PACKAGES } from "../lib/scope/manifest.js";

// Helper: assert the resolved job set equals exactly `expected` (order-free).
function expectJobs(paths: string[], expected: JobKey[]) {
  const got = resolveScope(paths).jobs;
  expect([...got].sort()).toEqual([...expected].sort());
}

describe("resolveScope — ownership", () => {
  it("runs broker adapter behavioral coverage for installed extension changes", () => {
    expect(resolveScope(["infra/gateway/extensions/octogee-broker-tools/catalog.ts"]).jobs).toContain("octogee-broker-tools");
    expect(UNIT_PACKAGES.find(pkg => pkg.name === "octogee-broker-tools")?.dir).toBe("infra/gateway/extensions/octogee-broker-tools");
  });
  it("empty diff runs nothing (not everything)", () => {
    const r = resolveScope([]);
    expect(r.jobs).toEqual([]);
    expect(r.everything).toBe(false);
  });

  it("octogee-api owns its emulator suite too", () => {
    expectJobs(
      ["octogee-api/src/routes/projects.ts"],
      // + the octogee-api/ edge pulls tests (byok-provider-registry-parity,
      // helm-octogee-api-ingress, model-credential-snapshot-projection specs
      // all read octogee-api/src source directly).
      ["octogee-api", "octogee-api-emulator", "tests"],
    );
  });

  it("gateway-edge owns its emulator suite too", () => {
    expectJobs(
      ["gateway-edge/src/routes/gateway-access.ts"],
      // + the gateway-edge/src edge pulls octogee-api + its emulator suite
      // (octogee-api compiles AND mounts gateway-edge route Routers; the
      // octogee-api emulator specs drive createApp() which mounts them) + tests
      // (byok-provider-registry-parity.spec.ts imports gateway-edge/src/billing
      // directly).
      [
        "gateway-edge",
        "gateway-edge-emulator",
        "octogee-api",
        "octogee-api-emulator",
        "tests",
      ],
    );
  });

  it("scripts owns the customer-lifecycle emulator suite", () => {
    expectJobs(
      ["scripts/ops/fleet.ts"],
      // + the scripts/ edge pulls tests (internal-routing-guard.spec.ts walks
      // the entire scripts/ tree; several specs also read specific scripts/
      // root files directly).
      ["scripts", "customer-lifecycle-emulator", "tests"],
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
    // + the glm-controller/ edge pulls tests: firebase-admin-major-alignment.spec.ts
    // sweeps glm-controller/package.json's firebase-admin range — the exact
    // regression (#1521) that spec exists to catch.
    expectJobs(
      ["glm-controller/src/index.ts"],
      ["glm-controller", "glm-controller-emulator", "tests"],
    );
  });

  it("octogee-chat-tools resolves to its own job (sibling extension dir)", () => {
    expectJobs(
      ["infra/gateway/extensions/octogee-chat-tools/src/tools.ts"],
      ["octogee-chat-tools"],
    );
  });

  it("octogee-access-tools resolves to its own job", () => {
    expectJobs(
      ["infra/gateway/extensions/octogee-access-tools/access-client.ts"],
      ["octogee-access-tools"],
    );
  });

  it("octogee-activity-tools resolves to its behavioral suite", () => {
    expectJobs(
      ["infra/gateway/extensions/octogee-activity-tools/plugin-runtime-native.ts"],
      ["octogee-activity-tools"],
    );
    const unitPackage = UNIT_PACKAGES.find(({ name }) => name === "octogee-activity-tools");
    expect(unitPackage).toEqual({
      name: "octogee-activity-tools",
      dir: "infra/gateway/extensions/octogee-activity-tools",
      typecheck: "npm run typecheck --silent",
    });
  });

  it("octogee-connector-tools resolves to its own job and cross-package contracts", () => {
    expectJobs(
      ["infra/gateway/extensions/octogee-connector-tools/connector-client.ts"],
      ["octogee-connector-tools", "tests"],
    );
  });

  it("octogee-web-tools resolves to its own job", () => {
    expectJobs(
      ["infra/gateway/extensions/octogee-web-tools/web-client.ts"],
      ["octogee-web-tools"],
    );
  });

  it("octogee-board-tools resolves to its own job", () => {
    expectJobs(
      ["infra/gateway/extensions/octogee-board-tools/board-client.ts"],
      ["octogee-board-tools"],
    );
  });

  it("octogee-project-tools resolves to its own job", () => {
    expectJobs(
      ["infra/gateway/extensions/octogee-project-tools/project-client.ts"],
      ["octogee-project-tools"],
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
  it.each(["core", "shared", "test-helpers"])(
    "%s rebuilds and verifies committed dist",
    (packageName) => {
      const unitPackage = UNIT_PACKAGES.find(({ name }) => name === packageName);

      expect(unitPackage?.typecheck).toBe(
        "npm run typecheck && npm run build && node ../scripts/ops/verify-committed-dist.mjs",
      );
    },
  );
});

describe("resolveScope — cross-package hazard edges", () => {
  it("core/ change runs the core job + every consumer (they compile its re-export shims)", () => {
    // @octogee/core is consumed (via scripts/lib shims today) by scripts +
    // octogee-api + gateway-edge + glm-controller. Editing core must re-run
    // them all, plus the core job itself (which also guards committed dist/)
    // + tests (tests/specs' readSrc() helpers fall back to core/src directly
    // for logic that moved out of scripts/lib, e.g. model-credential-materializer).
    expectJobs(
      ["core/src/workspace-slugs.ts"],
      [
        "core",
        "scripts",
        "customer-lifecycle-emulator",
        "octogee-api",
        "octogee-api-emulator",
        "gateway-edge",
        "gateway-edge-emulator",
        "glm-controller",
        "tests",
      ],
    );
  });

  it("test-helpers/ change runs the test-helpers job + its emulator-spec consumers", () => {
    // @octogee/test-helpers (firestore-emulator) is consumed by the gateway-edge,
    // octogee-api, and functions emulator specs, + tests (its package.json's
    // firebase-admin range is swept by firebase-admin-major-alignment.spec.ts).
    expectJobs(
      ["test-helpers/src/firestore-emulator.ts"],
      [
        "test-helpers",
        "gateway-edge",
        "gateway-edge-emulator",
        "octogee-api",
        "octogee-api-emulator",
        "functions",
        "functions-emulator",
        "tests",
      ],
    );
  });

  it("scripts/lib change runs scripts + tests — octogee-api/gateway-edge/glm-controller no longer compile it, but tests/specs still imports it directly", () => {
    // octogee-api, gateway-edge, and glm-controller all import @octogee/core
    // directly now, so scripts/lib no longer feeds them. But tests/specs (e.g.
    // byot-sync-state.spec.ts, model-credential-materializer.spec.ts) imports
    // scripts/lib source directly, so a scripts/lib edit must also run tests.
    expectJobs(
      ["scripts/lib/admin-fleet-router.ts"],
      ["scripts", "customer-lifecycle-emulator", "tests"],
    );
  });

  it("third-party license plugin changes run both production web surfaces", () => {
    expectJobs(
      ["scripts/lib/vite-third-party-licenses.mjs"],
      ["app", "site", "scripts", "customer-lifecycle-emulator", "tests"],
    );
  });

  it("records ownership and edge reasons for diagnostics", () => {
    const result = resolveScope(["gateway-edge/src/routes/git.ts"]);

    expect(result.reasons).toEqual([
      "owner:gateway-edge/",
      "edge:gateway-edge/",
    ]);
  });

  it("a scripts change outside lib/ does NOT pull octogee-api/gateway-edge, but DOES pull tests", () => {
    // The octogee-api/gateway-edge compile-time edges are still lib/-agnostic
    // (they never applied to scripts/); the scripts/ → tests edge is
    // whole-directory though, since internal-routing-guard.spec.ts walks all
    // of scripts/, not just lib/.
    expectJobs(
      ["scripts/ops/audit-coverage.ts"],
      ["scripts", "customer-lifecycle-emulator", "tests"],
    );
  });

  it("the shared emulator runner change exercises every package emulator suite", () => {
    expectJobs(
      ["scripts/ops/run-emulator-vitest.mjs"],
      [
        "scripts",
        "customer-lifecycle-emulator",
        "functions-emulator",
        "gateway-edge-emulator",
        "glm-controller-emulator",
        "octogee-api-emulator",
        "tests",
      ],
    );
  });

  it("gateway-edge/src change ALSO runs octogee-api + its emulator suite (route imports + mounts)", () => {
    expectJobs(
      ["gateway-edge/src/routes/git.ts"],
      // + the gateway-edge/src/ edge also pulls tests
      // (byok-provider-registry-parity.spec.ts imports
      // gateway-edge/src/billing/provider-key-format.js directly).
      [
        "gateway-edge",
        "gateway-edge-emulator",
        "octogee-api",
        "octogee-api-emulator",
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

describe("resolveScope — fail-open (run everything)", () => {
  it("a shared/ change fails open to everything (type substrate, broad consumers)", () => {
    const r = resolveScope(["shared/types/openclaw-wire.ts"]);
    expect(r.everything).toBe(true);
    expect([...r.jobs].sort()).toEqual([...ALL_JOBS].sort());
  });

  it("root lockfile change fails open to everything", () => {
    expect(resolveScope(["package-lock.json"]).everything).toBe(true);
  });

  it("editing the Test workflow itself fails open to everything", () => {
    expect(resolveScope([".github/workflows/test.yml"]).everything).toBe(true);
  });

  it("editing the resolver itself fails open to everything", () => {
    expect(resolveScope(["scripts/lib/scope/manifest.ts"]).everything).toBe(true);
  });

  it("an unmapped path (no owning package) fails open to everything", () => {
    expect(resolveScope(["helm/values.yaml"]).everything).toBe(true);
  });
});

describe("resolveScope — inert paths run nothing", () => {
  it("docs-only change runs nothing", () => {
    expectJobs(["docs/specs/CI-TEST-BUILD-EFFICIENCY-SPEC.md"], []);
  });

  it("root markdown (README) runs nothing", () => {
    expectJobs(["README.md"], []);
  });

  it("inert + a real package change runs only the package (+ its cross-package edges)", () => {
    expectJobs(["docs/x.md", "site/src/x.ts"], ["site", "tests"]);
  });
});

describe("toGhaOutputs", () => {
  it("emits a matrix with full package metadata for changed unit packages", () => {
    const out = toGhaOutputs(resolveScope(["octogee-api/src/x.ts"]));
    expect(out.any).toBe(true);
    // + tests, via the octogee-api/ edge.
    expect(out.test_matrix.map((p) => p.name).sort()).toEqual(["octogee-api", "tests"]);
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
