import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildImage, buildSummary, builderBaseRecipe, ensureImage, gatewayBaseRecipe, imagePlan } from "../ci/image-build.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

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

describe("image reuse", () => {
  const builderBase = `${base}-builder-123456789abc`;
  const harness = ({ existing = [] as string[], check = "fingerprint=f1\nexists=false\n" } = {}) => {
    const calls: string[][] = [];
    let clock = 0;
    const record = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return args[0] === "check" ? check : "";
    };
    const exists = async (ref: string) => existing.includes(ref);
    return {
      calls,
      deps: {
        exists,
        script: (file: string, args: string[]) => record(file, args),
        build: (plan: ReturnType<typeof imagePlan>) => buildImage(plan, { run: record, exists }),
        now: () => (clock += 90_000),
      },
    };
  };
  const sizeChecks = (calls: string[][]) => calls.filter(call => call.includes("scripts/lib/assert-artifact-image-size.sh"));

  it("asserts the Builder size budget exactly once when it builds", async () => {
    const { calls, deps } = harness();
    const row = await ensureImage("octogee-gateway-builder", { repository, sha, base: builderBase }, deps);
    expect(sizeChecks(calls)).toHaveLength(1);
    expect(calls).toContainEqual(["scripts/lib/image-fingerprint-reuse.sh", "record", "octogee-gateway-builder", repository, sha.slice(0, 7), "f1"]);
    expect(calls.at(-1)).toEqual(["scripts/lib/publish-full-sha-image-tag.sh", "octogee-gateway-builder", repository, sha, "octogee"]);
    expect(row).toEqual({ image: "octogee-gateway-builder", tag: sha.slice(0, 7), result: "built", seconds: 90 });
  });

  it.each([
    ["full-SHA tag", { existing: [`${repository}/octogee-gateway-builder:${sha}`] }],
    ["short tag", { existing: [`${repository}/octogee-gateway-builder:${sha.slice(0, 7)}`] }],
    ["fingerprint", { check: "fingerprint=f1\nexists=true\n" }],
  ])("reuses the Builder by %s without rebuilding or re-checking its size", async (via, state) => {
    const { calls, deps } = harness(state);
    const row = await ensureImage("octogee-gateway-builder", { repository, sha, base: builderBase }, deps);
    expect(calls.some(call => call[0] === "docker")).toBe(false);
    expect(sizeChecks(calls)).toHaveLength(0);
    expect(row.result).toBe(`reused (${via})`);
  });

  it("rebuilds when forced even though a reusable image exists", async () => {
    const { calls, deps } = harness({ existing: [`${repository}/gateway-edge:${sha.slice(0, 7)}`], check: "fingerprint=f1\nexists=true\n" });
    const row = await ensureImage("gateway-edge", { repository, sha, force: true }, deps);
    expect(row.result).toBe("built");
    expect(calls.some(call => call[1] === "check" || call[1] === "record")).toBe(false);
  });

  it("summarizes each image as reused or built with its tag and wall time", () => {
    const summary = buildSummary([
      { image: "octogee-gateway-base", tag: base, result: "found", seconds: 2 },
      { image: "octogee-gateway-builder", tag: "aaaaaaa", result: "built", seconds: 754 },
      { image: "gateway-edge", tag: "aaaaaaa", result: "reused (fingerprint)", seconds: 3 },
    ]);
    expect(summary).toContain("| Image | Tag | Result | Wall time |");
    expect(summary).toContain(`| octogee-gateway-base | \`${base}\` | found | 0m 2s |`);
    expect(summary).toContain("| octogee-gateway-builder | `aaaaaaa` | built | 12m 34s |");
    expect(summary).toContain("| gateway-edge | `aaaaaaa` | reused (fingerprint) | 0m 3s |");
  });
});

describe("base image recipes", () => {
  it("keys the OpenClaw base on the build context and every file Dockerfile.base copies, not CI plumbing", () => {
    expect(gatewayBaseRecipe(repoRoot).sort()).toEqual([
      ".dockerignore",
      "infra/gateway/Dockerfile.base",
      "infra/gateway/cua-desktop-discovery.patch",
      "infra/gateway/install-cua-driver-patch.mjs",
      "infra/gateway/verify-codex-native-hook-runtime.mjs",
      "infra/gateway/verify-codex-source-match.mjs",
      "infra/gateway/verify-parallel-source-match.mjs",
    ]);
  });

  it("keys the Builder base on every file Dockerfile.builder-base copies, not CI plumbing", () => {
    expect(builderBaseRecipe(repoRoot).sort()).toEqual([
      "infra/gateway/Dockerfile.builder-base",
      "infra/gateway/builder-toolchain/base-inputs.mjs",
      "infra/gateway/builder-toolchain/groups.json",
      "infra/gateway/builder-toolchain/package-lock.json",
      "infra/gateway/builder-toolchain/package.json",
      "infra/gateway/builder-toolchain/preinstall.mjs",
      "infra/gateway/stamp-claude-first-run.mjs",
    ]);
  });
});
