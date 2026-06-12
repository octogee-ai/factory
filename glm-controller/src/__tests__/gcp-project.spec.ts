import { describe, it, expect } from "vitest";
import { resolveDefaultStorageBucket, resolveGatewayGcpProject } from "../gcp-project.js";

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

describe("resolveDefaultStorageBucket", () => {
  it("derives the Firebase default bucket from the GCP project", () => {
    expect(resolveDefaultStorageBucket("octogee-test")).toBe(
      "octogee-test.firebasestorage.app",
    );
  });

  it("throws when the project is unset — never a cross-project guess", () => {
    expect(() => resolveDefaultStorageBucket(undefined)).toThrow(/GOOGLE_CLOUD_PROJECT/);
    expect(() => resolveDefaultStorageBucket("  ")).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });
});
