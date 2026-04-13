/**
 * Unit tests for deriveDesiredByotState() — the pure decision function
 * that maps a Firestore user doc to "should this customer have
 * auth-profiles.json written right now?"
 *
 * Guards the provisioner against writing BYOT profiles for customers
 * whose provisioning isn't complete (the agent dir wouldn't even exist
 * yet) or whose byotActive flag isn't set.
 */
import { describe, test, expect } from "vitest";
import { deriveDesiredByotState } from "../../scripts/lib/byot-sync";

describe("deriveDesiredByotState", () => {
  test("enabled when byotActive + complete + slug present", () => {
    const out = deriveDesiredByotState({
      byotActive: true,
      workspaceSlug: "smile-wring-011b",
      provisioning: { openclaw: { status: "complete", slug: "smile-wring-011b" } },
    });
    expect(out.enabled).toBe(true);
    expect(out.input).toEqual({ slug: "smile-wring-011b", provider: "anthropic" });
  });

  test("disabled when byotActive is false", () => {
    const out = deriveDesiredByotState({
      byotActive: false,
      workspaceSlug: "smile-wring-011b",
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(out.enabled).toBe(false);
    expect(out.input).toBeNull();
  });

  test("disabled when byotActive is missing (undefined)", () => {
    const out = deriveDesiredByotState({
      workspaceSlug: "smile-wring-011b",
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(out.enabled).toBe(false);
  });

  test("disabled when provisioning status is not complete", () => {
    const out = deriveDesiredByotState({
      byotActive: true,
      workspaceSlug: "smile-wring-011b",
      provisioning: { openclaw: { status: "in_progress" } },
    });
    expect(out.enabled).toBe(false);
  });

  test("disabled when slug is missing from both canonical paths", () => {
    const out = deriveDesiredByotState({
      byotActive: true,
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(out.enabled).toBe(false);
  });

  test("falls back to provisioning.openclaw.slug when workspaceSlug is missing", () => {
    const out = deriveDesiredByotState({
      byotActive: true,
      provisioning: { openclaw: { status: "complete", slug: "from-provisioning" } },
    });
    expect(out.enabled).toBe(true);
    expect(out.input?.slug).toBe("from-provisioning");
  });

  test("empty user data = disabled (defensive default)", () => {
    expect(deriveDesiredByotState({}).enabled).toBe(false);
  });
});
