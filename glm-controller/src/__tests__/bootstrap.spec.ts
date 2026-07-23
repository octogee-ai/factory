import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADD_GATEWAY_DEPLOYMENT_READY_TIMEOUT_MS,
  bootstrapDefaultGateway,
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

  it("does not seed a default gateway unless Helm explicitly enables it", async () => {
    const deps = controllerDeps();

    await bootstrapDefaultGateway(deps);

    expect(deps.helm.readDeployedInstances).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("bootstrap disabled"));
  });
});

describe("durable default gateway bootstrap", () => {
  it("fails explicitly before creating credentials when the immutable image tag is missing", async () => {
    vi.stubEnv("BOOTSTRAP_DEFAULT_GATEWAY", "true");
    vi.stubEnv(
      "BOOTSTRAP_IMAGE_REPOSITORY",
      "us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    );
    const deps = controllerDeps();

    await expect(bootstrapDefaultGateway(deps)).rejects.toThrow(
      "BOOTSTRAP_IMAGE_TAG must be an immutable gateway image tag",
    );

    expect(deps.ensureGatewayAuthSecret).not.toHaveBeenCalled();
    expect(deps.store.size).toBe(0);
  });

  it("creates release 1 and a normal add operation when explicitly enabled", async () => {
    vi.stubEnv("BOOTSTRAP_DEFAULT_GATEWAY", "true");
    vi.stubEnv(
      "BOOTSTRAP_IMAGE_REPOSITORY",
      "us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    );
    vi.stubEnv("BOOTSTRAP_IMAGE_TAG", "753c212");
    const deps = controllerDeps();

    await bootstrapDefaultGateway(deps);

    expect(deps.ensureGatewayAuthSecret).toHaveBeenCalledWith({
      namespace: "octogee",
      gatewayId: "default",
    });
    expect(deps.store.get("gateways/default")).toMatchObject({
      gatewayId: "default",
      latestRelease: 1,
      desiredRelease: 1,
      gatewayClass: "shared",
    });
    expect(deps.store.get("gateways/default/releases/1")).toMatchObject({
      gatewayId: "default",
      release: 1,
      payload: {
        imageRepository:
          "us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway",
        imageTag: "753c212",
      },
    });
    expect(
      [...deps.store.entries()].find(
        ([path, value]) =>
          path.startsWith("glmOperations/") && value.kind === "add-gateway",
      )?.[1],
    ).toMatchObject({
      status: "pending",
      input: {
        gatewayId: "default",
        imageTag: "753c212",
        gatewayClass: "shared",
      },
    });
  });

  it("leaves an existing durable default untouched", async () => {
    vi.stubEnv("BOOTSTRAP_DEFAULT_GATEWAY", "true");
    vi.stubEnv(
      "BOOTSTRAP_IMAGE_REPOSITORY",
      "us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    );
    vi.stubEnv("BOOTSTRAP_IMAGE_TAG", "canonical-test");
    const deps = controllerDeps({
      "gateways/default": {
        gatewayId: "default",
        latestRelease: 1,
        desiredRelease: 1,
      },
      "gateways/default/releases/1": {
        gatewayId: "default",
        release: 1,
      },
    });

    await bootstrapDefaultGateway(deps);

    expect(deps.ensureGatewayAuthSecret).not.toHaveBeenCalled();
    expect(
      [...deps.store.keys()].filter((path) => path.startsWith("glmOperations/")),
    ).toEqual([]);
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
    expect(versionFromImageTag(`agent-conversation-w9a-8c356bb1@sha256:${"a".repeat(64)}`)).toBe(
      "agent-conversation-w9a-8c356bb1",
    );
  });
});

describe("cold gateway provisioning window", () => {
  it("allows a Spot scale-up and first image pull to run for thirty minutes", () => {
    expect(ADD_GATEWAY_DEPLOYMENT_READY_TIMEOUT_MS).toBe(30 * 60_000);
  });
});
