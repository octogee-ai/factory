import { describe, it, expect, vi } from "vitest";
import {
  createAuthSecretEnsurer,
  type KubectlSubprocess,
} from "../auth-secret-ensurer";

function mockKubectl(
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

// Why this ensurer exists (gw-bender 2026-05-24 post-mortem):
// OPENCLAW_GATEWAY_TOKEN used to be generated inside the gateway pod by
// entrypoint.sh and mirrored to GCP Secret Manager. K8s/helm were blind to
// it. When an operator manually `kubectl set env`'d a missing OPENCLAW_*
// var into Bender's gateway-edge container to unbreak boot, K8s
// server-side apply remembered the `kubectl-set` field manager and
// collided with helm's strategic-merge patch on the next chart upgrade —
// silently dropping INTERNAL_SERVICE_KEY from the live Deployment.
//
// Fix: platform owns the token via a per-gateway K8s secret threaded by
// the chart via secretKeyRef. Cowboy ensures the secret exists with a
// random hex value before each upsertInstance — idempotent, no
// re-rotation on subsequent reconciles.
describe("createAuthSecretEnsurer", () => {
  it("no-ops when the secret already exists (idempotent: never rotates a live token)", async () => {
    const { runKubectl, calls } = mockKubectl([
      // get → exit 0, secret exists
      { stdout: "secret/gateway-auth-token-gw-test\n", code: 0 },
    ]);
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => "REROLLED_SHOULD_NOT_HAPPEN",
      log: vi.fn(),
    });

    await ensurer.ensureAuthSecret({
      namespace: "octogee-test",
      gatewayId: "gw-test",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 5)).toEqual([
      "get",
      "secret",
      "gateway-auth-token-gw-test",
      "-n",
      "octogee-test",
    ]);
  });

  it("creates the secret with a random token when missing (NotFound from kubectl get)", async () => {
    const generatedToken = "abc123def456".repeat(4);
    const { runKubectl, calls } = mockKubectl([
      // get → NotFound
      {
        stderr:
          'Error from server (NotFound): secrets "gateway-auth-token-gw-test" not found',
        code: 1,
      },
      // create → ok
      {
        stdout: "secret/gateway-auth-token-gw-test created\n",
        code: 0,
      },
    ]);
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => generatedToken,
      log: vi.fn(),
    });

    await ensurer.ensureAuthSecret({
      namespace: "octogee-test",
      gatewayId: "gw-test",
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].slice(0, 4)).toEqual([
      "create",
      "secret",
      "generic",
      "gateway-auth-token-gw-test",
    ]);
    expect(calls[1]).toContain(`--from-literal=token=${generatedToken}`);
    expect(calls[1]).toContain("-n");
    expect(calls[1]).toContain("octogee-test");
  });

  it("throws on a non-NotFound get error (don't silently mask a real cluster failure)", async () => {
    const { runKubectl } = mockKubectl([
      // get → forbidden (NOT not-found)
      {
        stderr:
          'Error from server (Forbidden): secrets "gateway-auth-token-gw-test" is forbidden',
        code: 1,
      },
    ]);
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => "should-not-be-called",
      log: vi.fn(),
    });

    await expect(
      ensurer.ensureAuthSecret({ namespace: "octogee-test", gatewayId: "gw-test" }),
    ).rejects.toThrow(/Forbidden|kubectl get secret/);
  });

  it("throws when kubectl create fails (don't continue past a half-broken state)", async () => {
    const { runKubectl } = mockKubectl([
      { stderr: "NotFound", code: 1 },
      { stderr: "Error: connection refused", code: 1 },
    ]);
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => "abc".repeat(16),
      log: vi.fn(),
    });

    await expect(
      ensurer.ensureAuthSecret({ namespace: "octogee-test", gatewayId: "gw-test" }),
    ).rejects.toThrow(/connection refused|kubectl create secret/);
  });

  it("treats AlreadyExists from kubectl create as success (race with a concurrent ensurer — desired state still satisfied)", async () => {
    // Two reconcilers / two operation workers / a retry racing a peer can both
    // hit `get` → NotFound, both race to `create`, and one loses with
    // AlreadyExists. The desired end state is still satisfied, so this MUST
    // NOT crash the controller and block the helm upsert.
    const { runKubectl, calls } = mockKubectl([
      { stderr: "NotFound", code: 1 },
      {
        stderr:
          'Error from server (AlreadyExists): secrets "gateway-auth-token-gw-test" already exists',
        code: 1,
      },
    ]);
    const log = vi.fn();
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => "racing-loser-token",
      log,
    });

    await expect(
      ensurer.ensureAuthSecret({ namespace: "octogee-test", gatewayId: "gw-test" }),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe("create");
    // Visible log breadcrumb so the operator can correlate with the peer's
    // successful create in the same ns/release window.
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/AlreadyExists|race|concurrent/i),
    );
  });

  it("namespaces the secret name by gatewayId so two gateways never share a token", async () => {
    const { runKubectl, calls } = mockKubectl([
      { stdout: "secret/gateway-auth-token-gw-bender\n", code: 0 },
    ]);
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => "unused",
      log: vi.fn(),
    });

    await ensurer.ensureAuthSecret({
      namespace: "octogee",
      gatewayId: "gw-bender",
    });

    expect(calls[0]).toContain("gateway-auth-token-gw-bender");
  });
});
