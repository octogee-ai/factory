import { describe, expect, it, vi } from "vitest";
import { ALL_JOBS, UNIT_PACKAGES } from "../lib/scope/manifest.js";
import { CHECK_LANES, checkPlan, executeChecks, selectCheckLane, dependencyInstaller, vitestOptions } from "../lib/ci-checks.js";

describe("portable Linux PR checks", () => {
  it("runs every registered test on a global change, leaving installer construction out of default CI", () => {
    const plan = checkPlan(["package-lock.json"], "tests");
    expect(plan.map(job => job.name).sort()).toEqual(ALL_JOBS.filter(name => name !== "desktop-package").sort());
    for (const pkg of UNIT_PACKAGES) {
      expect(plan.find(job => job.name === pkg.name)).toMatchObject({
        directory: pkg.dir, nodeVersion: pkg.nodeVersion ?? 22,
      });
    }
    expect(plan.find(job => job.name === "desktop-package")).toBeUndefined();
    expect(plan.find(job => job.name === "app")?.commands).toContain("npm test");
  });

  it("runs the Firebase 13 client packages on Node 24 and keeps Cloud Functions on its Node 22 runtime", () => {
    const plan = checkPlan(["package-lock.json"], "tests");
    for (const name of ["app", "site", "firestore-rules"]) expect(plan.find(job => job.name === name)?.nodeVersion).toBe(24);
    expect(plan.find(job => job.name === "functions-emulator")?.nodeVersion).toBe(22);
  });

  it("constructs installers only when explicitly requested", () => {
    expect(checkPlan(["desktop/package.json"], "tests").some(job => job.name === "desktop-package")).toBe(false);
    expect(checkPlan(["desktop/package.json"], "tests", true).find(job => job.name === "desktop-package")?.commands.join("\n")).toContain("--publish never");
  });

  it.each([{ paths: [] }, { paths: ["docs/INDEX.md"] }])("runs explicit installer packaging without a desktop diff: $paths", ({ paths }) => {
    expect(checkPlan(paths, "tests", true).map(job => job.name)).toContain("desktop-package");
  });

  it("keeps scoped checks and cross-package installs", () => {
    const plan = checkPlan(["gateway-edge/src/index.ts"], "tests");
    expect(plan.map(job => job.name)).toContain("octogee-api-emulator");
    expect(plan.map(job => job.name)).not.toContain("app");
    expect(plan.find(job => job.name === "octogee-api")?.installs).toContain("gateway-edge");
    expect(plan.find(job => job.name === "glm-controller-emulator")).toBeUndefined();
    expect(checkPlan(["docs/INDEX.md"], "tests")).toEqual([]);
  });

  it("covers every Linux PR quality gate without deployment commands", () => {
    const plan = checkPlan(["artifact-worker/renderer/Cargo.lock"], "quality");
    expect(plan.map(job => job.name)).toEqual(["eslint", "knip", "gitleaks", "osv-scanner", "trivy", "cargo-audit"]);
    expect(JSON.stringify(plan)).not.toMatch(/firebase deploy|helm upgrade|desiredRelease/);
  });

  it("fails the aggregate check when an in-scope job fails, without skipping later checks", async () => {
    const jobs = checkPlan(["docs/INDEX.md"], "quality");
    const run = vi.fn(async (job: { name: string }) => {
      if (job.name === "gitleaks") throw new Error("secret found");
    });
    await expect(executeChecks(jobs, run)).rejects.toThrow("gitleaks");
    expect(run).toHaveBeenCalledTimes(jobs.length);
  });

  it.each(["package-lock.json", "gateway-edge/src/index.ts", "docs/INDEX.md"])("partitions every required check exactly once: %s", path => {
    const jobs = checkPlan([path]);
    const lanes = CHECK_LANES.flatMap(lane => selectCheckLane(jobs, lane));
    expect(lanes.map(job => job.name).sort()).toEqual(jobs.map(job => job.name).sort());
    expect(new Set(lanes.map(job => job.name)).size).toBe(lanes.length);
    expect(selectCheckLane(jobs, "emulators").every(job => job.name.endsWith("-emulator") || job.name === "firestore-rules")).toBe(true);
    expect(selectCheckLane(jobs, "quality").map(job => job.name)).toEqual(checkPlan([path], "quality").map(job => job.name));
  });

  it("rejects an unknown lane instead of returning a green empty plan", () => {
    expect(() => selectCheckLane(checkPlan(["package-lock.json"]), "typo")).toThrow("Unknown CI lane");
  });

  it("installs shared dependencies once per toolchain, and retries a failed install", () => {
    const prepare = dependencyInstaller();
    const jobs = checkPlan(["package-lock.json"], "tests");
    const install = vi.fn();
    const job = jobs.find(value => value.name === "gateway-edge")!;
    prepare(job, install);
    prepare(job, install);
    expect(install.mock.calls.map(call => call[0])).toEqual(["shared", "gateway-edge"]);
    prepare({ ...job, matchGatewayImageNpm: true }, install);
    expect(install).toHaveBeenCalledTimes(4);
    const fail = vi.fn().mockImplementationOnce(() => { throw new Error("registry unavailable"); });
    const different = { ...job, installs: ["new-package"] };
    expect(() => prepare(different, fail)).toThrow("registry unavailable");
    prepare(different, fail);
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it("does not pass Vitest flags to Firebase's emulator CLI", () => {
    const script = 'firebase emulators:exec --only firestore,storage "vitest run"';
    expect(vitestOptions(script, false)).toBe("");
    expect(vitestOptions(script, true)).toBe("");
  });

  it("bounds direct Vitest workers and retains emulation timeouts", () => {
    expect(vitestOptions("vitest run", false)).toBe(" -- --maxWorkers=4");
    expect(vitestOptions("vitest run", true)).toContain("--testTimeout=60000 --hookTimeout=60000 --maxWorkers=2");
    expect(vitestOptions("node --test", false)).toBe("");
  });
});
