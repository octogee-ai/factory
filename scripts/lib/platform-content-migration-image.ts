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
  return {
    releaseCommit: input.releaseCommit,
    canonicalOpenclawVersion: input.canonicalOpenclawVersion,
    tag,
    digest,
    reference: `${image}@${digest}`,
  };
}
