import { describe, expect, it } from "vitest";
import { AGENT_LOOK_STYLES, parseAgentLook } from "./agent-look.js";

describe("agent look", () => {
  it("accepts every offered style with a lowercase hex colour", () => {
    for (const style of AGENT_LOOK_STYLES) {
      expect(parseAgentLook({ style, color: "#0ea5e9" })).toEqual({ style, color: "#0ea5e9" });
    }
  });

  it("keeps only the style and colour of a stored look", () => {
    expect(parseAgentLook({ style: "blob", color: "#0ea5e9", extra: "x" })).toEqual({ style: "blob", color: "#0ea5e9" });
  });

  it.each([
    null,
    "blob",
    [],
    { style: "dragon", color: "#0ea5e9" },
    { style: "blob" },
    { style: "blob", color: "#0EA5E9" },
    { style: "blob", color: "red" },
    { style: "blob", color: '#0ea5e9" onload="x' },
  ])("refuses the look %j", (value) => {
    expect(parseAgentLook(value)).toBeNull();
  });
});
