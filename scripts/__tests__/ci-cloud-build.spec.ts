import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cloudBakePlan, digestsFromMetadata, imageManifest, imagePaths, mergeCommands, productFindings } from "../ci/cloud-build.mjs";
import { IMAGE_BUILDS } from "../ci/image-build.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const registry = "ghcr.io/octogee-ai/octogee-cloud";
const sha = "a".repeat(40);
const images = ["glm-controller", "octogee-api", "gateway-edge", "octogee-gateway", "mattermost"];
const plan = (overrides: Record<string, unknown> = {}) =>
  cloudBakePlan({ registry, sha, platform: "linux/arm64", root, images, ...overrides });
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

describe("public platform image plan", () => {
  it("pushes every platform image by digest for one platform from the platform tree", () => {
    const { group, target } = plan();
    expect(group.default.targets).toEqual(images);
    for (const name of images) {
      expect(target[name]).toMatchObject({
        context: root,
        platforms: ["linux/arm64"],
        output: [`type=image,name=${registry}/${name},push-by-digest=true,name-canonical=true,push=true`],
        attest: ["type=provenance,disabled=true", "type=sbom,disabled=true"],
        labels: { "org.opencontainers.image.revision": sha, "org.opencontainers.image.source": "https://github.com/octogee-ai/octogee-cloud" },
      });
      expect(target[name].tags).toBeUndefined();
    }
    expect(target["glm-controller"].dockerfile).toBe("glm-controller/Dockerfile");
    expect(target["octogee-gateway-base"].output).toEqual(["type=cacheonly"]);
    expect(target["octogee-gateway-system"].output).toEqual(["type=cacheonly"]);
  });

  it("never takes a product overlay or product context, so every image builds from its Dockerfile's platform stages", () => {
    const { target } = plan();
    for (const definition of Object.values(target) as Array<{ contexts?: Record<string, string> }>) {
      expect(Object.entries(definition.contexts ?? {}).filter(([name, value]) => !(name.startsWith("octogee-gateway-") && value.startsWith("target:")))).toEqual([]);
    }
    expect(target["octogee-api"].contexts).toBeUndefined();
    expect(target["octogee-api"].target).toBeUndefined();
    expect(target["glm-controller"].contexts).toBeUndefined();
  });

  it.each([
    ["declares it as an empty stage", (context: string) => `FROM scratch AS ${context}\nFROM node\nCOPY --from=${context} / /packed/\n`, undefined],
    ["has no stage for it", (context: string) => `FROM node\nCOPY --from=${context} / /packed/\n`, "octogee-api needs build contexts outside the platform tree"],
  ])("builds an image without its product context only when its Dockerfile %s", (_case, dockerfile, refusal) => {
    const fixture = mkdtempSync(join(tmpdir(), "cloud-build-contexts-"));
    try {
      const contexts = Object.keys(IMAGE_BUILDS["octogee-api"].contexts ?? {});
      expect(contexts.length).toBeGreaterThan(0);
      mkdirSync(join(fixture, "octogee-api"));
      writeFileSync(join(fixture, "octogee-api/Dockerfile"), contexts.map(dockerfile).join(""));
      const build = () => plan({ root: fixture, images: ["octogee-api"] });
      if (refusal) expect(build).toThrow(`${refusal}: ${contexts.join(", ")}`);
      else expect(build().target["octogee-api"].contexts).toBeUndefined();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("keeps its build cache in its own GitHub Actions scope and never in a registry", () => {
    const { target } = plan({ cache: "gha" });
    expect(target["glm-controller"]["cache-from"]).toEqual(["type=gha,scope=octogee-cloud-glm-controller-linux-arm64"]);
    expect(target["glm-controller"]["cache-to"]).toEqual(["type=gha,scope=octogee-cloud-glm-controller-linux-arm64,mode=max"]);
    for (const definition of Object.values(plan().target) as Array<Record<string, unknown>>) {
      expect(definition["cache-from"]).toBeUndefined();
      expect(definition["cache-to"]).toBeUndefined();
    }
  });

  it("tags images under a prefix to push them to a local registry", () => {
    const { target } = plan({ push: true, tagPrefix: "kind-registry:5000/octogee/" });
    expect(target["gateway-edge"]).toMatchObject({ output: ["type=image,push=true"], tags: ["kind-registry:5000/octogee/gateway-edge:aaaaaaa"] });
    expect(target["octogee-gateway-base"].tags).toBeUndefined();
  });

  it.each([
    [{ push: true }, "tag prefix"],
    [{ push: true, load: true, tagPrefix: "x/" }, "either load or push"],
    [{ platform: "linux/s390x" }, "Unsupported platform"],
    [{ images: ["artifact-worker"] }, "Unknown platform image"],
    [{ sha: "abc" }, "full source SHA"],
  ])("refuses %j", (overrides, message) => {
    expect(() => plan(overrides)).toThrow(message);
  });
});

describe("public platform image manifest", () => {
  const all = ["glm-controller", "octogee-api", "gateway-edge", "octogee-gateway", "mattermost"];
  const perPlatform = (offset: number) => Object.fromEntries(all.map((name, index) => [name, digest(index + offset)]));
  const digests = { "linux/amd64": perPlatform(0), "linux/arm64": perPlatform(5) };

  it("reads each pushed digest from the bake metadata", () => {
    expect(digestsFromMetadata({ "gateway-edge": { "containerimage.digest": digest(1) } }, ["gateway-edge"])).toEqual({ "gateway-edge": digest(1) });
    expect(() => digestsFromMetadata({}, ["gateway-edge"])).toThrow("No pushed digest for gateway-edge");
  });

  it("joins both platforms into one tagged index per image", () => {
    const commands = mergeCommands({ registry, sha, digests });
    expect(commands[0]).toEqual([
      "buildx", "imagetools", "create", `--tag=${registry}/glm-controller:${sha}`, `--tag=${registry}/glm-controller:aaaaaaa`,
      `${registry}/glm-controller@${digest(0)}`, `${registry}/glm-controller@${digest(5)}`,
    ]);
    expect(() => mergeCommands({ registry, sha, digests: { "linux/amd64": digests["linux/amd64"] } })).toThrow("Missing linux/arm64 digests");
  });

  it("records the index and platform digests of every image", () => {
    const indexes = Object.fromEntries(all.map(name => [name, digest(9)]));
    const manifest = imageManifest({ registry, sha, digests, indexes });
    expect(manifest.images["mattermost"]).toEqual({
      image: `${registry}/mattermost@${digest(9)}`, tag: `${registry}/mattermost:${sha}`, digest: digest(9),
      platforms: { "linux/amd64": digest(4), "linux/arm64": digest(9) },
    });
    expect(() => imageManifest({ registry, sha, digests, indexes: {} })).toThrow("No index digest");
  });
});

describe("image file listing", () => {
  const withTools = async (tools: Record<string, string>, run: () => Promise<unknown>) => {
    const bin = mkdtempSync(join(tmpdir(), "cloud-build-tools-"));
    const path = process.env.PATH;
    try {
      for (const [name, script] of Object.entries(tools)) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
        chmodSync(join(bin, name), 0o755);
      }
      process.env.PATH = `${bin}:${path}`;
      return await run();
    } finally {
      process.env.PATH = path;
      rmSync(bin, { recursive: true, force: true });
    }
  };
  const docker = (exportStep: string) =>
    `case "$1" in create) echo container-1 ;; export) ${exportStep} ;; rm) exit 0 ;; esac`;

  it("lists the files of an exported image", async () => {
    await expect(withTools({ docker: docker("exit 0"), tar: "printf 'app/\\napp/main.js\\n'" }, () => imagePaths("image@sha256:1")))
      .resolves.toEqual(["app/", "app/main.js"]);
  });

  it("fails when the export fails instead of checking an empty listing", async () => {
    await expect(withTools({ docker: docker("exit 3"), tar: "cat > /dev/null" }, () => imagePaths("image@sha256:1")))
      .rejects.toThrow("docker export image@sha256:1 exited 3");
  });

  it("fails when an image lists no files", async () => {
    await expect(withTools({ docker: docker("exit 0"), tar: "cat > /dev/null" }, () => imagePaths("image@sha256:1")))
      .rejects.toThrow("image@sha256:1 lists no files");
  });
});

describe("product tripwire", () => {
  const source = new Set([
    "glm-controller/src/main.ts", "glm-controller/src/lib/ops.ts", "core/src/identity-provider.ts", "shared/types/user.ts",
    "gateway-edge/src/index.ts", "infra/gateway/extensions/platform/octogee-chat-tools",
  ]);
  const exists = (path: string) => source.has(path);

  it("passes files that come from the platform tree, system files and third-party packages", () => {
    expect(productFindings([
      "app/glm-controller/src/main.ts",
      "app/glm-controller/dist/glm-controller/src/main.js",
      "app/glm-controller/dist/glm-controller/src/lib/ops.d.ts",
      "octogee-api/dist/gateway-edge/src/index.js.map",
      "app/core/dist/identity-provider.js",
      "octogee/shared/dist/types/user.d.ts",
      "octogee/extensions/octogee-chat-tools/index.ts",
      "app/node_modules/express/index.js",
      "usr/local/lib/node_modules/openclaw/dist/product/x.js",
      "app/glm-controller/dist/",
    ], exists)).toEqual([]);
  });

  it("flags compiled or copied modules with no platform source, product directories and product packages", () => {
    expect(productFindings([
      "app/glm-controller/dist/glm-controller/src/product-main.js",
      "app/glm-controller/src/signup-offer.ts",
      "app/core/dist/product-deletion-context.js",
      "octogee/scripts/product/lib/octogee-entitlements.ts",
      "octogee/extensions/octogee-board-tools/index.ts",
      "app/node_modules/@octogee/product-core/dist/index.js",
    ], exists)).toEqual([
      "app/core/dist/product-deletion-context.js",
      "app/glm-controller/dist/glm-controller/src/product-main.js",
      "app/glm-controller/src/signup-offer.ts",
      "app/node_modules/@octogee/product-core/dist/index.js",
      "octogee/extensions/octogee-board-tools/index.ts",
      "octogee/scripts/product/lib/octogee-entitlements.ts",
    ]);
  });
});
