type CommandRunner = (command: string, argumentsList: readonly string[]) => string;

type OperatorImageTarget = {
  artifactRegistryLocation: string;
  artifactRegistryProjectId: string;
  artifactRegistryRepository: string;
};

export type PlatformContentMigrationOperatorImage = {
  releaseCommit: string;
  canonicalOpenclawVersion: string;
  tag: string;
  digest: string;
  reference: string;
};

type ResolvePlatformContentMigrationOperatorImageInput = OperatorImageTarget & {
  releaseCommit: string;
  canonicalOpenclawVersion: string;
  run: CommandRunner;
};

const COMMIT = /^[a-f0-9]{40}$/;
const OPENCLAW_VERSION = /^\d{4}\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("operator image metadata must be an object");
  }
  return value as Record<string, unknown>;
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error("operator image build metadata must be an array");
  }
  return value.map(record);
}

export function resolvePlatformContentMigrationOperatorImage(
  input: ResolvePlatformContentMigrationOperatorImageInput,
): PlatformContentMigrationOperatorImage {
  if (!COMMIT.test(input.releaseCommit)) {
    throw new Error("operator image resolution requires an exact 40-character Git commit");
  }
  if (!OPENCLAW_VERSION.test(input.canonicalOpenclawVersion)) {
    throw new Error("operator image resolution requires a canonical OpenClaw version");
  }
  const tag = `${input.releaseCommit.slice(0, 7)}-oc${input.canonicalOpenclawVersion}`;
  const image = `${input.artifactRegistryLocation}-docker.pkg.dev/${input.artifactRegistryProjectId}/${input.artifactRegistryRepository}/octogee-gateway-operator:${tag}`;
  let digest: unknown;
  try {
    const metadata = record(JSON.parse(input.run("gcloud", [
      "artifacts",
      "docker",
      "images",
      "describe",
      image,
      `--project=${input.artifactRegistryProjectId}`,
      "--format=json",
    ])));
    digest = record(metadata.image_summary).digest;
  } catch {
    throw new Error(`operator image ${image} did not resolve to an immutable digest`);
  }
  if (typeof digest !== "string" || !DIGEST.test(digest)) {
    throw new Error(`operator image ${image} did not resolve to an immutable digest`);
  }
  const sourceImage = `${input.artifactRegistryLocation}-docker.pkg.dev/${input.artifactRegistryProjectId}/${input.artifactRegistryRepository}/octogee-gateway-operator:${input.releaseCommit.slice(0, 7)}`;
  let builds: Array<Record<string, unknown>>;
  try {
    builds = records(JSON.parse(input.run("gcloud", [
      "builds",
      "list",
      `--project=${input.artifactRegistryProjectId}`,
      `--region=${input.artifactRegistryLocation}`,
      `--filter=status=SUCCESS AND results.images.digest="${digest}"`,
      "--limit=100",
      "--format=json(status,substitutions,results.images)",
    ])));
  } catch {
    throw new Error(`operator image ${image} does not have trusted exact-source Cloud Build provenance`);
  }
  const trustedBuild = builds.some((build) => {
    const substitutions = record(build.substitutions);
    const results = record(build.results);
    const images = records(results.images);
    return build.status === "SUCCESS"
      && substitutions.COMMIT_SHA === input.releaseCommit
      && substitutions._IMAGE_TAG === input.releaseCommit.slice(0, 7)
      && substitutions._OPENCLAW_VERSION === input.canonicalOpenclawVersion
      && images.some((candidate) => candidate.name === sourceImage && candidate.digest === digest);
  });
  if (!trustedBuild) {
    throw new Error(`operator image ${image} does not have trusted exact-source Cloud Build provenance`);
  }
  return {
    releaseCommit: input.releaseCommit,
    canonicalOpenclawVersion: input.canonicalOpenclawVersion,
    tag,
    digest,
    reference: `${image}@${digest}`,
  };
}
