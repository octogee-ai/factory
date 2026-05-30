import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { mapSaToTenant } from "../sa-to-tenant.js";

function fakeDb(docs: Record<string, Record<string, unknown>>): Pick<Firestore, "collection"> {
  return {
    collection: (name: string) => {
      expect(name).toBe("glmGateways");
      return {
        doc: (id: string) => ({
          get: async () => ({
            exists: Object.prototype.hasOwnProperty.call(docs, id),
            data: () => docs[id],
          }),
        }),
      };
    },
  } as unknown as Pick<Firestore, "collection">;
}

describe("mapSaToTenant", () => {
  it("maps per-operator gateway KSAs to their gateway document", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        "gw-bender": {
          ownerUid: "uid-bender",
          instanceName: "bender",
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
        gatewayId: "gw-bender",
        ownerUid: "uid-bender",
        instanceName: "bender",
      },
    });
  });

  it("also accepts the explicit gw- suffix form", async () => {
    const result = await mapSaToTenant(
      fakeDb({
        "gw-bender": {
          ownerUid: "uid-bender",
          instanceName: "bender",
        },
      }),
      { namespace: "octogee", saName: "octogee-gw-gw-bender" },
      "octogee",
    );

    expect(result).toMatchObject({
      attached: true,
      tenant: { gatewayId: "gw-bender" },
    });
  });

  it("soft-fails namespace mismatches before tenant lookup", async () => {
    const result = await mapSaToTenant(
      fakeDb({}),
      { namespace: "octogee-test", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "ns_mismatch" });
  });

  it("soft-fails missing or incomplete gateway docs as unknown tenants", async () => {
    const missing = await mapSaToTenant(
      fakeDb({}),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );
    const incomplete = await mapSaToTenant(
      fakeDb({ "gw-bender": { ownerUid: "uid-bender" } }),
      { namespace: "octogee", saName: "octogee-gw-bender" },
      "octogee",
    );

    expect(missing).toEqual({ attached: false, result: "unknown_tenant" });
    expect(incomplete).toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("soft-fails malformed and unknown service accounts", async () => {
    const malformed = await mapSaToTenant(
      fakeDb({}),
      { namespace: "octogee", saName: "octogee-gw-" },
      "octogee",
    );
    const unknown = await mapSaToTenant(
      fakeDb({}),
      { namespace: "octogee", saName: "octogee-random" },
      "octogee",
    );

    expect(malformed).toEqual({ attached: false, result: "malformed_sa" });
    expect(unknown).toEqual({ attached: false, result: "unknown_sa" });
  });

  it("allows known platform service accounts without tenant lookup", async () => {
    const controller = await mapSaToTenant(
      fakeDb({}),
      { namespace: "octogee", saName: "octogee-glm-controller" },
      "octogee",
    );
    const api = await mapSaToTenant(
      fakeDb({}),
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
});
