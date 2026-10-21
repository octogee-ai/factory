import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export async function ensureImage(name, { repository, sha, base = "", force = false }, { exists, script, build, now = Date.now }) {
  const started = now();
  const short = sha.slice(0, 7);
  const finish = result => ({ image: name, tag: short, result, seconds: Math.round((now() - started) / 1000) });
  if (await exists(`${repository}/${name}:${sha}`)) return finish("reused (full-SHA tag)");
  let reused = !force && await exists(`${repository}/${name}:${short}`) ? "reused (short tag)" : "";
  let fingerprint = "";
  if (!reused && !force) {
    const check = await script("scripts/lib/image-fingerprint-reuse.sh", ["check", name, repository, short, sha, base]);
    fingerprint = check.match(/^fingerprint=(.*)$/m)?.[1] ?? "";
    if (/^exists=true$/m.test(check)) reused = "reused (fingerprint)";
  }
  if (!reused) {
    await build(imagePlan(name, { repository, sha, base }));
    if (fingerprint) await script("scripts/lib/image-fingerprint-reuse.sh", ["record", name, repository, short, fingerprint]);
  }
  await script("scripts/lib/publish-full-sha-image-tag.sh", [name, repository, sha, repository.split("/")[1]]);
  return finish(reused || "built");
}

export function buildSummary(rows) {
  const lines = rows.map(({ image, tag, result, seconds }) => `| ${image} | \`${tag}\` | ${result} | ${Math.floor(seconds / 60)}m ${seconds % 60}s |`);
  return ["### Main image build", "", "| Image | Tag | Result | Wall time |", "| --- | --- | --- | --- |", ...lines, ""].join("\n");
}

const copiedFiles = (dockerfile, cwd) => readFileSync(join(cwd, dockerfile), "utf8").split("\n")
  .filter(line => line.startsWith("COPY ") && !/\s--from=/.test(line))
  .flatMap(line => line.split(/\s+/).slice(1).filter(token => !token.startsWith("--")).slice(0, -1));

const recipe = (dockerfile, cwd) => [...new Set([dockerfile, ...copiedFiles(dockerfile, cwd)])]
  .filter(file => !file.startsWith("infra/gateway/openclaw-tarball/"));

export const gatewayBaseRecipe = (cwd = process.cwd()) => [".dockerignore", ...recipe("infra/gateway/Dockerfile.base", cwd)];
export const builderBaseRecipe = (cwd = process.cwd()) => recipe("infra/gateway/Dockerfile.builder-base", cwd);
