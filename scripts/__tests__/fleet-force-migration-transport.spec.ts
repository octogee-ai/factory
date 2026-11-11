import { describe, expect, it, vi } from "vitest";
import { Script } from "node:vm";
import { createForceMigrationTransport, forceMigrationProbeSource, observeForcedRestart, dispatchForcedRestart } from "../ops/fleet-force-migration-transport.js";

function harness() {
  const pod = { metadata: { name: "pod", uid: "uid", labels: { "gateway-instance": "shared-a" } },
    spec: { containers: [{ name: "gateway", image: "retained-recovery-image" }] }, status: { phase: "Running" } };
  const runKubectl = vi.fn(async (args: string[], options?: { stdin?: string }) => {
    const result = args.includes("pods") ? { items: [pod] } : args.includes("get") ? pod : options?.stdin?.includes("gateway.restart.request") ? { ok: true, status: "emitted", pid: 90 } :
      options?.stdin?.includes("boot-before") ? { version: 1, attemptId: "attempt", beforeBootId: "boot-before", afterBootId: "boot-after", ready: true } : { bootId: "boot-before", nativeOwner: { pid: 90, ownerId: "native-owner", port: 18789 } };
    return { code: 0, stdout: JSON.stringify(result), stderr: "" };
  });
  return { pod, runKubectl, transport: createForceMigrationTransport({ namespace: "shared-test", runKubectl }) };
}

describe("native Fleet force transport", () => {
  it("uses native force and verifies the same retained pod/image after changed-boot readiness", async () => {
    const h = harness();
    const bound = await h.transport.capture("shared-a");
    await h.transport.dispatch(bound);
    await expect(h.transport.observe(bound, "attempt")).resolves.toMatchObject({ afterBootId: "boot-after", ready: true });
    const mutations = h.runKubectl.mock.calls.filter(([args]) => args.includes("openclaw"));
    expect(mutations).toEqual([]);
    expect(h.runKubectl.mock.calls.some(([, options]) => options?.stdin?.includes("gateway.restart.request"))).toBe(true);
    expect(h.runKubectl.mock.calls.every(([args]) => !args.some(arg => ["delete", "patch", "--safe"].includes(arg)))).toBe(true);
  });

  it("surfaces the native JSON error on nonzero exit without exposing other payload fields", async () => {
    const h = harness();
    const original = h.runKubectl.getMockImplementation()!;
    h.runKubectl.mockImplementation(async (args, options) => options?.stdin?.includes("gateway.restart.request") ? {
      code: 1,
      stdout: JSON.stringify({ ok: false, error: "Gateway restart failed: lock owner unavailable token=private-token", auth: "private-auth" }),
      stderr: "command terminated with exit code 1",
    } : original(args, options));
    const bound = await h.transport.capture("shared-a");
    const error = await h.transport.dispatch(bound).catch((cause: Error) => cause);
    expect(String(error)).toContain("Gateway restart failed: lock owner unavailable token=[redacted]");
    expect(String(error)).toContain("command terminated with exit code 1");
    expect(String(error)).toContain("observe without restarting");
    expect(String(error)).not.toMatch(/private-token|private-auth/);
    expect(h.runKubectl.mock.calls.filter(([, options]) => options?.stdin?.includes("gateway.restart.request"))).toHaveLength(1);
  });

  it.each(["Bearer", "Basic"])("redacts the complete %s Authorization credential in restart diagnostics", async scheme => {
    const h = harness();
    const original = h.runKubectl.getMockImplementation()!;
    h.runKubectl.mockImplementation(async (args, options) => options?.stdin?.includes("gateway.restart.request") ? {
      code: 1,
      stdout: JSON.stringify({ ok: false, error: `request failed Authorization: ${scheme} private-native-credential` }),
      stderr: `proxy rejected authorization=${scheme} private-proxy-credential\ncommand terminated`,
    } : original(args, options));
    const bound = await h.transport.capture("shared-a");
    const error = await h.transport.dispatch(bound).catch((cause: Error) => cause);
    expect(String(error)).toContain("Authorization: [redacted]");
    expect(String(error)).toContain("authorization=[redacted]");
    expect(String(error)).not.toMatch(/private-native-credential|private-proxy-credential/);
  });

  it.each(["uid", "image"])("refuses changed %s without force or readiness success", async changed => {
    const h = harness();
    const bound = await h.transport.capture("shared-a");
    if (changed === "uid") h.pod.metadata.uid = "replacement";
    else h.pod.spec.containers[0]!.image = "replacement";
    await expect(h.transport.dispatch(bound)).rejects.toThrow("identity or image changed");
    await expect(h.transport.observe(bound, "attempt")).rejects.toThrow("identity or image changed");
    expect(h.runKubectl.mock.calls.some(([args]) => args.includes("openclaw"))).toBe(false);
  });

  it("waits for changed boot and full readiness without issuing any restart RPC", async () => {
    let now = 0;
    const connection = { bootId: "boot-after", request: vi.fn(async () => ({})), alive: () => true, close: vi.fn() };
    const deps = { connect: vi.fn(async () => connection), ready: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      now: () => now, wait: async () => { now += 1000; } };
    await expect(observeForcedRestart(deps, "boot-before", "attempt", 3000)).resolves.toMatchObject({ afterBootId: "boot-after" });
    expect(connection.request.mock.calls).toEqual([["health", {}]]);
    deps.ready.mockResolvedValue(false);
    await expect(observeForcedRestart(deps, "boot-before", "attempt", 2000)).rejects.toThrow("unconfirmed");
    expect(connection.request).toHaveBeenCalledTimes(1);
  });

  it.each(["exact", "boot", "owner", "ack", "lost-ack"])("binds native force to the captured owner and boot: %s", async scenario => {
    const nativeOwner = { pid: 90, ownerId: "native-owner", port: 18789 };
    const bound = { podName: "pod", podUid: "uid", containerImage: "image", beforeBootId: "before", nativeOwner };
    const connection = { bootId: scenario === "boot" ? "different" : "before", alive: () => true, close: vi.fn(),
      request: vi.fn(async () => {
        if (scenario === "lost-ack") throw new Error("socket closed");
        return { ok: true, status: "emitted", pid: scenario === "ack" ? 91 : 90 };
      }) };
    const deps = { connect: async () => connection, now: Date.now, ready: async () => true, wait: async () => {} };
    const pending = dispatchForcedRestart(deps, bound, async () => ({ ...nativeOwner, ownerId: scenario === "owner" ? "replacement" : "native-owner" }));
    if (scenario === "exact") {
      await expect(pending).resolves.toMatchObject({ ok: true, pid: 90 });
      expect(connection.request).toHaveBeenCalledWith("gateway.restart.request", {
        reason: "octogee.force-migration", target: nativeOwner, restartIntent: { force: true, drainBudgetMs: 30000 },
      });
    } else await expect(pending).rejects.toThrow();
    expect(connection.request).toHaveBeenCalledTimes(["boot", "owner"].includes(scenario) ? 0 : 1);
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("serializes both read-only probes as runnable JavaScript", () => {
    expect(() => new Script(forceMigrationProbeSource())).not.toThrow();
    expect(() => new Script(forceMigrationProbeSource({ beforeBootId: "before", attemptId: "attempt" }))).not.toThrow();
  });
});
