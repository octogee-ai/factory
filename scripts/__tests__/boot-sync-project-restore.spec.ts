/**
 * Unit tests for the project-restoration selector in boot-sync.
 *
 * Cattle-gateway principle (docs/GATEWAY-PLATFORM-SPEC.md + PROJECTS-CANVAS-SPEC §D11):
 * a fresh PVC should self-heal every project directory without manual
 * intervention. `projectsNeedingClone` is the pure decision function —
 * given Firestore rows + a filesystem check, which ones do we clone?
 *
 * The selection rules the test locks:
 *   - Missing `giteaRepoName` → never clone (nothing to clone).
 *   - Already on disk (`.git` present) → skip.
 *   - `provisioningState` absent → treat as active and clone if missing.
 *   - `provisioningState: 'active'` + missing on disk + has repo → clone.
 *   - `provisioningState: 'provisioning' | 'failed'` → never clone here;
 *     those are the retry endpoint's responsibility (spec §D4).
 */
import { describe, it, expect } from "vitest";
import { projectsNeedingClone, type ProjectRestoreInput } from "../boot-sync.js";

const never = (_: string, __: string) => false;
const always = (_: string, __: string) => true;

function input(
  overrides: Partial<ProjectRestoreInput> = {},
): ProjectRestoreInput {
  return {
    customerSlug: "alice",
    projectSlug: "mygame",
    giteaRepoName: "alice-proj-mygame",
    provisioningState: "active",
    ...overrides,
  };
}

describe("projectsNeedingClone", () => {
  it("selects an active project with a repo name that is not yet on disk", () => {
    const out = projectsNeedingClone([input()], never);
    expect(out).toHaveLength(1);
    expect(out[0].projectSlug).toBe("mygame");
  });

  it("skips projects already present on disk", () => {
    const out = projectsNeedingClone([input()], always);
    expect(out).toEqual([]);
  });

  it("skips projects with no giteaRepoName (nothing to clone)", () => {
    const out = projectsNeedingClone([input({ giteaRepoName: null })], never);
    expect(out).toEqual([]);
  });

  it("skips projects in provisioning state — retry endpoint owns those", () => {
    const out = projectsNeedingClone(
      [input({ provisioningState: "provisioning" })],
      never,
    );
    expect(out).toEqual([]);
  });

  it("skips projects in failed state — retry endpoint owns those too", () => {
    const out = projectsNeedingClone(
      [input({ provisioningState: "failed" })],
      never,
    );
    expect(out).toEqual([]);
  });

  it("treats missing provisioningState as active (legacy pre-§D4 docs)", () => {
    const out = projectsNeedingClone(
      [input({ provisioningState: undefined })],
      never,
    );
    expect(out).toHaveLength(1);
  });

  it("picks per-project based on the fs check — mixed result across one customer", () => {
    const onDisk = new Set(["alice/mygame"]);
    const isCloned = (slug: string, proj: string) => onDisk.has(`${slug}/${proj}`);
    const out = projectsNeedingClone(
      [
        input({ projectSlug: "mygame" }),
        input({ projectSlug: "myapp" }),
        input({ projectSlug: "failedone", provisioningState: "failed" }),
        input({ projectSlug: "nopath", giteaRepoName: null }),
      ],
      isCloned,
    );
    expect(out.map((p) => p.projectSlug)).toEqual(["myapp"]);
  });
});
