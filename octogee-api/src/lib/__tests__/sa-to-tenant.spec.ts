import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { mapSaToTenant } from "../sa-to-tenant.js";

interface FakeStore {
  // Legacy desired docs: glmGateways/{id} carried ownerUid directly.
  glmGateways?: Record<string, Record<string, unknown>>;
  // New model: gateways/{id} durable desired docs (no ownerUid on the doc).
  gateways?: Record<string, Record<string, unknown>>;
  // gateways/{id}/releases/{n} — ownerUid lives on the release payload.
  releases?: Record<string, Record<string, Record<string, unknown>>>;
}

function docSnap(present: boolean, data: Record<string, unknown> | undefined) {
  return { exists: present, data: () => data };
}

function fakeDb(store: FakeStore): Pick<Firestore, "collection"> {
  const glm = store.glmGateways ?? {};
  const gateways = store.gateways ?? {};
  const releases = store.releases ?? {};
  const makeReleaseDoc = (gatewayId: string) => ({
    collection: (sub: string) => {
      expect(sub).toBe("releases");
      return {
        doc: (n: string) => ({
          get: async () => {
            const data = releases[gatewayId]?.[n];
            return docSnap(data !== undefined, data);
          },
        }),
      };
    },
  });
  return {
    collection: (name: string) => {
      if (name === "gateways") {
        return {
          doc: (id: string) => ({
            get: async () =>
              docSnap(Object.prototype.hasOwnProperty.call(gateways, id), gateways[id]),
            ...makeReleaseDoc(id),
          }),
        };
      }
      expect(name).toBe("glmGateways");
      return {
        doc: (id: string) => ({
          get: async () =>
            docSnap(Object.prototype.hasOwnProperty.call(glm, id), glm[id]),
        }),
      };
    },
  } as unknown as Pick<Firestore, "collection">;
}

// Legacy-model shorthand: the previous fakeDb took a bare glmGateways map.
function legacyDb(docs: Record<string, Record<string, unknown>>): Pick<Firestore, "collection"> {
  return fakeDb({ glmGateways: docs });
}

describe("mapSaToTenant", () => {
  it("maps per-operator gateway KSAs to their gateway document", async () => {
    const result = await mapSaToTenant(
      legacyDb({
        bender: {
          ownerUid: "uid-bender",
        },
      }),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok",
      tenant: {
        kind: "gateway",
        gatewayId: "bender",
        ownerUid: "uid-bender",
      },
    });
  });

  it("takes the SA suffix as the bare gatewayId verbatim", async () => {
    const result = await mapSaToTenant(
      legacyDb({
        "canary-2": {
          ownerUid: "uid-canary",
        },
      }),
      { namespace: "octogee", saName: "octogee-gw-canary-2" },
      "octogee",
    );

    expect(result).toMatchObject({
      attached: true,
      tenant: { gatewayId: "canary-2" },
    });
  });

  it("maps grandfathered operator gateway KSAs to their gateway document", async () => {
    const result = await mapSaToTenant(
      legacyDb({
        bender: {
          ownerUid: "uid-bender",
        },
      }),
      { namespace: "octogee", saName: "octogee-gateway-bender" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok_legacy_operator",
      tenant: {
        kind: "gateway",
        gatewayId: "bender",
        ownerUid: "uid-bender",
      },
    });
  });

  it("soft-fails namespace mismatches before tenant lookup", async () => {
    const result = await mapSaToTenant(
      legacyDb({}),
      { namespace: "octogee-test", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "ns_mismatch" });
  });

  it("soft-fails missing gateway docs as unknown tenants", async () => {
    const missing = await mapSaToTenant(
      legacyDb({}),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(missing).toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("rejects a retired legacy gateway as an unknown tenant", async () => {
    const result = await mapSaToTenant(
      legacyDb({ bender: { desiredStatus: "retired", ownerUid: "uid-bender" } }),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("binds ownerless gateway docs for gateway-scoped brokers", async () => {
    const result = await mapSaToTenant(
      legacyDb({ default: { profile: "standard" } }),
      { namespace: "octogee", saName: "octogee-gw-default" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok",
      tenant: {
        kind: "gateway",
        gatewayId: "default",
      },
    });
  });

  it("classifies the legacy shared gateway KSA without tenant-binding it", async () => {
    const result = await mapSaToTenant(
      legacyDb({}),
      { namespace: "octogee", saName: "octogee-gateway" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "shared_gateway" });
  });

  it("soft-fails malformed and unknown service accounts", async () => {
    const malformed = await mapSaToTenant(
      legacyDb({}),
      { namespace: "octogee", saName: "octogee-gw-" },
      "octogee",
    );
    const unknown = await mapSaToTenant(
      legacyDb({}),
      { namespace: "octogee", saName: "octogee-random" },
      "octogee",
    );

    expect(malformed).toEqual({ attached: false, result: "malformed_sa" });
    expect(unknown).toEqual({ attached: false, result: "unknown_sa" });
  });

  it("allows known platform service accounts without tenant lookup", async () => {
    const controller = await mapSaToTenant(
      legacyDb({}),
      { namespace: "octogee", saName: "octogee-glm-controller" },
      "octogee",
    );
    const api = await mapSaToTenant(
      legacyDb({}),
      { namespace: "octogee", saName: "octogee-api" },
      "octogee",
    );

    expect(controller).toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "glm-controller" },
    });
    expect(api).toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "octogee-api" },
    });
  });

  it("maps the platform cron KSA to a platform tenant for targetless jobs", async () => {
    const cron = await mapSaToTenant(
      legacyDb({}),
      { namespace: "octogee", saName: "octogee-cron" },
      "octogee",
    );

    expect(cron).toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "cron" },
    });
  });

  // Tenant identity split: the KSA maps to the NEW gateways/{id} desired doc when
  // it exists, resolving ownerUid from the live release payload. The bare id is
  // unchanged, so broker authorization (fleet-broker) keeps comparing bare ids.
  it("binds the new gateways/{id} desired doc, resolving ownerUid from the live release", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        gateways: {
          bender: {
            gatewayId: "bender",
            desiredRelease: 5,
            latestRelease: 5,
            liveRelease: 4,
            desiredStatus: "running",
          },
        },
        releases: {
          bender: {
            "4": { payload: { ownerUid: "uid-bender" } },
            "5": { payload: { ownerUid: "uid-should-not-be-read" } },
          },
        },
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

  it("falls back to desiredRelease for ownerUid when the gateway has no live release yet", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        gateways: {
          bender: {
            gatewayId: "bender",
            desiredRelease: 1,
            latestRelease: 1,
            liveRelease: null,
            desiredStatus: "running",
          },
        },
        releases: { bender: { "1": { payload: { ownerUid: "uid-bender" } } } },
      }),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toMatchObject({
      attached: true,
      tenant: { gatewayId: "bender", ownerUid: "uid-bender" },
    });
  });

  it("binds an ownerless new desired doc (shared gateway) with no ownerUid", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        gateways: {
          default: {
            gatewayId: "default",
            desiredRelease: 1,
            latestRelease: 1,
            liveRelease: 1,
            desiredStatus: "running",
          },
        },
        releases: { default: { "1": { payload: { ownerUid: null } } } },
      }),
      { namespace: "octogee", saName: "octogee-gw-default" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "default" },
    });
  });

  it("rejects a retained retired GatewayDoc as an unknown tenant", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        gateways: {
          bender: {
            gatewayId: "bender",
            desiredRelease: 5,
            latestRelease: 5,
            liveRelease: 4,
            desiredStatus: "retired",
          },
        },
      }),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("prefers the new desired doc over a stale legacy glmGateways doc for the same id", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        glmGateways: { bender: { ownerUid: "uid-legacy-stale" } },
        gateways: {
          bender: {
            gatewayId: "bender",
            desiredRelease: 2,
            latestRelease: 2,
            liveRelease: 2,
            desiredStatus: "running",
          },
        },
        releases: { bender: { "2": { payload: { ownerUid: "uid-new" } } } },
      }),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toMatchObject({
      attached: true,
      tenant: { gatewayId: "bender", ownerUid: "uid-new" },
    });
  });
});
