import { describe, it, expect, vi } from "vitest";
import {
  createHelmSubprocessRunner,
  spawnHelm,
  type HelmSubprocess,
} from "../helm-runner";

function mockSubprocess(
  responses: Array<{ stdout?: string; stderr?: string; code?: number }>,
): { runHelm: HelmSubprocess; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
    calls.push(args);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: r.code ?? 0,
    };
  });
  return { runHelm, calls };
}

function withPreflightStatusNotFound(inner: HelmSubprocess): HelmSubprocess {
  return async (args: string[]) => {
    if (args[0] === "status") {
      return { stdout: "", stderr: "Error: release: not found", code: 1 };
    }
    return inner(args);
  };
}

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

describe("createHelmSubprocessRunner — readDeployedInstances", () => {
  it("filters helm list to octogee-gw-* releases and pulls each release's values", async () => {
    const { runHelm, calls } = mockSubprocess([
      
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-default", namespace: "octogee-test", status: "deployed" },
          { name: "octogee-gw-canary",  namespace: "octogee-test", status: "deployed" },
        ]),
      },
      
      {
        stdout: JSON.stringify({
          gatewayId: "gw-test",
          instanceName: "default",
          imageTag: "abc1234",
          image: { repository: REPO },
        }),
      },
      
      {
        stdout: JSON.stringify({
          gatewayId: "gw-test-canary",
          instanceName: "canary",
          imageTag: "def5678",
          image: { repository: REPO },
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });

    expect(calls[0]).toEqual([
      "list",
      "-n",
      "octogee-test",
      "--filter",
      "^octogee-gw-",
      "-o",
      "json",
    ]);
    expect(calls[1].slice(0, 4)).toEqual(["get", "values", "octogee-gw-default", "-n"]);
    expect(map.default).toEqual({
      enabled: true,
      image: { repository: REPO, tag: "abc1234" },
      gatewayId: "gw-test",
    });
    expect(map.canary).toEqual({
      enabled: true,
      image: { repository: REPO, tag: "def5678" },
      gatewayId: "gw-test-canary",
    });
  });

  it("round-trips chartFingerprint from `helm get values` into the deployed map", async () => {
    const fp = "a".repeat(64);
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-default", namespace: "octogee-test", status: "deployed" },
        ]),
      },
      {
        stdout: JSON.stringify({
          gatewayId: "gw-test",
          instanceName: "default",
          imageTag: "abc1234",
          image: { repository: REPO },
          chartFingerprint: fp,
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map.default.chartFingerprint).toBe(fp);
  });

  it("round-trips personal gateway helm knobs from `helm get values`", async () => {
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-bender", namespace: "octogee", status: "deployed" },
        ]),
      },
      {
        stdout: JSON.stringify({
          gatewayId: "gw-bender",
          instanceName: "bender",
          imageTag: "abc1234",
          image: { repository: REPO },
          serviceAccountName: "octogee-gateway-bender",
          gatewayContainerSecurityContext: {
            allowPrivilegeEscalation: true,
            capabilities: { drop: ["ALL"] },
          },
          persistence: {
            enabled: true,
            storageClassName: "premium-rwo",
            size: "20Gi",
            accessModes: ["ReadWriteOnce"],
          },
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    const map = await runner.readDeployedInstances({ namespace: "octogee" });
    expect(map.bender).toMatchObject({
      serviceAccountName: "octogee-gateway-bender",
      gatewayContainerSecurityContext: {
        allowPrivilegeEscalation: true,
      },
      persistence: {
        enabled: true,
        size: "20Gi",
      },
    });
  });

  it("leaves chartFingerprint undefined when the helm release predates the field (transition case)", async () => {
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-default", namespace: "octogee-test", status: "deployed" },
        ]),
      },
      {
        stdout: JSON.stringify({
          gatewayId: "gw-test",
          instanceName: "default",
          imageTag: "abc1234",
          image: { repository: REPO },
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map.default.chartFingerprint).toBeUndefined();
  });

  it("returns an empty map when no octogee-gw-* releases exist (fresh cluster)", async () => {
    const { runHelm } = mockSubprocess([{ stdout: "[]" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map).toEqual({});
  });

  it("skips releases whose values are missing gatewayId/imageTag/image.repository (incomplete adoption)", async () => {
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-broken", namespace: "octogee-test", status: "deployed" },
        ]),
      },
      
      { stdout: JSON.stringify({ instanceName: "broken" }) },
    ]);
    const log = vi.fn();
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map).toEqual({});
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("missing gatewayId/imageTag/imageRepository"),
    );
  });

  it("accepts numeric imageTag values (helm --set parses unquoted numerics as YAML numbers)", async () => {

const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-smoke", namespace: "octogee-test", status: "deployed" },
        ]),
      },
      
      {
        stdout: JSON.stringify({
          gatewayId: "gw-smoke",
          instanceName: "smoke",
          imageTag: 9778420,
          image: { repository: REPO },
        }),
      },
    ]);
    const log = vi.fn();
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map.smoke).toEqual({
      enabled: true,
      image: { repository: REPO, tag: "9778420" },
      gatewayId: "gw-smoke",
    });
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining("missing"),
    );
  });

  it("coerces numeric gatewayId to string too (consistent narrowing)", async () => {
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-numeric", namespace: "octogee-test", status: "deployed" },
        ]),
      },
      {
        stdout: JSON.stringify({
          gatewayId: 12345,
          instanceName: "numeric",
          imageTag: "abc1234",
          image: { repository: REPO },
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map.numeric).toEqual({
      enabled: true,
      image: { repository: REPO, tag: "abc1234" },
      gatewayId: "12345",
    });
  });

  it("throws when helm list fails for a non-not-found reason", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: connection refused" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    await expect(
      runner.readDeployedInstances({ namespace: "octogee-test" }),
    ).rejects.toThrow(/connection refused/);
  });
});

describe("createHelmSubprocessRunner — upsertInstance", () => {
  it("runs `helm upgrade --install octogee-gw-<name> <chart> -n <ns> --set ... --wait`", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      instanceName: "default",
      gatewayId: "gw-test",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(calls).toHaveLength(1);
    const args = calls[0];
    expect(args[0]).toBe("upgrade");
    expect(args).toContain("--install");
    expect(args).toContain("octogee-gw-default");
    expect(args).toContain("/charts/octogee-gateway");
    expect(args).toContain("-n");
    expect(args).toContain("octogee-test");
    expect(args).toContain("--set");
    expect(args).toContain("instanceName=default");
    expect(args).toContain("gatewayId=gw-test");
    expect(args).toContain("imageTag=abc1234");
    expect(args).toContain(`image.repository=${REPO}`);
    expect(args).toContain("--wait");
    expect(args.some((a) => a.startsWith("--timeout="))).toBe(true);
  });

  it("passes --take-ownership when set (cutover from umbrella-managed pods)", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      instanceName: "default",
      gatewayId: "gw-test",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      takeOwnership: true,
    });

    expect(calls[0]).toContain("--take-ownership");
  });

  it("omits --take-ownership by default (steady-state ops)", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      instanceName: "default",
      gatewayId: "gw-test",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(calls[0]).not.toContain("--take-ownership");
  });

  it("threads -f <valuesFile> when provided so per-namespace defaults follow", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      instanceName: "default",
      gatewayId: "gw-test",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      valuesFile: "/charts/octogee-gateway/values.test.yaml",
    });

    const args = calls[0];
    const fIdx = args.indexOf("-f");
    expect(fIdx).toBeGreaterThan(-1);
    expect(args[fIdx + 1]).toBe("/charts/octogee-gateway/values.test.yaml");
  });

  it("passes --set chartFingerprint=<hex> when chartFingerprint is provided", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      instanceName: "default",
      gatewayId: "gw-test",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      chartFingerprint: "f".repeat(64),
    });

    expect(calls[0]).toContain(`chartFingerprint=${"f".repeat(64)}`);
  });

  it("passes personal gateway knobs as helm values", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee",
      instanceName: "bender",
      gatewayId: "gw-bender",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      serviceAccountName: "octogee-gateway-bender",
      gatewayContainerSecurityContext: {
        allowPrivilegeEscalation: true,
        capabilities: { drop: ["ALL"] },
      },
      persistence: {
        enabled: true,
        storageClassName: "premium-rwo",
        size: "20Gi",
        accessModes: ["ReadWriteOnce"],
      },
    });

    const args = calls[0];
    expect(args).toContain("serviceAccountName=octogee-gateway-bender");
    expect(args).toContain("--set-json");
    expect(args).toContain(
      'gatewayContainerSecurityContext={"allowPrivilegeEscalation":true,"capabilities":{"drop":["ALL"]}}',
    );
    expect(args).toContain(
      'persistence={"enabled":true,"storageClassName":"premium-rwo","size":"20Gi","accessModes":["ReadWriteOnce"]}',
    );
  });

  it("passes --set profile=<profile> when profile is provided (operator/non-default)", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee",
      instanceName: "bender",
      gatewayId: "gw-bender",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      profile: "operator",
    });

    expect(calls[0]).toContain("profile=operator");
  });

  it("omits --set profile when profile is undefined (cattle/standard default = chart's profile=\"\")", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      instanceName: "default",
      gatewayId: "gw-test",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(calls[0].some((a) => a.startsWith("profile="))).toBe(false);
  });

  it("omits chartFingerprint --set when not provided (operator-driven helm calls)", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      instanceName: "default",
      gatewayId: "gw-test",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(calls[0].some((a) => a.startsWith("chartFingerprint="))).toBe(false);
  });

  it("propagates helm failures with stderr in the error message", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: timed out" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.upsertInstance({
        namespace: "octogee-test",
        instanceName: "default",
        gatewayId: "gw-test",
        imageRepository: REPO,
        imageTag: "abc1234",
        chartPath: "/charts/octogee-gateway",
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("createHelmSubprocessRunner — upsertInstance self-heal for a stuck pending release", () => {
  const upsertArgs = {
    namespace: "octogee-test",
    instanceName: "default",
    gatewayId: "gw-test",
    imageRepository: REPO,
    imageTag: "newtag",
    chartPath: "/charts/octogee-gateway",
  } as const;

  const IN_PROGRESS =
    "Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress";

  it("rolls back to the last deployed revision then retries the upgrade", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      switch (args[0]) {
        case "upgrade":
          upgrades++;
          return upgrades === 1
            ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
            : { stdout: "ok", stderr: "", code: 0 };
        case "history":
          return {
            stdout: JSON.stringify([
              { revision: 2, status: "superseded" },
              { revision: 3, status: "deployed" },
              { revision: 4, status: "pending-upgrade" },
            ]),
            stderr: "",
            code: 0,
          };
        case "rollback":
          return { stdout: "Rollback was a success", stderr: "", code: 0 };
        default:
          throw new Error(`unexpected helm ${args[0]}`);
      }
    });
    const log = vi.fn();
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "upgrade",
      "history",
      "rollback",
      "upgrade",
    ]);
    const rollback = calls.find((c) => c[0] === "rollback");
    expect(rollback).toBeDefined();

expect(rollback).toContain("octogee-gw-default");
    expect(rollback).toContain("3");
    expect(rollback).toContain("-n");
    expect(rollback).toContain("octogee-test");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("stuck"));
  });

  it("targets the last `superseded` revision when no `deployed` revision remains", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") {
        upgrades++;
        return upgrades === 1
          ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
          : { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([
            { revision: 1, status: "superseded" },
            { revision: 2, status: "pending-upgrade" },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    const rollback = calls.find((c) => c[0] === "rollback");
    expect(rollback).toContain("1");
  });

  it("uninstalls a stuck first-install (pending-install, no good revision) then retries", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") {
        upgrades++;
        return upgrades === 1
          ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
          : { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 1, status: "pending-install" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "uninstall") return { stdout: "uninstalled", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "upgrade",
      "history",
      "uninstall",
      "upgrade",
    ]);
    expect(calls.find((c) => c[0] === "uninstall")).toContain("octogee-gw-default");
  });

  it("does NOT attempt recovery for a non-pending helm failure (real errors still surface)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      return {
        stdout: "",
        stderr: "Error: UPGRADE FAILED: timed out waiting for the condition",
        code: 1,
      };
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /timed out/,
    );
    
    expect(calls.map((c) => c[0])).toEqual(["upgrade"]);
  });

  it("surfaces a clear error when the recovery rollback itself fails (no infinite silent loop)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") return { stdout: "", stderr: IN_PROGRESS, code: 1 };
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 2, status: "deployed" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") {
        return { stdout: "", stderr: "Error: rollback failed: tiller lock", code: 1 };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /rollback/i,
    );
    
    expect(calls.map((c) => c[0])).toEqual(["upgrade", "history", "rollback"]);
  });

  it("retries the upgrade only once after recovery — a second failure throws", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") {
        upgrades++;
        return upgrades === 1
          ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
          : { stdout: "", stderr: "Error: UPGRADE FAILED: timed out", code: 1 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 2, status: "deployed" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /timed out/,
    );
    expect(upgrades).toBe(2);
  });

  it("re-wedge: recovers a release stuck in pending-rollback (Cowboy killed during a prior recovery)", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") {
        upgrades++;
        return upgrades === 1
          ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
          : { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([
            { revision: 2, status: "deployed" },
            { revision: 3, status: "pending-rollback" },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

expect(calls.find((c) => c[0] === "rollback")).toContain("2");
  });

  it("rolls back to an old good revision even when many later revisions failed (never destructively uninstalls; no --max cap)", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const history = [
      { revision: 1, status: "superseded" },
      { revision: 2, status: "deployed" },
      ...Array.from({ length: 25 }, (_, i) => ({
        revision: 3 + i,
        status: i % 2 === 0 ? "pending-upgrade" : "failed",
      })),
    ];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") {
        upgrades++;
        return upgrades === 1
          ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
          : { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "history") {
        return { stdout: JSON.stringify(history), stderr: "", code: 0 };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "upgrade",
      "history",
      "rollback",
      "upgrade",
    ]);
    expect(calls.find((c) => c[0] === "rollback")).toContain("2");
    expect(calls.some((c) => c[0] === "uninstall")).toBe(false);
    expect(calls.find((c) => c[0] === "history")).not.toContain("--max");
  });

  it("surfaces a clear error when helm history returns unparseable output (no raw SyntaxError loop)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") return { stdout: "", stderr: IN_PROGRESS, code: 1 };
      if (args[0] === "history") {
        return {
          stdout: "WARNING: couldn't read kubeconfig\nnot-json-at-all",
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /unparseable output during recovery/,
    );
    
    expect(calls.map((c) => c[0])).toEqual(["upgrade", "history"]);
  });

  it("fails closed on empty helm history (existing stuck release must have revisions) — no destructive uninstall", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") return { stdout: "", stderr: IN_PROGRESS, code: 1 };
      if (args[0] === "history") return { stdout: "[]", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /no usable revision history during recovery/,
    );
    expect(calls.map((c) => c[0])).toEqual(["upgrade", "history"]);
  });

  it("fails closed when helm history is valid JSON but not an array", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") return { stdout: "", stderr: IN_PROGRESS, code: 1 };
      if (args[0] === "history") {
        return { stdout: JSON.stringify({ error: "boom" }), stderr: "", code: 0 };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /no usable revision history during recovery/,
    );
    expect(calls.map((c) => c[0])).toEqual(["upgrade", "history"]);
  });

  it("fails closed when helm history is an array but no item has the {revision,status} shape", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") return { stdout: "", stderr: IN_PROGRESS, code: 1 };
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ foo: 1 }, { revision: "not-a-number" }]),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /no usable revision history during recovery/,
    );
    expect(calls.map((c) => c[0])).toEqual(["upgrade", "history"]);
  });

it("pre-flight detects pending-upgrade and rolls back BEFORE attempting upgrade (the bender-OOM wedge class)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({ info: { status: "pending-upgrade" } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([
            { revision: 3, status: "deployed" },
            { revision: 4, status: "pending-upgrade" },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const log = vi.fn();
    const runner = createHelmSubprocessRunner({ runHelm, log });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

expect(calls.map((c) => c[0])).toEqual([
      "status",
      "history",
      "rollback",
      "upgrade",
    ]);
    
    const rollback = calls.find((c) => c[0] === "rollback")!;
    expect(rollback).toContain("3");
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/pre-flight.*pending-upgrade/),
    );
  });

  it("pre-flight detects pending-rollback (Cowboy killed mid-recovery) — same shape, recovers + upgrades", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({ info: { status: "pending-rollback" } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 2, status: "deployed" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "status",
      "history",
      "rollback",
      "upgrade",
    ]);
  });

  it("pre-flight detects pending-install (failed first-install) — uninstalls then upgrades", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({ info: { status: "pending-install" } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "history") {
        return {

stdout: JSON.stringify([{ revision: 1, status: "pending-install" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "uninstall") return { stdout: "ok", stderr: "", code: 0 };
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "status",
      "history",
      "uninstall",
      "upgrade",
    ]);
  });

  it("pre-flight on a healthy 'deployed' release skips recovery (no extra helm calls)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({ info: { status: "deployed" } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

expect(calls.map((c) => c[0])).toEqual(["status", "upgrade"]);
  });

  it("pre-flight on a 'failed' (non-pending) release skips recovery (helm upgrade can override a failed state)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({ info: { status: "failed" } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();
    expect(calls.map((c) => c[0])).toEqual(["status", "upgrade"]);
  });

  it("pre-flight on a non-existent release (fresh install) proceeds directly to upgrade", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: "",
          stderr: "Error: release: not found",
          code: 1,
        };
      }
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();
    
    expect(calls.map((c) => c[0])).toEqual(["status", "upgrade"]);
  });

  it("pre-flight surfaces a non-not-found helm status error (no silent swallow)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: "",
          stderr: "Error: Kubernetes cluster unreachable: context deadline exceeded",
          code: 1,
        };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /helm status.*Kubernetes cluster unreachable/,
    );

expect(calls.map((c) => c[0])).toEqual(["status"]);
  });
});

describe("createHelmSubprocessRunner — removeInstance", () => {
  it("runs `helm uninstall octogee-gw-<name> -n <ns> --wait`", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "release \"octogee-gw-default\" uninstalled" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.removeInstance({
      namespace: "octogee-test",
      instanceName: "default",
    });

    const args = calls[0];
    expect(args[0]).toBe("uninstall");
    expect(args).toContain("octogee-gw-default");
    expect(args).toContain("-n");
    expect(args).toContain("octogee-test");
    expect(args).toContain("--wait");
  });

  it("treats 'release not found' as a successful no-op (idempotent retire)", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: uninstall: Release not loaded: release: not found" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", instanceName: "ghost" }),
    ).resolves.toBeUndefined();
  });

  it("throws on other non-zero exits (operator notices real failures)", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: pre-delete hook failed" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", instanceName: "broken" }),
    ).rejects.toThrow(/pre-delete hook failed/);
  });

  it("self-heals a release stuck in pending-* before uninstalling (rolls back to last good, then uninstalls)", async () => {
    let uninstalls = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "uninstall") {
        uninstalls++;
        return uninstalls === 1
          ? {
              stdout: "",
              stderr:
                "Error: uninstall failed: another operation (install/upgrade/rollback) is in progress",
              code: 1,
            }
          : { stdout: "release \"octogee-gw-default\" uninstalled", stderr: "", code: 0 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([
            { revision: 2, status: "deployed" },
            { revision: 3, status: "pending-upgrade" },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", instanceName: "default" }),
    ).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "uninstall",
      "history",
      "rollback",
      "uninstall",
    ]);
    expect(calls.find((c) => c[0] === "rollback")).toContain("2");
  });

  it("self-heals a wedged first-install: recovery uninstalls it, retried uninstall is a not-found no-op", async () => {
    let uninstalls = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "uninstall") {
        uninstalls++;
        if (uninstalls === 1) {
          return {
            stdout: "",
            stderr:
              "Error: uninstall failed: another operation (install/upgrade/rollback) is in progress",
            code: 1,
          };
        }
        if (uninstalls === 2) {
          
          return { stdout: "uninstalled", stderr: "", code: 0 };
        }
        
        return { stdout: "", stderr: "Error: release: not found", code: 1 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 1, status: "pending-install" }]),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", instanceName: "default" }),
    ).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "uninstall",
      "history",
      "uninstall",
      "uninstall",
    ]);
  });

  it("does not attempt recovery when uninstall fails 'release not found' (idempotent, no history probing)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "Error: release: not found", code: 1 };
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", instanceName: "ghost" }),
    ).resolves.toBeUndefined();
    expect(calls.map((c) => c[0])).toEqual(["uninstall"]);
  });

  it("surfaces a clear error when recovery before uninstall fails (no retry against a still-stuck release)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "uninstall") {
        return {
          stdout: "",
          stderr:
            "Error: uninstall failed: another operation (install/upgrade/rollback) is in progress",
          code: 1,
        };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 2, status: "deployed" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") {
        return { stdout: "", stderr: "Error: rollback failed", code: 1 };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", instanceName: "default" }),
    ).rejects.toThrow(/rollback/i);
    expect(calls.map((c) => c[0])).toEqual(["uninstall", "history", "rollback"]);
  });
});

describe("spawnHelm — real subprocess wrapper", () => {
  function withHelmBin<T>(bin: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.HELM_BIN;
    process.env.HELM_BIN = bin;
    return fn().finally(() => {
      if (prev === undefined) delete process.env.HELM_BIN;
      else process.env.HELM_BIN = prev;
    });
  }

  it("returns {stdout, code:0} for a successful exit", () =>
    withHelmBin("/bin/sh", async () => {
      const result = await spawnHelm(["-c", "printf hello"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("hello");
    }));

  it("rejects when the binary path does not exist (ENOENT)", () =>
    withHelmBin("/nonexistent/path/to/helm-binary", async () => {
      await expect(spawnHelm(["version"])).rejects.toThrow();
    }));

  it("preserves a non-zero exit code rather than coercing to 0", () =>
    withHelmBin("/bin/sh", async () => {
      const result = await spawnHelm(["-c", "exit 7"]);
      expect(result.code).toBe(7);
    }));

  it("encodes signal-terminated runs as code !== 0 (no silent success on SIGKILL)", () =>
    withHelmBin("/bin/sh", async () => {
      const result = await spawnHelm(["-c", "kill -TERM $$"]);
      expect(result.code).not.toBe(0);
    }));
});
