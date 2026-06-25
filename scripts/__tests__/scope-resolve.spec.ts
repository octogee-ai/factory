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
  it("empty diff runs nothing (not everything)", () => {
    const r = resolveScope([]);
    expect(r.jobs).toEqual([]);
    expect(r.everything).toBe(false);
  });

  it("a single package change runs only that package's jobs", () => {
    expectJobs(["octogee-api/src/routes/projects.ts"], ["octogee-api"]);
  });

  it("gateway-edge owns its emulator suite too", () => {
    expectJobs(
      ["gateway-edge/src/routes/shells.ts"],
      // + the gateway-edge/src edge pulls octogee-api (route imports)
      ["gateway-edge", "gateway-edge-emulator", "octogee-api"],
    );
  });

  it("scripts owns the customer-lifecycle emulator suite", () => {
    expectJobs(
      ["scripts/ops/fleet.ts"],
      ["scripts", "customer-lifecycle-emulator"],
    );
  });

  it("functions owns the functions-emulator suite", () => {
    expectJobs(
      ["functions/src/onUserComplete.ts"],
      ["functions", "functions-emulator"],
    );
  });

  it("glm-controller change runs only glm-controller (not fail-open to everything)", () => {
    expectJobs(["glm-controller/src/index.ts"], ["glm-controller"]);
  });

  it("octogee-chat-tools resolves to its own job (sibling extension dir)", () => {
    expectJobs(
      ["infra/gateway/extensions/octogee-chat-tools/src/tools.ts"],
      ["octogee-chat-tools"],
    );
  });

  it("app changes run the app gate", () => {
    expectJobs(["app/src/routes/appRoutes.ts"], ["app"]);
  });
});

describe("resolveScope — cross-package hazard edges", () => {
  it("core/ change runs the core job + every consumer (they compile its re-export shims)", () => {
    // @octogee/core is consumed (via scripts/lib shims today) by scripts +
    // octogee-api + gateway-edge + glm-controller. Editing core must re-run
    // them all, plus the core job itself (which also guards committed dist/).
    expectJobs(
      ["core/src/workspace-slugs.ts"],
      [
        "core",
        "scripts",
        "customer-lifecycle-emulator",
        "octogee-api",
        "gateway-edge",
        "gateway-edge-emulator",
        "glm-controller",
      ],
    );
  });

  it("scripts/lib change ALSO runs octogee-api + gateway-edge (they compile it)", () => {
    // The admin-fleet-router hazard: octogee-api and gateway-edge compile scripts/lib
    // (tsconfig include / source imports), so a scripts/lib edit must re-run them.
    // glm-controller imports @octogee/core directly — it reacts to core/, not scripts/lib.
    expectJobs(
      ["scripts/lib/admin-fleet-router.ts"],
      [
        "scripts",
        "customer-lifecycle-emulator",
        "octogee-api",
        "gateway-edge",
        "gateway-edge-emulator",
      ],
    );
  });

  it("records ownership and edge reasons for diagnostics", () => {
    const result = resolveScope(["scripts/lib/admin-fleet-router.ts"]);

    expect(result.reasons).toEqual(["owner:scripts/", "edge:scripts/lib/"]);
  });

  it("a scripts change OUTSIDE lib/ does NOT pull octogee-api/gateway-edge (edge is path-specific)", () => {
    expectJobs(
      ["scripts/ops/audit-coverage.ts"],
      ["scripts", "customer-lifecycle-emulator"],
    );
  });

  it("gateway-edge/src change ALSO runs octogee-api (route imports)", () => {
    expectJobs(
      ["gateway-edge/src/routes/git.ts"],
      ["gateway-edge", "gateway-edge-emulator", "octogee-api"],
    );
  });

  it("site/firestore.rules ALSO runs the firestore-rules suite", () => {
    expectJobs(["site/firestore.rules"], ["site", "firestore-rules"]);
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

  it("inert + a real package change runs only the package", () => {
    expectJobs(["docs/x.md", "renderer/src/security.ts"], ["renderer"]);
  });
});

describe("toGhaOutputs", () => {
  it("emits a matrix with full package metadata for changed unit packages", () => {
    const out = toGhaOutputs(resolveScope(["octogee-api/src/x.ts"]));
    expect(out.any).toBe(true);
    expect(out.test_matrix).toEqual([
      UNIT_PACKAGES.find((p) => p.name === "octogee-api"),
    ]);
    expect(out.run_app).toBe(false);
    expect(out.run_functions_emulator).toBe(false);
  });

  it("maps standalone-job flags independently of the unit matrix", () => {
    const out = toGhaOutputs(resolveScope(["functions/src/x.ts"]));
    expect(out.test_matrix.map((p) => p.name)).toEqual(["functions"]);
    expect(out.run_functions_emulator).toBe(true);
  });

  it("everything → full matrix + every flag true", () => {
    const out = toGhaOutputs(resolveScope(["package-lock.json"]));
    expect(out.test_matrix).toHaveLength(UNIT_PACKAGES.length);
    expect(out.run_app).toBe(true);
    expect(out.run_firestore_rules).toBe(true);
    expect(out.run_customer_lifecycle_emulator).toBe(true);
    expect(out.run_functions_emulator).toBe(true);
    expect(out.run_gateway_edge_emulator).toBe(true);
  });

  it("nothing → empty matrix, all flags false, any=false", () => {
    const out = toGhaOutputs(resolveScope([]));
    expect(out.test_matrix).toEqual([]);
    expect(out.any).toBe(false);
    expect(out.run_app).toBe(false);
  });
});

describe("serializeGhaOutputs", () => {
  it("emits one key=value line per output with compact-JSON matrix", () => {
    const text = serializeGhaOutputs(toGhaOutputs(resolveScope(["functions/src/x.ts"])));
    const lines = text.split("\n");
    expect(lines).toContain("any=true");
    expect(lines).toContain("run_functions_emulator=true");
    expect(lines).toContain("run_app=false");
    // test_matrix must be single-line valid JSON (fromJSON() reads it in the workflow)
    const matrixLine = lines.find((l) => l.startsWith("test_matrix="))!;
    const parsed = JSON.parse(matrixLine.slice("test_matrix=".length));
    expect(parsed.map((p: { name: string }) => p.name)).toEqual(["functions"]);
    expect(matrixLine).not.toContain("\n");
  });
});
