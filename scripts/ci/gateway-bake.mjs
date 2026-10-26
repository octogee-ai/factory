import { findReusable, publishImage } from "./image-build.mjs";

const CUA_DRIVER = "octogee-cua-driver";
const BASE = "octogee-gateway-base";
const BUILDER_BASE = "octogee-gateway-builder-base";
const IMAGES = ["gateway-edge", "octogee-gateway", "octogee-gateway-builder"];
const BUILDER_MAX_COMPRESSED_BYTES = 3100000000;
const common = {
  context: ".",
  platforms: ["linux/amd64"],
  attest: ["type=provenance,disabled=true", "type=sbom,disabled=true"],
  output: ["type=registry"],
};

const requireImmutable = (tag, label) => {
  if (!/^inputs-[a-f0-9]{64}$/.test(tag ?? "")) throw new Error(`An immutable ${label} is required`);
};

export function gatewayBakePlan({ repository, sha, cuaDriver, base, builderBase, toolchain, build }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full source SHA is required");
  if (!/^[a-z0-9.-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(repository)) throw new Error("Invalid registry repository");
  requireImmutable(cuaDriver, "cua-driver image");
  requireImmutable(base, "gateway base");
  if (!/^inputs-[a-f0-9]{64}-builder-[a-f0-9]{12}$/.test(builderBase ?? "") || !builderBase.startsWith(`${base}-`)) throw new Error("An immutable Builder base over the gateway base is required");
  const unknown = build.images.filter(image => !IMAGES.includes(image));
  if (unknown.length) throw new Error(`Unknown gateway image: ${unknown.join(", ")}`);
  const short = sha.slice(0, 7);
  const baseRef = { [CUA_DRIVER]: `${repository}/${CUA_DRIVER}:${cuaDriver}`, [BASE]: `${repository}/${BASE}:${base}`, [BUILDER_BASE]: `${repository}/${BUILDER_BASE}:${builderBase}` };
  const inRun = { [CUA_DRIVER]: build.cuaDriver, [BASE]: build.base, [BUILDER_BASE]: build.builderBase };
  const from = name => inRun[name] ? `target:${name}` : `docker-image://${baseRef[name]}`;
  const cached = name => ({
    "cache-from": [`type=registry,ref=${repository}/cache/${name}:buildcache`],
    "cache-to": [`type=registry,ref=${repository}/cache/${name}:buildcache,mode=max`],
  });
  const image = (name, extra = {}) => ({
    ...common, ...extra, tags: [`${repository}/${name}:${short}`],
    args: { BUILD_SHA: short, ...extra.args },
    labels: { "org.opencontainers.image.revision": sha },
  });
  const plugins = { OPENCLAW_RUNTIME_PLUGINS: "mattermost,parallel-plugin,codex" };
  const candidates = {
    [CUA_DRIVER]: build.cuaDriver && { ...common, dockerfile: "infra/gateway/Dockerfile.cua-driver", tags: [baseRef[CUA_DRIVER]] },
    [BASE]: build.base && {
      ...common, ...cached(BASE), dockerfile: "infra/gateway/Dockerfile.base", target: "gateway-runtime", tags: [baseRef[BASE]],
      contexts: { [CUA_DRIVER]: from(CUA_DRIVER) },
    },
    [BUILDER_BASE]: build.builderBase && {
      ...common, ...cached(BUILDER_BASE), dockerfile: "infra/gateway/Dockerfile.builder-base", tags: [baseRef[BUILDER_BASE]],
      contexts: { [BASE]: from(BASE) },
      args: { BUILDER_TOOLCHAIN_LOCK_SHA256: toolchain.lockSha256, BUILDER_TOOL_GROUPS_SHA256: toolchain.groupsSha256 },
    },
    "gateway-edge": build.images.includes("gateway-edge") && image("gateway-edge", { dockerfile: "gateway-edge/Dockerfile" }),
    "octogee-gateway": build.images.includes("octogee-gateway") && image("octogee-gateway", {
      dockerfile: "infra/gateway/Dockerfile", contexts: { [BASE]: from(BASE) }, args: plugins,
    }),
    "octogee-gateway-builder": build.images.includes("octogee-gateway-builder") && image("octogee-gateway-builder", {
      dockerfile: "infra/gateway/Dockerfile", contexts: { [BASE]: from(BASE), [BUILDER_BASE]: from(BUILDER_BASE) },
      args: { ...plugins, RUNTIME_BASE_IMAGE: BUILDER_BASE, IMAGE_PROFILE: "builder" },
    }),
  };
  const target = Object.fromEntries(Object.entries(candidates).filter(([, definition]) => definition));
  return { group: { default: { targets: Object.keys(target) } }, target };
}

export async function buildGatewayImages({ repository, sha, cuaDriver, base, builderBase, toolchain, force = false }, { exists, script, bake, prepareBase, now = Date.now }) {
  const short = sha.slice(0, 7);
  const build = {
    cuaDriver: !(await exists(`${repository}/${CUA_DRIVER}:${cuaDriver}`)),
    base: !(await exists(`${repository}/${BASE}:${base}`)),
    builderBase: !(await exists(`${repository}/${BUILDER_BASE}:${builderBase}`)),
    images: [],
  };
  const salts = { "gateway-edge": "", "octogee-gateway": base, "octogee-gateway-builder": builderBase };
  const found = {};
  for (const [image, salt] of Object.entries(salts)) {
    found[image] = await findReusable(image, { repository, sha, base: salt, force }, { exists, script });
    if (!found[image].result) build.images.push(image);
  }
  const plan = gatewayBakePlan({ repository, sha, cuaDriver, base, builderBase, toolchain, build });
  const started = now();
  if (plan.group.default.targets.length) {
    if (build.base) await prepareBase();
    await bake(plan);
  }
  const seconds = Math.round((now() - started) / 1000);
  if (!found["octogee-gateway-builder"].published) await script("scripts/lib/assert-artifact-image-size.sh", [
    `${repository}/octogee-gateway-builder:${short}`, String(BUILDER_MAX_COMPRESSED_BYTES), repository.split("/")[1],
  ]);
  for (const image of IMAGES) await publishImage(image, { repository, sha }, found[image], { script });
  return [
    { image: CUA_DRIVER, tag: cuaDriver, result: build.cuaDriver ? "built" : "found", seconds: build.cuaDriver ? seconds : 0 },
    { image: BASE, tag: base, result: build.base ? "built" : "found", seconds: build.base ? seconds : 0 },
    { image: BUILDER_BASE, tag: builderBase, result: build.builderBase ? "built" : "found", seconds: build.builderBase ? seconds : 0 },
    ...IMAGES.map(image => ({ image, tag: short, result: found[image].result || "built", seconds: found[image].result ? 0 : seconds })),
  ];
}
