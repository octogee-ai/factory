import { describe, it, expect } from "vitest";
import { resolveGatewayGcpProject } from "../gcp-project.js";

// BYO-GCP seam: a gateway's GCP project comes from its glmGateways doc
// (`gcpProject`) when the Builder brings their own, else the platform
// project. Cowboy threads the result into gateway-edge as a per-gateway
// `--set` so the value is always present from the live desired-state —
// not a baked values file that can skew and silently drop it.
describe("resolveGatewayGcpProject", () => {
  it("uses the per-gateway gcpProject when set (BYO-GCP)", () => {
    expect(
      resolveGatewayGcpProject({ gcpProject: "builder-acme-prod", platformDefault: "octogee" }),
    ).toBe("builder-acme-prod");
  });

  it("falls back to the platform default when gcpProject is absent (cattle / today)", () => {
    expect(resolveGatewayGcpProject({ platformDefault: "octogee" })).toBe("octogee");
  });

  it("treats empty-string gcpProject as absent", () => {
    expect(
      resolveGatewayGcpProject({ gcpProject: "", platformDefault: "octogee" }),
    ).toBe("octogee");
  });

  it("throws if neither a gcpProject nor a platform default is available — never silently empty", () => {
    expect(() => resolveGatewayGcpProject({ platformDefault: "" })).toThrow(/platform/i);
  });
});
