import { describe, expect, it } from "vitest";
import { parseAssignmentDoc } from "../../../assignment-doc.js";
import { MalformedRecordError } from "../../errors.js";
import { decodeGatewayAssignmentData } from "../gateways.js";

const NOW = 1_762_500_000_000;

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "uid-a",
    slug: "ceckert",
    gatewayId: "walter",
    source: "migrate-user",
    state: "quiescing",
    epoch: 3,
    createdAt: NOW - 1_000,
    updatedAt: NOW,
    updatedByOperationId: "op-migrate",
    ...overrides,
  };
}

function decodeFailure(data: Record<string, unknown>): unknown {
  try {
    decodeGatewayAssignmentData("walter", "uid-a", data);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("decodeGatewayAssignmentData", () => {
  it("returns exactly the fence and identity values the document stores", () => {
    expect(decodeGatewayAssignmentData("walter", "uid-a", stored())).toEqual({
      uid: "uid-a",
      slug: "ceckert",
      gatewayId: "walter",
      source: "migrate-user",
      state: "quiescing",
      epoch: 3,
      createdAt: NOW - 1_000,
      updatedAt: NOW,
      updatedByOperationId: "op-migrate",
    });
  });

  it("reads a document written before createdAt existed as serving since its updatedAt", () => {
    const { createdAt: _createdAt, ...legacy } = stored();

    expect(decodeGatewayAssignmentData("walter", "uid-a", legacy)).toMatchObject({ createdAt: NOW, updatedAt: NOW });
  });

  it("reads a document written without updatedAt with its clock at zero", () => {
    const { updatedAt: _updatedAt, ...unclocked } = stored();

    expect(decodeGatewayAssignmentData("walter", "uid-a", unclocked)).toMatchObject({ createdAt: NOW - 1_000, updatedAt: 0 });
  });

  it.each([
    ["no state", { state: undefined }, "has no state"],
    ["an unknown state", { state: "paused" }, 'stores state "paused"'],
    ["no epoch", { epoch: undefined }, "has no epoch"],
    ["a negative epoch", { epoch: -1 }, "stores epoch -1"],
    ["a fractional epoch", { epoch: 1.5 }, "stores epoch 1.5"],
    ["an epoch held as text", { epoch: "3" }, 'stores epoch "3"'],
    ["no uid", { uid: undefined }, "has no uid"],
    ["another user's uid", { uid: "uid-b" }, 'stores uid "uid-b"'],
    ["a fractional updatedAt", { updatedAt: NOW + 0.5 }, `stores updatedAt ${NOW + 0.5}`],
    ["an updatedAt held as text", { updatedAt: String(NOW) }, `stores updatedAt "${NOW}"`],
  ])("rejects a document with %s instead of supplying a fence value", (_case, overrides, detail) => {
    expect(decodeFailure(stored(overrides))).toEqual(
      new MalformedRecordError({ aggregate: "gateway-assignment", key: "walter/uid-a" }, detail),
    );
  });

  it("leaves the lenient roster parser to the callers outside the store", () => {
    expect(parseAssignmentDoc("uid-a", stored({ state: undefined, epoch: undefined, uid: "uid-b" }))).toMatchObject({
      uid: "uid-a",
      state: "serving",
      epoch: 0,
    });
  });
});
