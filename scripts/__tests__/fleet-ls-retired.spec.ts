import { describe, expect, it } from "vitest";
import { retirementFinished, visibleFleetGateways, type FleetGatewayRuntimeEntry } from "../ops/fleet.js";

function entry(
  gatewayId: string,
  desiredStatus: "running" | "paused" | "retired" | null,
  heartbeat: Record<string, unknown> = {},
): FleetGatewayRuntimeEntry {
  return {
    gatewayId,
    runtime: desiredStatus === null ? null : { gatewayId, desiredStatus, profile: "standard", heartbeat },
  } as FleetGatewayRuntimeEntry;
}

const torn = entry("ceckert", "retired");
const stillBeating = entry("stuck-beating", "retired", { status: "ready", lastHeartbeatAt: 1 });
const stillPodded = entry("stuck-podded", "retired");
const fleet = [entry("shared-1", "running", { status: "ready" }), torn, stillBeating, stillPodded, entry("paused-1", "paused"), entry("broken", null)];
const pods = ["octogee-gateway-shared-1-abc-xyz", "octogee-gateway-stuck-podded-abc-xyz"];

describe("gw ls hides retired gateways only once their teardown finished", () => {
  it("treats retired as finished only without a heartbeat and without pods named for it", () => {
    expect(retirementFinished(torn, pods)).toBe(true);
    expect(retirementFinished(stillBeating, pods)).toBe(false);
    expect(retirementFinished(stillPodded, pods)).toBe(false);
    expect(retirementFinished(entry("live", "running"), pods)).toBe(false);
    expect(retirementFinished(entry("broken", null), pods)).toBe(false);
  });

  it("drops only finished retirements by default and counts them", () => {
    const { shown, hiddenRetired } = visibleFleetGateways(fleet, false, pods);
    expect(shown.map((g) => g.gatewayId)).toEqual(["shared-1", "stuck-beating", "stuck-podded", "paused-1", "broken"]);
    expect(hiddenRetired).toBe(1);
  });

  it("keeps every gateway with --all", () => {
    const { shown, hiddenRetired } = visibleFleetGateways(fleet, true, pods);
    expect(shown).toBe(fleet);
    expect(hiddenRetired).toBe(0);
  });
});
