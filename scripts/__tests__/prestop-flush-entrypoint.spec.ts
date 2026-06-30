import { describe, expect, it } from "vitest";
import { resolvePreStopFlushConfig } from "../entrypoints/prestop-flush.js";

describe("prestop-flush entrypoint config", () => {
  it("normalizes the local gateway id to default", () => {
    expect(resolvePreStopFlushConfig(
      { GATEWAY_BUILDER_SLUG: " alice " },
      { gatewayClass: "standard", gatewayId: "local" },
    )).toEqual({
      gatewayId: "default",
      gatewayClass: "standard",
      builderSlug: "alice",
    });
  });

  it("keeps dedicated gateway ids and leaves system config sync disabled without a slug", () => {
    expect(resolvePreStopFlushConfig(
      {},
      { gatewayClass: "dedicated", gatewayId: "gw-alice" },
    )).toEqual({
      gatewayId: "gw-alice",
      gatewayClass: "dedicated",
      builderSlug: "",
    });
  });
});
