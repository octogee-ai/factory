import { describe, expect, it, vi } from "vitest";
import { desktopRunId, mainBuild, trackSubmission } from "../ci/main-build.mjs";

it("preserves the Actions run and attempt identity required for bounded desktop VMs", () => {
  expect(desktopRunId("123456-2")).toBe("123456-2");
  for (const value of ["123456", "local-123456", "build-uuid", undefined]) expect(() => desktopRunId(value)).toThrow("run ID and attempt");
});

const options = { sourceSha: "a".repeat(40), checkoutSha: "a".repeat(40), branch: "main", clean: true, force: false, desktop: false };
function dependencies() {
  return {
    lookup: vi.fn(async () => null),
    lock: vi.fn(async (run: () => Promise<unknown>) => run()),
    images: vi.fn(async () => undefined),
    frontend: vi.fn(async () => undefined),
    desktop: vi.fn(async () => ({ accepted: true })),
    publish: vi.fn(async () => "sha256:" + "e".repeat(64)),
  };
}
describe("Cloud Build main authority", () => {
  it.each([{ branch: "topic" }, { checkoutSha: "b".repeat(40) }, { clean: false }])("rejects an unauthorized source before touching artifacts: %j", async invalid => {
    const deps = dependencies();
    await expect(mainBuild({ ...options, ...invalid }, deps)).rejects.toThrow();
    expect(deps.lookup).not.toHaveBeenCalled();
  });
  it("reuses an immutable manifest even with force requested", async () => {
    const deps = dependencies();
    deps.lookup.mockResolvedValue("sha256:existing" as never);
    await expect(mainBuild({ ...options, force: true }, deps)).resolves.toBe("sha256:existing");
    expect(deps.images).not.toHaveBeenCalled();
    expect(deps.desktop).not.toHaveBeenCalled();
  });
  it("rechecks after acquiring the per-SHA writer lock", async () => {
    const deps = dependencies();
    deps.lookup.mockResolvedValueOnce(null).mockResolvedValueOnce("sha256:winner" as never);
    await expect(mainBuild(options, deps)).resolves.toBe("sha256:winner");
    expect(deps.publish).not.toHaveBeenCalled();
  });
  it.each(["images", "frontend"] as const)("does not publish when %s fails", async step => {
    const deps = dependencies();
    deps[step].mockRejectedValue(new Error("failed"));
    await expect(mainBuild(options, deps)).rejects.toThrow("failed");
    expect(deps.publish).not.toHaveBeenCalled();
  });
  it("defaults the optional desktop build off", async () => {
    const deps = dependencies();
    await mainBuild(options, deps);
    expect(deps.desktop).not.toHaveBeenCalled();
    expect(deps.publish).toHaveBeenCalledWith();
  });
  it("rejects desktop construction before inspecting a published main manifest", async () => {
    const deps = dependencies();
    deps.lookup.mockResolvedValue("sha256:existing" as never);
    await expect(mainBuild({ ...options, desktop: true }, deps)).rejects.toThrow("explicit desktop Actions job");
    expect(deps.lookup).not.toHaveBeenCalled();
    expect(deps.desktop).not.toHaveBeenCalled();
  });
});

it.each(["lost response", "missing ID"])("retains writer ownership after an ambiguous child submission: %s", failure => {
  const activeBuilds = new Set();
  expect(() => trackSubmission(() => {
    if (failure === "lost response") throw new Error(failure);
    return "";
  }, activeBuilds)).toThrow();
  expect(activeBuilds.size).toBe(1);
});

it("tracks the confirmed child before allowing the submission marker to clear", () => {
  const activeBuilds = new Set();
  expect(trackSubmission(() => "build-id", activeBuilds)).toBe("build-id");
  expect([...activeBuilds]).toEqual(["build-id"]);
});
