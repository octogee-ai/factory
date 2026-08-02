import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { mapSaToTenant } from "../sa-to-tenant.js";

type Docs = Record<string, Record<string, unknown>>;

function fakeDb(docs: Docs): Pick<Firestore, "doc" | "collection"> {
  return {
    doc: (path: string) => ({
      get: async () => ({
        exists: docs[path] !== undefined,
        data: () => docs[path],
      }),
    }),
    collection: (name: string) => ({
      where: (field: string, operator: string, value: unknown) => ({
        get: async () => ({
          docs: Object.entries(docs)
            .filter(([path, data]) => {
              if (!path.startsWith(`${name}/`)) return false;
              if (path.slice(name.length + 1).includes("/")) return false;
              return operator === "==" && data[field] === value;
            })
            .map(([path, data]) => ({
              id: path.slice(name.length + 1),
              data: () => data,
            })),
        }),
      }),
    }),
  } as Pick<Firestore, "doc" | "collection">;
}

function durableGateway(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "operator:test",
    updatedAt: 1,
    updatedBy: "operator:test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    liveRevisionId: `${gatewayId}-r1`,
    trafficRevisionId: `${gatewayId}-r1`,
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("mapSaToTenant", () => {
  it("maps per-gateway KSAs from durable root ownership", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        "gateways/bender": durableGateway("bender", {
          gatewayClass: "operator",
          imageProfile: "operator",
          ownerUid: "uid-bender",
          builderSlug: "bender",
        }),
      }),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "bender", ownerUid: "uid-bender" },
    });
  });

  it("maps a gateway with only an empty retired co-owner mirror", async () => {
    await expect(
      mapSaToTenant(
        fakeDb({
          "gateways/bender": durableGateway("bender", {
            gatewayClass: "operator",
            imageProfile: "operator",
            ownerUid: "uid-bender",
            builderSlug: "bender",
            coOwnerUids: [],
          }),
        }),
        { namespace: "octogee", saName: "octogee-gw-bender" },
        "octogee",
      ),
    ).resolves.toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "bender", ownerUid: "uid-bender" },
    });

    await expect(
      mapSaToTenant(
        fakeDb({
          "gateways/bender": durableGateway("bender", {
            gatewayClass: "operator",
            imageProfile: "operator",
            ownerUid: "uid-bender",
            builderSlug: "bender",
            coOwnerUids: ["uid-former-helper"],
          }),
        }),
        { namespace: "octogee", saName: "octogee-gw-bender" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("takes the KSA suffix as the bare gateway id", async () => {
    const result = await mapSaToTenant(
      fakeDb({ "gateways/canary-2": durableGateway("canary-2") }),
      { namespace: "octogee", saName: "octogee-gw-canary-2" },
      "octogee",
    );

    expect(result).toMatchObject({
      attached: true,
      tenant: { gatewayId: "canary-2" },
    });
  });

  it("maps grandfathered operator KSA names through the same durable root", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        "gateways/bender": durableGateway("bender", {
          gatewayClass: "operator",
          imageProfile: "operator",
          ownerUid: "uid-bender",
          builderSlug: "bender",
          serviceAccountName: "octogee-gateway-bender",
        }),
      }),
      { namespace: "octogee", saName: "octogee-gateway-bender" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok_legacy_operator",
      tenant: { kind: "gateway", gatewayId: "bender", ownerUid: "uid-bender" },
    });
  });

  it("maps a custom KSA through exactly one active durable root", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        "gateways/bender": durableGateway("bender", {
          gatewayClass: "operator",
          imageProfile: "operator",
          ownerUid: "uid-bender",
          builderSlug: "bender",
          serviceAccountName: "custom-operator-ksa",
        }),
      }),
      { namespace: "octogee", saName: "custom-operator-ksa" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "bender", ownerUid: "uid-bender" },
    });
  });

  it("denies a custom KSA with no, ambiguous, or retired durable root", async () => {
    await expect(
      mapSaToTenant(
        fakeDb({}),
        { namespace: "octogee", saName: "custom-operator-ksa" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });

    await expect(
      mapSaToTenant(
        fakeDb({
          "gateways/alpha": durableGateway("alpha", { serviceAccountName: "custom-operator-ksa" }),
          "gateways/beta": durableGateway("beta", { serviceAccountName: "custom-operator-ksa" }),
        }),
        { namespace: "octogee", saName: "custom-operator-ksa" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });

    await expect(
      mapSaToTenant(
        fakeDb({
          "gateways/bender": durableGateway("bender", {
            serviceAccountName: "custom-operator-ksa",
            desiredStatus: "retired",
          }),
        }),
        { namespace: "octogee", saName: "custom-operator-ksa" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("requires the prefix KSA to equal the root's effective KSA", async () => {
    await expect(
      mapSaToTenant(
        fakeDb({
          "gateways/bender": durableGateway("bender", {
            serviceAccountName: "custom-operator-ksa",
          }),
        }),
        { namespace: "octogee", saName: "octogee-gw-bender" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });

    await expect(
      mapSaToTenant(
        fakeDb({
          "gateways/bender": durableGateway("bender", {
            serviceAccountName: "octogee-gw-other",
          }),
        }),
        { namespace: "octogee", saName: "octogee-gw-bender" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("soft-fails a namespace mismatch before the root lookup", async () => {
    const result = await mapSaToTenant(
      fakeDb({}),
      { namespace: "octogee-test", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "ns_mismatch" });
  });

  it("soft-fails a missing or malformed durable root", async () => {
    await expect(
      mapSaToTenant(fakeDb({}), { namespace: "octogee", saName: "octogee-gw-bender" }, "octogee"),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
    await expect(
      mapSaToTenant(
        fakeDb({ "gateways/bender": { gatewayId: "bender", desiredStatus: "running" } }),
        { namespace: "octogee", saName: "octogee-gw-bender" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("rejects a retired durable gateway", async () => {
    const result = await mapSaToTenant(
      fakeDb({ "gateways/bender": durableGateway("bender", { desiredStatus: "retired" }) }),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("binds a durable shared gateway without an owner", async () => {
    const result = await mapSaToTenant(
      fakeDb({ "gateways/default": durableGateway("default") }),
      { namespace: "octogee", saName: "octogee-gw-default" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "default" },
    });
  });

  it("never restores an owner from a stale release snapshot", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        "gateways/bender": durableGateway("bender", {
          gatewayClass: "operator",
          imageProfile: "operator",
          ownerUid: "uid-current",
          builderSlug: "bender",
        }),
        "gateways/bender/releases/1": { payload: { ownerUid: "uid-stale" } },
      }),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toMatchObject({
      attached: true,
      tenant: { gatewayId: "bender", ownerUid: "uid-current" },
    });
  });

  it("classifies the shared gateway KSA without tenant binding", async () => {
    await expect(
      mapSaToTenant(fakeDb({}), { namespace: "octogee", saName: "octogee-gateway" }, "octogee"),
    ).resolves.toEqual({ attached: false, result: "shared_gateway" });
  });

  it("soft-fails malformed and unknown service accounts", async () => {
    await expect(
      mapSaToTenant(fakeDb({}), { namespace: "octogee", saName: "octogee-gw-" }, "octogee"),
    ).resolves.toEqual({ attached: false, result: "malformed_sa" });
    await expect(
      mapSaToTenant(fakeDb({}), { namespace: "octogee", saName: "octogee-random" }, "octogee"),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("allows platform service accounts without any tenant lookup", async () => {
    await expect(
      mapSaToTenant(fakeDb({}), { namespace: "octogee", saName: "octogee-glm-controller" }, "octogee"),
    ).resolves.toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "glm-controller" },
    });
    await expect(
      mapSaToTenant(fakeDb({}), { namespace: "octogee", saName: "octogee-api" }, "octogee"),
    ).resolves.toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "octogee-api" },
    });
    await expect(
      mapSaToTenant(fakeDb({}), { namespace: "octogee", saName: "octogee-artifact-worker" }, "octogee"),
    ).resolves.toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "artifact-worker" },
    });
    await expect(
      mapSaToTenant(fakeDb({}), { namespace: "octogee", saName: "llm-broker" }, "octogee"),
    ).resolves.toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "llm-broker" },
    });
  });
});
