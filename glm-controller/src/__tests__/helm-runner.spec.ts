import { describe, it, expect, vi } from "vitest";
import type { HelmInstancesMap } from "../../../shared/types/glm";
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

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

describe("createHelmSubprocessRunner — readDeployedInstances", () => {
  it("calls `helm get values <release> -n <ns> -o json` and parses gateway.instances", async () => {
    const { runHelm, calls } = mockSubprocess([
      {
        stdout: JSON.stringify({
          gateway: {
            instances: {
              default: {
                enabled: true,
                image: { repository: REPO, tag: "abc1234" },
                gatewayId: "gw-test",
              },
              canary: {
                enabled: true,
                image: { repository: REPO, tag: "def5678" },
                gatewayId: "gw-test-canary",
              },
            },
          },
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    const map = await runner.readDeployedInstances({
      release: "octogee",
      namespace: "octogee-test",
    });

    expect(calls[0]).toEqual([
      "get",
      "values",
      "octogee",
      "-n",
      "octogee-test",
      "-o",
      "json",
    ]);
    expect(map.default.image.tag).toBe("abc1234");
    expect(map.canary.image.tag).toBe("def5678");
  });

  it("returns an empty map when the release has no gateway.instances yet (first install)", async () => {
    const { runHelm } = mockSubprocess([{ stdout: "{}" }]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });
    const map = await runner.readDeployedInstances({
      release: "octogee",
      namespace: "octogee-test",
    });
    expect(map).toEqual({});
  });

  it("returns an empty map when the release does not exist (helm exits 1 with 'not found')", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: release: not found" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });
    const map = await runner.readDeployedInstances({
      release: "octogee",
      namespace: "octogee-test",
    });
    expect(map).toEqual({});
  });

  it("throws when helm exits non-zero for any other reason", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: connection refused" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });
    await expect(
      runner.readDeployedInstances({ release: "octogee", namespace: "octogee-test" }),
    ).rejects.toThrow(/connection refused/);
  });
});

describe("createHelmSubprocessRunner — upgrade", () => {
  const desired: HelmInstancesMap = {
    default: {
      enabled: true,
      image: { repository: REPO, tag: "abc1234" },
      gatewayId: "gw-test",
    },
    canary: {
      enabled: true,
      image: { repository: REPO, tag: "def5678" },
      gatewayId: "gw-test-canary",
    },
  };

  it("runs `helm upgrade --install <release> <chart> -n <ns> --reuse-values --set-json gateway.instances=<json> --wait --timeout=10m`", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "Release \"octogee\" has been upgraded." }]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await runner.upgrade({
      release: "octogee",
      chart: "/charts/octogee",
      namespace: "octogee-test",
      instances: desired,
    });

    expect(calls).toHaveLength(1);
    const args = calls[0];
    expect(args[0]).toBe("upgrade");
    expect(args).toContain("--install");
    expect(args).toContain("octogee");
    expect(args).toContain("/charts/octogee");
    expect(args).toContain("-n");
    expect(args).toContain("octogee-test");
    expect(args).toContain("--reuse-values");

    const setJsonIdx = args.indexOf("--set-json");
    expect(setJsonIdx).toBeGreaterThan(-1);
    const setJsonValue = args[setJsonIdx + 1];
    expect(setJsonValue.startsWith("gateway.instances=")).toBe(true);
    const json = JSON.parse(setJsonValue.slice("gateway.instances=".length));
    expect(json).toEqual(desired);

    expect(args).toContain("--wait");
    expect(args.some((a) => a.startsWith("--timeout="))).toBe(true);
  });

  it("propagates helm failures with stdout + stderr in the error message (visible in controller logs)", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stdout: "started", stderr: "Error: timed out waiting for condition" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(
      runner.upgrade({
        release: "octogee",
        chart: "/charts/octogee",
        namespace: "octogee-test",
        instances: desired,
      }),
    ).rejects.toThrow(/timed out waiting for condition/);
  });

  it("logs a one-line summary on success", async () => {
    const log = vi.fn();
    const { runHelm } = mockSubprocess([{ stdout: "" }]);
    const runner = createHelmSubprocessRunner({ runHelm, log });
    await runner.upgrade({
      release: "octogee",
      chart: "/charts/octogee",
      namespace: "octogee-test",
      instances: desired,
    });
    const messages = log.mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes("upgrade") && m.includes("octogee"))).toBe(true);
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
