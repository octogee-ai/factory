import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADD_GATEWAY_DEPLOYMENT_READY_TIMEOUT_MS,
  bootstrapGlmGateways,
  versionFromImageTag,
} from "../index";

function firestore(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map(Object.entries(seed));
  let operation = 0;
  const snapshot = (path: string) => ({
    exists: store.has(path),
    data: () => store.get(path),
  });
  const document = (path: string) => ({
    id: path.split("/").at(-1),
    path,
    get: async () => snapshot(path),
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const collection = (path: string) => ({
    doc: (id?: string) => document(`${path}/${id ?? `op-${++operation}`}`),
  });
  const db = {
    collection,
    runTransaction: async (
      body: (transaction: {
        get: (ref: { path: string }) => Promise<ReturnType<typeof snapshot>>;
        set: (
          ref: { path: string },
          data: Record<string, unknown>,
          options?: { merge?: boolean },
        ) => void;
      }) => Promise<void>,
    ) => {
      await body({
        get: async (ref) => snapshot(ref.path),
        set: (ref, data, options) => {
          store.set(
            ref.path,
            options?.merge ? { ...store.get(ref.path), ...data } : data,
          );
        },
      });
    },
  };
  return { db, store };
}

function controllerDeps(seed: Record<string, Record<string, unknown>> = {}) {
  const { db, store } = firestore(seed);
  return {
    db: db as unknown as Parameters<typeof bootstrapGlmGateways>[0]["db"],
    store,
    helm: {
      readDeployedInstances: vi.fn(async () => ({})),
    } as Parameters<typeof bootstrapGlmGateways>[0]["helm"],
    handlers: {} as Parameters<typeof bootstrapGlmGateways>[0]["handlers"],
    log: vi.fn(),
    ensureGatewayAuthSecret: vi.fn(async () => ({ token: "test-token" })),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("legacy bootstrap is disabled", () => {
  it("does not inspect Helm or create bare desired documents", async () => {
    const deps = controllerDeps();

    await bootstrapGlmGateways(deps);

    expect(deps.helm.readDeployedInstances).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("bootstrap disabled"));
  });
});

describe("versionFromImageTag", () => {
  it("publishes the complete OpenClaw-qualified tag as the operator observed version", () => {
    expect(versionFromImageTag("cf36a88-oc2026.7.1")).toBe("cf36a88-oc2026.7.1");
  });

  it("preserves an unqualified immutable tag exactly", () => {
    expect(versionFromImageTag("cf36a88")).toBe("cf36a88");
  });

  it("uses the immutable tag name for a digest-pinned candidate heartbeat", () => {
    expect(versionFromImageTag(`8c356bb-oc2026.7.1@sha256:${"a".repeat(64)}`)).toBe(
      "8c356bb-oc2026.7.1",
    );
  });
});

describe("cold gateway provisioning window", () => {
  it("allows a Spot scale-up and first image pull to run for thirty minutes", () => {
    expect(ADD_GATEWAY_DEPLOYMENT_READY_TIMEOUT_MS).toBe(30 * 60_000);
  });
});
