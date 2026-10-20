import { describe, expect, it } from "vitest";
import { projectStorageSlug } from "../entrypoints/prepare-project-storage.js";
import { withBuilderClaim } from "./helpers/builder-claim.js";

describe("prepare-project-storage entrypoint", () => {
  it("prepares project storage for the Builder named by the claim the VM agent wrote before init", () => {
    expect(projectStorageSlug(withBuilderClaim({}, "alice"))).toBe("alice");
  });

  it("refuses to run before a Builder claim exists instead of preparing an unnamed owner", () => {
    const unclaimed = { OPENCLAW_DIR: `${withBuilderClaim({}, "alice").OPENCLAW_DIR}-unclaimed`, GATEWAY_ID: "gw-test" };
    expect(() => projectStorageSlug(unclaimed)).toThrow(/Builder claim/);
  });
});
