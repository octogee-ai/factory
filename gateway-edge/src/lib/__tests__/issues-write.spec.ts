import { describe, it, expect } from "vitest";
import {
  STATUS_PREFIX,
  STATUS_LABEL_SEED,
  isValidColumn,
  labelForColumn,
  statusLabelsOn,
  targetState,
  computeMove,
} from "../issues-write.js";

describe("isValidColumn", () => {
  it("accepts the five board columns and rejects others", () => {
    for (const k of ["backlog", "todo", "doing", "review", "done"]) expect(isValidColumn(k)).toBe(true);
    expect(isValidColumn("nope")).toBe(false);
    expect(isValidColumn("status:todo")).toBe(false);
  });
});

describe("labelForColumn", () => {
  it("maps labeled columns to a status:* label and backlog/done to null", () => {
    expect(labelForColumn("todo")).toBe(`${STATUS_PREFIX}todo`);
    expect(labelForColumn("doing")).toBe(`${STATUS_PREFIX}doing`);
    expect(labelForColumn("review")).toBe(`${STATUS_PREFIX}review`);
    expect(labelForColumn("backlog")).toBeNull();
    expect(labelForColumn("done")).toBeNull();
  });
});

describe("statusLabelsOn", () => {
  it("returns only the status:* labels", () => {
    expect(statusLabelsOn(["ux", "status:doing", "bug"])).toEqual(["status:doing"]);
    expect(statusLabelsOn(["ux"])).toEqual([]);
  });
});

describe("targetState", () => {
  it("closes for done and opens for everything else", () => {
    expect(targetState("done")).toBe("closed");
    expect(targetState("backlog")).toBe("open");
    expect(targetState("review")).toBe("open");
  });
});

describe("STATUS_LABEL_SEED", () => {
  it("seeds exactly the labeled columns with hex colors (no leading #)", () => {
    expect(STATUS_LABEL_SEED.map((l) => l.name)).toEqual(["status:todo", "status:doing", "status:review"]);
    for (const l of STATUS_LABEL_SEED) expect(l.color).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe("computeMove", () => {
  it("swaps the status label and reopens when moving to a labeled column", () => {
    expect(computeMove(["status:doing", "ux"], "review")).toEqual({
      remove: ["status:doing"],
      add: "status:review",
      state: "open",
    });
  });
  it("removes status labels and closes when moving to done", () => {
    expect(computeMove(["status:review"], "done")).toEqual({
      remove: ["status:review"],
      add: null,
      state: "closed",
    });
  });
  it("removes status labels and adds nothing when moving to backlog", () => {
    expect(computeMove(["status:todo"], "backlog")).toEqual({ remove: ["status:todo"], add: null, state: "open" });
  });
  it("handles an issue with no current status labels", () => {
    expect(computeMove(["bug"], "doing")).toEqual({ remove: [], add: "status:doing", state: "open" });
  });
});
