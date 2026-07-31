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

describe("createKubeSubprocessRunner — readAvailableReplicas", () => {
  it("returns the deployment's .status.availableReplicas via kubectl get -o jsonpath", async () => {
    const { runKubectl, calls } = mockSubprocess([{ stdout: "1" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const replicas = await kube.readAvailableReplicas({
      namespace: "octogee-test",
      name: "octogee-gateway-bender",
    });

    expect(replicas).toBe(1);
    expect(calls[0]).toEqual([
      "-n",
      "octogee-test",
      "get",
      "deploy/octogee-gateway-bender",
      "-o",
      "jsonpath={.status.availableReplicas}",
    ]);
  });

  it("returns zero when availableReplicas is absent on an existing deployment", async () => {
    const { runKubectl } = mockSubprocess([{ stdout: "" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.readAvailableReplicas({
        namespace: "octogee-test",
        name: "octogee-gateway-bender",
      }),
    ).resolves.toBe(0);
  });

  it("returns null when the deployment does not exist (NotFound)", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stderr: 'Error from server (NotFound): deployments.apps "x" not found',
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const replicas = await kube.readAvailableReplicas({
      namespace: "octogee-test",
      name: "octogee-gateway-bender",
    });

    expect(replicas).toBeNull();
  });

  it("throws when stdout is non-numeric (signal mismatch — never quiet)", async () => {
    const { runKubectl } = mockSubprocess([{ stdout: "banana" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.readAvailableReplicas({
        namespace: "octogee-test",
        name: "octogee-gateway-bender",
      }),
    ).rejects.toThrow(/availableReplicas/);
  });
});

describe("createKubeSubprocessRunner — readGatewayPodDiagnostics", () => {
  it("summarizes kubectl get pods output for a gateway", async () => {
    const { runKubectl, calls } = mockSubprocess([
      {
        stdout: JSON.stringify({
          items: [
            {
              metadata: {
                name: "octogee-gateway-bender-abc",
                creationTimestamp: "2026-06-27T10:00:00.000Z",
              },
              spec: { nodeName: "gke-node-1" },
              status: {
                phase: "Running",
                containerStatuses: [
                  { name: "gateway", ready: true, restartCount: 1 },
                  { name: "gateway-edge", ready: true, restartCount: 2 },
                ],
              },
            },
          ],
        }),
      },
    ]);
    const kube = createKubeSubprocessRunner({
      runKubectl,
      log: vi.fn(),
      now: () => new Date("2026-06-27T10:02:00.000Z").getTime(),
    });

    const diagnostics = await kube.readGatewayPodDiagnostics({
      namespace: "octogee-test",
      gatewayId: "bender",
    });

    expect(calls[0]).toEqual([
      "-n",
      "octogee-test",
      "get",
      "pods",
      "-l",
      "gateway-instance=bender",
      "-o",
      "json",
    ]);
    expect(diagnostics).toMatchObject({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      totalRestarts: 3,
      pods: [
        {
          name: "octogee-gateway-bender-abc",
          phase: "Running",
          readyContainers: 2,
          totalContainers: 2,
          restarts: 3,
          reason: null,
          nodeName: "gke-node-1",
          ageMs: 120_000,
        },
      ],
    });
  });

  it("surfaces waiting reasons and reports not-ready pods", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stdout: JSON.stringify({
          items: [
            {
              metadata: { name: "octogee-gateway-bender-def" },
              status: {
                phase: "Pending",
                containerStatuses: [
                  {
                    name: "gateway",
                    ready: false,
                    restartCount: 4,
                    state: { waiting: { reason: "CrashLoopBackOff" } },
                  },
                ],
              },
            },
          ],
        }),
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.readGatewayPodDiagnostics({
        namespace: "octogee-test",
        gatewayId: "bender",
      }),
    ).resolves.toMatchObject({
      status: "not-ready",
      totalPods: 1,
      readyPods: 0,
      totalRestarts: 4,
      pods: [{ phase: "Pending", reason: "CrashLoopBackOff" }],
    });
  });

  it("reads every gateway's pod diagnostics with one kubectl invocation", async () => {
    const { runKubectl, calls } = mockSubprocess([
      {
        stdout: JSON.stringify({
          items: [
            {
              metadata: {
                name: "octogee-gateway-alpha-abc",
                labels: { "gateway-instance": "alpha" },
              },
              status: {
                phase: "Running",
                containerStatuses: [
                  { name: "gateway", ready: true, restartCount: 0 },
                  { name: "gateway-edge", ready: true, restartCount: 0 },
                ],
              },
            },
            {
              metadata: {
                name: "octogee-gateway-bravo-def",
                labels: { "gateway-instance": "bravo" },
              },
              status: {
                phase: "Pending",
                containerStatuses: [
                  {
                    name: "gateway",
                    ready: false,
                    restartCount: 1,
                    state: { waiting: { reason: "ContainerCreating" } },
                  },
                ],
              },
            },
          ],
        }),
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const diagnostics = await kube.readGatewayPodDiagnosticsBatch({
      namespace: "octogee-test",
      gatewayIds: ["alpha", "bravo", "charlie"],
    });

    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "get",
        "pods",
        "-l",
        "app=octogee-gateway",
        "-o",
        "json",
      ],
    ]);
    expect(diagnostics).toMatchObject({
      alpha: { status: "ready", totalPods: 1, readyPods: 1 },
      bravo: {
        status: "not-ready",
        totalPods: 1,
        readyPods: 0,
        totalRestarts: 1,
        pods: [{ reason: "ContainerCreating" }],
      },
      charlie: { status: "missing", totalPods: 0, readyPods: 0 },
    });
  });
});

describe("createKubeSubprocessRunner — deletePersistentVolumeClaim", () => {
  it("deletes the named PVC idempotently", async () => {
    const { runKubectl, calls } = mockSubprocess([
      { stdout: "persistentvolumeclaim/octogee-gateway-bender-data deleted" },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.deletePersistentVolumeClaim({
      namespace: "octogee-test",
      name: "octogee-gateway-bender-data",
    });

    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "delete",
        "pvc/octogee-gateway-bender-data",
        "--ignore-not-found=true",
      ],
    ]);
  });

  it("throws on kubectl delete PVC failures", async () => {
    const { runKubectl } = mockSubprocess([
      { stderr: "Error from server (Forbidden): denied", code: 1 },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.deletePersistentVolumeClaim({
        namespace: "octogee-test",
        name: "octogee-gateway-bender-data",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("createKubeSubprocessRunner — deleteSecret", () => {
  it("deletes the named secret idempotently", async () => {
    const { runKubectl, calls } = mockSubprocess([
      { stdout: "secret/gateway-auth-token-bender deleted" },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.deleteSecret({
      namespace: "octogee-test",
      name: "gateway-auth-token-bender",
    });

    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "delete",
        "secret/gateway-auth-token-bender",
        "--ignore-not-found=true",
      ],
    ]);
  });

  it("throws on kubectl delete secret failures", async () => {
    const { runKubectl } = mockSubprocess([
      { stderr: "Error from server (Forbidden): denied", code: 1 },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.deleteSecret({
        namespace: "octogee-test",
        name: "gateway-auth-token-bender",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("createKubeSubprocessRunner — delete gateway-owned identity and service", () => {
  it("deletes a ServiceAccount and Service idempotently", async () => {
    const { runKubectl, calls } = mockSubprocess([{}, {}]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.deleteServiceAccount({ namespace: "octogee-test", name: "octogee-gw-bender" });
    await kube.deleteService({ namespace: "octogee-test", name: "gateway-edge-bender" });

    expect(calls).toEqual([
      ["-n", "octogee-test", "delete", "serviceaccount/octogee-gw-bender", "--ignore-not-found=true"],
      ["-n", "octogee-test", "delete", "service/gateway-edge-bender", "--ignore-not-found=true"],
    ]);
  });

  it("surfaces deletion failures", async () => {
    const { runKubectl } = mockSubprocess([{ stderr: "Forbidden", code: 1 }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.deleteServiceAccount({ namespace: "octogee-test", name: "octogee-gw-bender" }),
    ).rejects.toThrow(/Forbidden/);
  });
});
