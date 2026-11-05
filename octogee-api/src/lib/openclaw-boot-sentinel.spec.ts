import { describe, expect, it } from "vitest";
import { createOpenClawBootSentinelStore } from "./openclaw-boot-sentinel.js";

const gatewayId = "ceckert-m-f6736258";
const boot = { gatewayId, podName: "octogee-gateway-ceckert-m-f6736258-abc123-def45", podUid: "boot-1", releaseKey: "62cab13@sha256:abc" };

function fixture() {
  const data: Record<string, Record<string, unknown>> = {
    [`glmGateways/${gatewayId}`]: { gatewayId, status: "running" },
    [`gateways/${gatewayId}`]: { gatewayId, gatewayClass: "builder" },
  };
  const ref = (path: string) => ({ path });
  const db = {
    doc: ref,
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async (body: (txn: unknown) => Promise<unknown>) => {
      const writes: Array<{ path: string; patch: Record<string, unknown> }> = [];
      const result = await body({
        get: async (r: { path: string }) => ({ exists: Object.hasOwn(data, r.path), data: () => data[r.path] }),
        update: (r: { path: string }, patch: Record<string, unknown>) => writes.push({ path: r.path, patch }),
      });
      for (const { path, patch } of writes) Object.assign(data[path], patch);
      return result;
    },
  };
  return { data, store: createOpenClawBootSentinelStore(db as never, () => 300) };
}

describe("OpenClaw boot sentinel", () => {
  it("answers start to every claim of a release, however many boots failed before it", async () => {
    const f = fixture();
    const claims = [await f.store.claim(boot), await f.store.claim(boot), await f.store.claim({ ...boot, podUid: "boot-2" })];
    expect(claims).toEqual([{ action: "start" }, { action: "start" }, { action: "start" }]);
  });

  it("keeps no boot state on the gateway runtime", async () => {
    const f = fixture();
    await f.store.claim(boot);
    await f.store.claim(boot);
    expect(f.data[`glmGateways/${gatewayId}`]).toEqual({ gatewayId, status: "running" });
  });

  it("records the healthy OpenClaw build and nothing else on completion", async () => {
    const f = fixture();
    await f.store.claim(boot);
    await expect(f.store.complete({ ...boot, openclawBuild: "e".repeat(40) })).resolves.toBe(true);
    expect(f.data[`glmGateways/${gatewayId}`]).toEqual({ gatewayId, status: "running", openclawHealthyBuild: "e".repeat(40) });
  });

  it("refuses a claim for a gateway without a runtime document", async () => {
    const f = fixture();
    await expect(f.store.claim({ ...boot, gatewayId: "missing" })).resolves.toBeNull();
  });
});
