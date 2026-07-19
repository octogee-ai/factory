import { describe, expect, it } from "vitest";

import { builderGatewayIdForSlug } from "./builder-gateway-id";
import { isValidNewGatewayId } from "./glm";

describe("builderGatewayIdForSlug", () => {
  it("uses builder-<slug> when the canonical slug fits the gateway id contract", () => {
    expect(builderGatewayIdForSlug("jack")).toBe("builder-jack");
  });

  it("shortens long slugs and appends a stable hash without leaving the gateway id contract", () => {
    const first = builderGatewayIdForSlug("this-is-a-very-long-builder-slug");
    const second = builderGatewayIdForSlug("this-is-a-very-long-builder-slug");
    expect(first).toBe(second);
    expect(first).toMatch(/^builder-this-is-a-ver-[0-9a-f]{8}$/u);
    expect(isValidNewGatewayId(first)).toBe(true);
  });

  it("rejects a value that is not a canonical Builder slug", () => {
    expect(() => builderGatewayIdForSlug("Chris Builder")).toThrow("invalid Builder slug");
  });
});
