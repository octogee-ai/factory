import { describe, it, expect } from "vitest";
import {
  buildRecycleOperation,
  classifyOperation,
  isTerminal,
} from "../lib/durability-ops.js";

describe("buildRecycleOperation", () => {
  it("builds a pending recycle-gateway op (a REAL pod reroll, not the in-process restart)", () => {
    const op = buildRecycleOperation({
      id: "dur-recycle-abc",
      gatewayId: "default",
      createdBy: "durability-harness",
      now: 1_700_000_000_000,
    });
    expect(op).toMatchObject({
      id: "dur-recycle-abc",
      kind: "recycle-gateway",
      status: "pending",
      createdBy: "durability-harness",
      createdAt: 1_700_000_000_000,
      startedAt: null,
      completedAt: null,
      input: { gatewayId: "default" },
    });
    expect(op.steps).toEqual([]);
  });

  it("carries only gatewayId in input — no credential material", () => {
    const op = buildRecycleOperation({ id: "x", gatewayId: "default", createdBy: "h", now: 0 });
    expect(Object.keys(op.input)).toEqual(["gatewayId"]);
  });
});

describe("classifyOperation / isTerminal", () => {
  it("maps op status to a coarse outcome the harness polls on", () => {
    expect(classifyOperation({ status: "pending" })).toBe("pending");
    expect(classifyOperation({ status: "running" })).toBe("pending");
    expect(classifyOperation({ status: "succeeded" })).toBe("succeeded");
    expect(classifyOperation({ status: "failed" })).toBe("failed");
    expect(classifyOperation({ status: "rolled-back" })).toBe("failed");
  });

  it("isTerminal is true only once the op stops changing", () => {
    expect(isTerminal({ status: "running" })).toBe(false);
    expect(isTerminal({ status: "succeeded" })).toBe(true);
    expect(isTerminal({ status: "failed" })).toBe(true);
  });

  it("treats a missing/unknown status as non-terminal (keep waiting, don't false-pass)", () => {
    expect(classifyOperation({})).toBe("pending");
    expect(isTerminal({})).toBe(false);
    expect(classifyOperation({ status: "weird" as never })).toBe("pending");
  });
});
