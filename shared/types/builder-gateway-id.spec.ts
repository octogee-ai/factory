import { describe, expect, it } from "vitest";

import {
  builderGatewayIdForSlug,
  disposableBuilderGatewayId,
} from "./builder-gateway-id";
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
    expect(() => builderGatewayIdForSlug("chris--builder")).toThrow("invalid Builder slug");
  });
});

describe("disposableBuilderGatewayId", () => {
  it("binds the identity to one activation generation", () => {
    const first = disposableBuilderGatewayId("jack", 1, "lease-one");
    const retry = disposableBuilderGatewayId("jack", 1, "lease-one");
    const next = disposableBuilderGatewayId("jack", 2, "lease-two");

    expect(first).toBe(retry);
    expect(next).not.toBe(first);
    expect(isValidNewGatewayId(first)).toBe(true);
    expect(isValidNewGatewayId(next)).toBe(true);
  });

  it("keeps long and reserved-looking slugs inside the new-gateway contract", () => {
    for (const slug of [
      "this-is-a-very-long-builder-slug",
      "builder-with-green",
      "builder-with-blue",
    ]) {
      const gatewayId = disposableBuilderGatewayId(slug, 999_999, "lease-collision-seed");
      expect(gatewayId.length).toBeLessThanOrEqual(32);
      expect(isValidNewGatewayId(gatewayId)).toBe(true);
    }
  });
});
