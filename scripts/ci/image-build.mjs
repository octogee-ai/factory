const definitions = {
  "gateway-edge": { dockerfile: "gateway-edge/Dockerfile" },
  "glm-controller": { dockerfile: "glm-controller/Dockerfile" },
  "artifact-worker": { dockerfile: "artifact-worker/Dockerfile" },
  "octogee-api": { dockerfile: "octogee-api/Dockerfile" },
  "octogee-project-runner": { dockerfile: "octogee-api/Dockerfile", target: "project-runner" },
  "octogee-ops-agent-runtime": { dockerfile: "ops-agent/Dockerfile" },
  "octogee-gateway": { dockerfile: "infra/gateway/Dockerfile" },
  "octogee-gateway-builder": { dockerfile: "infra/gateway/Dockerfile", maxCompressedBytes: 3100000000 },
};

export function imagePlan(name, { repository, sha, base }) {
  if (!definitions[name]) throw new Error(`Unknown image: ${name}`);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full source SHA is required");
  if (!/^[a-z0-9.-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(repository)) throw new Error("Invalid registry repository");
  const builder = name === "octogee-gateway-builder";
  const gateway = name === "octogee-gateway" || builder;
  if (gateway && !(builder ? /^inputs-[a-f0-9]{64}-builder-[a-f0-9]{12}$/ : /^inputs-[a-f0-9]{64}$/).test(base ?? "")) {
    throw new Error("An immutable gateway base is required");
  }
  const buildArgs = { BUILD_SHA: sha.slice(0, 7) };
  if (gateway) Object.assign(buildArgs, {
    OPENCLAW_BASE_IMAGE: `${repository}/octogee-gateway${builder ? "-builder" : ""}-base:${base}`,
    OPENCLAW_RUNTIME_PLUGINS: "mattermost,parallel-plugin,codex",
    ...(builder ? { IMAGE_PROFILE: "builder" } : {}),
  });
  return {
    ...definitions[name], name, repository, buildArgs,
    tag: `${repository}/${name}:${sha.slice(0, 7)}`,
    labels: { "org.opencontainers.image.revision": sha },
    cache: `${repository}/cache/${name}:buildcache`,
  };
}

export async function buildImage(plan, { run, exists }) {
  const args = [
    "buildx", "build", "--platform=linux/amd64", `--file=${plan.dockerfile}`,
    `--tag=${plan.tag}`, "--provenance=false", "--sbom=false", "--push",
  ];
  if (plan.target) args.push(`--target=${plan.target}`);
  for (const [key, value] of Object.entries(plan.buildArgs ?? {})) args.push(`--build-arg=${key}=${value}`);
  for (const [key, value] of Object.entries(plan.labels ?? {})) args.push(`--label=${key}=${value}`);
  if (await exists(plan.cache)) args.push(`--cache-from=type=registry,ref=${plan.cache}`);
  args.push(`--cache-to=type=registry,ref=${plan.cache},mode=max`, ".");
  await run("docker", args);
  if (plan.maxCompressedBytes) await run("bash", [
    "scripts/lib/assert-artifact-image-size.sh", plan.tag, String(plan.maxCompressedBytes), plan.repository.split("/")[1],
  ]);
}
