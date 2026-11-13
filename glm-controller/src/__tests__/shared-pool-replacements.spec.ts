import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import {
  pairedReplacementTarget,
  parseSharedPoolReplacements,
  readSharedPoolReplacements,
} from "../shared-pool-replacements.js";

const pairA = { sourceGatewayId: "shared-olda", targetGatewayId: "shared-newa", updatedAt: 0 };
const pairB = { sourceGatewayId: "shared-oldb", targetGatewayId: "shared-newb", updatedAt: 0 };

describe("parseSharedPoolReplacements", () => {
  it("treats an absent list as no replacements", () => {
    expect(parseSharedPoolReplacements(undefined)).toEqual([]);
    expect(parseSharedPoolReplacements(null)).toEqual([]);
  });

  it("keeps only the pair fields of each recorded replacement", () => {
    expect(parseSharedPoolReplacements([{ ...pairA, note: "stray" }, pairB])).toEqual([pairA, pairB]);
  });

  it.each([
    ["not a list", { ...pairA }],
    ["a non-slot id", [{ sourceGatewayId: "builder-x", targetGatewayId: "shared-newa", updatedAt: 0 }]],
    ["a self pair", [{ sourceGatewayId: "shared-olda", targetGatewayId: "shared-olda", updatedAt: 0 }]],
    ["a missing target", [{ sourceGatewayId: "shared-olda", updatedAt: 0 }]],
    ["a missing progress time", [{ sourceGatewayId: "shared-olda", targetGatewayId: "shared-newa" }]],
    ["a negative progress time", [{ sourceGatewayId: "shared-olda", targetGatewayId: "shared-newa", updatedAt: -1 }]],
  ])("rejects %s", (_label, value) => {
    expect(() => parseSharedPoolReplacements(value)).toThrow("shared pool replacement state is malformed");
  });

  it.each([
    ["two pairs sharing a source", [pairA, { ...pairA, targetGatewayId: "shared-newb" }]],
    ["two pairs sharing a target", [pairA, { ...pairB, targetGatewayId: "shared-newa" }]],
    ["a target that is also a source", [pairA, { sourceGatewayId: "shared-newa", targetGatewayId: "shared-newb", updatedAt: 0 }]],
  ])("rejects %s", (_label, value) => {
    expect(() => parseSharedPoolReplacements(value)).toThrow("shared pool replacement state pairs a gateway twice");
  });
});

describe("readSharedPoolReplacements", () => {
  it("reads no replacements before the scaler has recorded its state", async () => {
    await expect(readSharedPoolReplacements(createDocumentFixtureStore({}))).resolves.toEqual([]);
  });

  it("reads the replacement pairs the scaler recorded", async () => {
    const store = createDocumentFixtureStore({
      "glmControllerState/sharedPoolScaler": { schemaVersion: 1, actionSequence: 2, lastActionAt: 1, replacements: [pairB] },
    });
    await expect(readSharedPoolReplacements(store)).resolves.toEqual([pairB]);
  });
});

describe("pairedReplacementTarget", () => {
  it("returns the recorded target for a source and nothing for anyone else", () => {
    expect(pairedReplacementTarget([pairA, pairB], "shared-oldb")).toBe("shared-newb");
    expect(pairedReplacementTarget([pairA, pairB], "shared-newb")).toBeNull();
    expect(pairedReplacementTarget([], "shared-olda")).toBeNull();
  });
});
