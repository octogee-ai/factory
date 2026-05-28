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

describe("createKubeSubprocessRunner — restartOpenClawInPlace", () => {
  it("execs `openclaw gateway restart --safe --skip-deferral` in the gateway container", async () => {
    const { runKubectl, calls } = mockSubprocess([
      { stdout: "safe restart requested; gateway bypassing active-work deferral" },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.restartOpenClawInPlace({
      namespace: "octogee-test",
      name: "octogee-gateway-bender",
    });

    // In-process OpenClaw restart via the local gateway RPC (self-authorizing,
    // --skip-deferral bypasses the idle-drain wait). The container/pod is NOT
    // rolled — only the OpenClaw process restarts. Targets `deploy/<name>` so
    // kubectl selects the (single-replica) gateway pod; `-c gateway` because
    // the openclaw CLI + process live in that container, not gateway-edge.
    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "exec",
        "deploy/octogee-gateway-bender",
        "-c",
        "gateway",
        "--",
        "openclaw",
        "gateway",
        "restart",
        "--safe",
        "--skip-deferral",
      ],
    ]);
  });

  it("throws on NotFound (restart against a gateway that isn't there is a real mistake)", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stderr: 'Error from server (NotFound): deployments.apps "octogee-gateway-bender" not found',
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.restartOpenClawInPlace({
        namespace: "octogee-test",
        name: "octogee-gateway-bender",
      }),
    ).rejects.toThrow(/NotFound/);
  });

  it("throws when the in-pod restart command fails, surfacing stderr (e.g. commands.restart=false)", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stderr:
          "Gateway restart is disabled in the running gateway config (commands.restart=false)",
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.restartOpenClawInPlace({
        namespace: "octogee-test",
        name: "octogee-gateway-bender",
      }),
    ).rejects.toThrow(/commands\.restart=false/);
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
