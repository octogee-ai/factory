import { describe, expect, it, vi } from "vitest";
import { desktopRunId, ensureMainBuild, mainBuild, trackSubmission } from "../ci/main-build.mjs";

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
    desktop: vi.fn(async () => ({ accepted: true })),
    publish: vi.fn(async () => "sha256:" + "e".repeat(64)),
  };
}
describe("Build main authority", () => {
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
  it("does not publish when the image build fails", async () => {
    const deps = dependencies();
    deps.images.mockRejectedValue(new Error("failed"));
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

describe("Ship TEST main build selection", () => {
  const sha = "a".repeat(40);
  const run = { id: 9, url: "https://github.com/octogee-ai/octogee/actions/runs/9" };
  function ship() {
    return {
      manifest: vi.fn(async () => null as unknown),
      active: vi.fn(async () => null as number | null),
      watch: vi.fn(async () => ({ ...run, conclusion: "success" })),
      build: vi.fn(async () => undefined),
    };
  }
  it("reuses a completed image family when no build is running", async () => {
    const deps = ship();
    deps.manifest.mockResolvedValue({ sourceSha: sha });
    await ensureMainBuild(sha, deps);
    expect(deps.active).toHaveBeenCalledWith(sha);
    expect(deps.build).not.toHaveBeenCalled();
  });
  it("waits for Desktop even when the container manifest is already published", async () => {
    const deps = ship();
    deps.active.mockResolvedValue(9);
    deps.manifest.mockResolvedValue({ sourceSha: sha });
    await ensureMainBuild(sha, deps);
    expect(deps.watch).toHaveBeenCalledWith(9);
    expect(deps.build).not.toHaveBeenCalled();
  });
  it("refuses a failed Desktop job after container publication", async () => {
    const deps = ship();
    deps.active.mockResolvedValue(9);
    deps.manifest.mockResolvedValue({ sourceSha: sha });
    deps.watch.mockResolvedValue({ ...run, conclusion: "failure" });
    await expect(ensureMainBuild(sha, deps)).rejects.toThrow("concluded failure");
  });
  it("starts a build only when no manifest or in-flight run exists", async () => {
    const deps = ship();
    deps.manifest.mockResolvedValueOnce(null).mockResolvedValueOnce({ sourceSha: sha });
    await ensureMainBuild(sha, deps);
    expect(deps.build).toHaveBeenCalledOnce();
  });
  it("starts a build when the in-flight run was superseded before it built", async () => {
    const deps = ship();
    deps.active.mockResolvedValue(9);
    deps.watch.mockResolvedValue({ ...run, conclusion: "cancelled" });
    deps.manifest.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ sourceSha: sha });
    await ensureMainBuild(sha, deps);
    expect(deps.build).toHaveBeenCalledOnce();
  });
  it("stops with the run URL when the in-flight build fails", async () => {
    const deps = ship();
    deps.active.mockResolvedValue(9);
    deps.watch.mockResolvedValue({ ...run, conclusion: "failure" });
    await expect(ensureMainBuild(sha, deps)).rejects.toThrow(`Build main run ${run.url} for ${sha} concluded failure`);
    expect(deps.build).not.toHaveBeenCalled();
  });
  it("says it is attaching to the Build main run already in flight", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = ship();
    deps.active.mockResolvedValue(9);
    deps.manifest.mockResolvedValue({ sourceSha: sha });
    await ensureMainBuild(sha, deps);
    expect(log).toHaveBeenCalledWith(`Attaching to Build main run 9 already running for ${sha}`);
    log.mockRestore();
  });
  it("says it is dispatching Build main when nothing is published", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = ship();
    deps.manifest.mockResolvedValueOnce(null).mockResolvedValueOnce({ sourceSha: sha });
    await ensureMainBuild(sha, deps);
    expect(log).toHaveBeenCalledWith(`No complete image family for ${sha}; dispatching Build main`);
    log.mockRestore();
  });
  it("fails when a finished build published no manifest", async () => {
    const deps = ship();
    await expect(ensureMainBuild(sha, deps)).rejects.toThrow(`Build main for ${sha} published no complete image family`);
  });
});
