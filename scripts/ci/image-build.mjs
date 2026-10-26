import { readFileSync } from "node:fs";
import { join } from "node:path";

const definitions = {
  "glm-controller": { dockerfile: "glm-controller/Dockerfile" },
  "artifact-worker": { dockerfile: "artifact-worker/Dockerfile" },
  "octogee-api": { dockerfile: "octogee-api/Dockerfile" },
  "octogee-project-runner": { dockerfile: "octogee-api/Dockerfile", target: "project-runner" },
  "octogee-ops-agent-runtime": { dockerfile: "ops-agent/Dockerfile" },
};

export function imagePlan(name, { repository, sha }) {
  if (!definitions[name]) throw new Error(`Unknown image: ${name}`);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full source SHA is required");
  if (!/^[a-z0-9.-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(repository)) throw new Error("Invalid registry repository");
  return {
    ...definitions[name], name, repository, buildArgs: { BUILD_SHA: sha.slice(0, 7) },
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
}

export async function findReusable(name, { repository, sha, base = "", force = false }, { exists, script }) {
  const short = sha.slice(0, 7);
  if (await exists(`${repository}/${name}:${sha}`)) return { result: "reused (full-SHA tag)", published: true };
  if (force) return { result: "" };
  if (await exists(`${repository}/${name}:${short}`)) return { result: "reused (short tag)" };
  const check = await script("scripts/lib/image-fingerprint-reuse.sh", ["check", name, repository, short, sha, base]);
  const fingerprint = check.match(/^fingerprint=(.*)$/m)?.[1] ?? "";
  return { result: /^exists=true$/m.test(check) ? "reused (fingerprint)" : "", fingerprint };
}

export async function publishImage(name, { repository, sha }, { result, fingerprint, published }, { script }) {
  if (published) return;
  if (!result && fingerprint) await script("scripts/lib/image-fingerprint-reuse.sh", ["record", name, repository, sha.slice(0, 7), fingerprint]);
  await script("scripts/lib/publish-full-sha-image-tag.sh", [name, repository, sha, repository.split("/")[1]]);
}

export async function ensureImage(name, options, { exists, script, build, now = Date.now }) {
  const started = now();
  const found = await findReusable(name, options, { exists, script });
  if (!found.result) await build(imagePlan(name, options));
  await publishImage(name, options, found, { script });
  return { image: name, tag: options.sha.slice(0, 7), result: found.result || "built", seconds: Math.round((now() - started) / 1000) };
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

export const cuaDriverRecipe = (cwd = process.cwd()) => recipe("infra/gateway/Dockerfile.cua-driver", cwd);
export const gatewayBaseRecipe = (cwd = process.cwd()) => [".dockerignore", ...recipe("infra/gateway/Dockerfile.base", cwd), ...cuaDriverRecipe(cwd)];
export const builderBaseRecipe = (cwd = process.cwd()) => recipe("infra/gateway/Dockerfile.builder-base", cwd);
