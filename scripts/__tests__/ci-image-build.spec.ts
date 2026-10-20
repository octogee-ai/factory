import { describe, expect, it, vi } from "vitest";
import { buildImage, imagePlan } from "../ci/image-build.mjs";

const repository = "us-central1-docker.pkg.dev/octogee/octogee";
const sha = "a".repeat(40);
const base = `inputs-${"b".repeat(64)}`;

describe("runner image builds", () => {
  it("builds the isolated runner from its own Docker target", () => {
    const plan = imagePlan("octogee-project-runner", { repository, sha });
    expect(plan.dockerfile).toBe("octogee-api/Dockerfile");
    expect(plan.target).toBe("project-runner");
    expect(plan.tag).toBe(`${repository}/octogee-project-runner:${sha.slice(0, 7)}`);
  });

  it("binds the Builder image to its base, profile, source revision and size budget", () => {
    const plan = imagePlan("octogee-gateway-builder", { repository, sha, base: `${base}-builder-123456789abc` });
    expect(plan.buildArgs).toMatchObject({
      OPENCLAW_BASE_IMAGE: `${repository}/octogee-gateway-builder-base:${base}-builder-123456789abc`,
      IMAGE_PROFILE: "builder",
      BUILD_SHA: sha.slice(0, 7),
    });
    expect(plan.labels).toEqual({ "org.opencontainers.image.revision": sha });
    expect(plan.maxCompressedBytes).toBe(3100000000);
  });

  it.each(["", "latest", "inputs-invalid"])("rejects a mutable or invalid gateway base: %s", invalid => {
    expect(() => imagePlan("octogee-gateway", { repository, sha, base: invalid })).toThrow("base");
  });

  it("pushes with registry caching and verifies size before returning", async () => {
    const run = vi.fn(async () => {});
    const exists = vi.fn(async () => true);
    const plan = imagePlan("octogee-gateway-builder", { repository, sha, base: `${base}-builder-123456789abc` });
    await buildImage(plan, { run, exists });
    expect(run.mock.calls[0][0]).toBe("docker");
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining([
      "buildx", "build", "--platform=linux/amd64", "--push",
      `--cache-from=type=registry,ref=${repository}/cache/octogee-gateway-builder:buildcache`,
    ]));
    expect(run.mock.calls.at(-1)).toEqual(["bash", [
      "scripts/lib/assert-artifact-image-size.sh", plan.tag, "3100000000", "octogee",
    ]]);
  });

  it("allows a confirmed cache miss but propagates registry failures", async () => {
    const plan = imagePlan("gateway-edge", { repository, sha });
    const run = vi.fn(async () => {});
    await buildImage(plan, { run, exists: async () => false });
    expect(run.mock.calls[0][1].some((arg: string) => arg.startsWith("--cache-from"))).toBe(false);
    run.mockClear();
    await expect(buildImage(plan, { run, exists: async () => { throw new Error("denied"); } })).rejects.toThrow("denied");
    expect(run).not.toHaveBeenCalled();
  });

  it("never checks or publishes a dependent artifact after a build failure", async () => {
    const run = vi.fn(async () => { throw new Error("build failed"); });
    const plan = imagePlan("octogee-gateway-builder", { repository, sha, base: `${base}-builder-123456789abc` });
    await expect(buildImage(plan, { run, exists: async () => false })).rejects.toThrow("build failed");
    expect(run).toHaveBeenCalledOnce();
  });
});
