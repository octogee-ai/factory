import { describe, it, expect, vi } from "vitest";
import {
  createKubeSubprocessRunner,
  type KubectlSubprocess,
} from "../lib/kube-ops";

function mockSubprocess(
  responses: Array<{ stdout?: string; stderr?: string; code?: number }>,
): { runKubectl: KubectlSubprocess; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const runKubectl: KubectlSubprocess = vi.fn(async (args: string[]) => {
    calls.push(args);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: r.code ?? 0,
    };
  });
  return { runKubectl, calls };
}

describe("createKubeSubprocessRunner — scaleDeployment", () => {
  it("builds correct kubectl scale argv for the targeted deployment", async () => {
    const { runKubectl, calls } = mockSubprocess([{ stdout: "deployment.apps/x scaled" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.scaleDeployment({
      namespace: "octogee-test",
      name: "octogee-gateway-bender",
      replicas: 0,
    });

    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "scale",
        "deploy/octogee-gateway-bender",
        "--replicas=0",
      ],
    ]);
  });

  it("scales back up with --replicas=1 on resume", async () => {
    const { runKubectl, calls } = mockSubprocess([{ stdout: "" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.scaleDeployment({
      namespace: "octogee",
      name: "octogee-gateway-default",
      replicas: 1,
    });

    expect(calls[0]).toContain("--replicas=1");
  });

  it("treats NotFound on scale as idempotent success (no throw, log only)", async () => {
    const log = vi.fn();
    const { runKubectl } = mockSubprocess([
      {
        stderr: 'Error from server (NotFound): deployments.apps "octogee-gateway-bender" not found',
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log });

    await expect(
      kube.scaleDeployment({
        namespace: "octogee-test",
        name: "octogee-gateway-bender",
        replicas: 0,
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("octogee-gateway-bender"),
    );
  });

  it("throws on non-NotFound scale failures with the stderr surfaced", async () => {
    const { runKubectl } = mockSubprocess([
      { stderr: "Error: connection refused", code: 1 },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.scaleDeployment({
        namespace: "octogee-test",
        name: "octogee-gateway-bender",
        replicas: 0,
      }),
    ).rejects.toThrow(/connection refused/);
  });

  it("rejects negative replicas synchronously before invoking kubectl", async () => {
    const { runKubectl, calls } = mockSubprocess([{}]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.scaleDeployment({
        namespace: "octogee-test",
        name: "octogee-gateway-bender",
        replicas: -1,
      }),
    ).rejects.toThrow(/replicas/);
    expect(calls.length).toBe(0);
  });
});

describe("createKubeSubprocessRunner — restartDeployment", () => {
  it("builds correct kubectl rollout restart argv", async () => {
    const { runKubectl, calls } = mockSubprocess([
      { stdout: "deployment.apps/octogee-gateway-bender restarted" },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.restartDeployment({
      namespace: "octogee-test",
      name: "octogee-gateway-bender",
    });

    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "rollout",
        "restart",
        "deploy/octogee-gateway-bender",
      ],
    ]);
  });

  it("throws on NotFound during restart (restart against nothing is a real mistake)", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stderr: 'Error from server (NotFound): deployments.apps "octogee-gateway-bender" not found',
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.restartDeployment({
        namespace: "octogee-test",
        name: "octogee-gateway-bender",
      }),
    ).rejects.toThrow(/NotFound/);
  });

  it("throws on non-NotFound restart failures", async () => {
    const { runKubectl } = mockSubprocess([
      { stderr: "Error: unauthorized", code: 1 },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.restartDeployment({
        namespace: "octogee-test",
        name: "octogee-gateway-bender",
      }),
    ).rejects.toThrow(/unauthorized/);
  });
});

describe("createKubeSubprocessRunner — readDeployedReplicas", () => {
  it("returns the deployment's .spec.replicas via kubectl get -o jsonpath", async () => {
    const { runKubectl, calls } = mockSubprocess([{ stdout: "0" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const replicas = await kube.readDeployedReplicas({
      namespace: "octogee-test",
      name: "octogee-gateway-bender",
    });

    expect(replicas).toBe(0);
    expect(calls[0]).toEqual([
      "-n",
      "octogee-test",
      "get",
      "deploy/octogee-gateway-bender",
      "-o",
      "jsonpath={.spec.replicas}",
    ]);
  });

  it("returns null when the deployment does not exist (NotFound)", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stderr: 'Error from server (NotFound): deployments.apps "x" not found',
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const replicas = await kube.readDeployedReplicas({
      namespace: "octogee-test",
      name: "octogee-gateway-bender",
    });

    expect(replicas).toBeNull();
  });

  it("throws when stdout is non-numeric (signal mismatch — never quiet)", async () => {
    const { runKubectl } = mockSubprocess([{ stdout: "banana" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.readDeployedReplicas({
        namespace: "octogee-test",
        name: "octogee-gateway-bender",
      }),
    ).rejects.toThrow(/replicas/);
  });
});
