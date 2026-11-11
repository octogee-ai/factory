import { describe, expect, it } from "vitest";
import { isGatewayVm } from "./gateway-vm.js";

describe("Gateway computer capability", () => {
  it.each([
    ["builder", "cluster", "x11", true],
    ["isolated", "cluster", "x11", true],
    ["isolated", "gce-vm", "omarchy", true],
    ["isolated", "cluster", undefined, false],
    ["operator", "gce-vm", "omarchy", false],
    ["builder", "gce-vm", "omarchy", true],
    ["builder", "cluster", undefined, false],
    ["shared", "cluster", "x11", false],
    ["shared", "gce-vm", "omarchy", false],
  ])("selects %s/%s/%s capability", (gatewayClass, runtime, desktop, expected) => {
    expect(isGatewayVm({ GATEWAY_CLASS: gatewayClass, GATEWAY_RUNTIME_KIND: runtime, GATEWAY_COMPUTER_DESKTOP: desktop })).toBe(expected);
  });
});
