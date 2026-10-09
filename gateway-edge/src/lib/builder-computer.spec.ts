import { describe, expect, it } from "vitest";
import { isBuilderComputer } from "./builder-computer.js";

describe("Builder computer capability", () => {
  it.each([
    ["builder", "cluster", "x11", true],
    ["builder", "gce-vm", "omarchy", true],
    ["builder", "cluster", undefined, false],
    ["shared", "cluster", "x11", false],
    ["shared", "gce-vm", "omarchy", false],
  ])("selects %s/%s/%s capability", (gatewayClass, runtime, desktop, expected) => {
    expect(isBuilderComputer({ GATEWAY_CLASS: gatewayClass, GATEWAY_RUNTIME_KIND: runtime, GATEWAY_COMPUTER_DESKTOP: desktop })).toBe(expected);
  });
});
