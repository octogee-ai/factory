export const DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION = 1 as const;

export const DEVELOPER_TOOLCHAIN_STATUS_FILE_RELATIVE_PATH =
  ".octogee/toolchains/status.json" as const;

export const DEVELOPER_TOOLCHAIN_STATUSES = [
  "pending",
  "downloading",
  "verifying",
  "ready",
  "failed",
] as const;

export type DeveloperToolchainStatus = typeof DEVELOPER_TOOLCHAIN_STATUSES[number];

export interface DeveloperToolchainStatusArtifact {
  schemaVersion: typeof DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION;
  status: DeveloperToolchainStatus;
  updatedAt: string;
}

export function isDeveloperToolchainStatus(value: unknown): value is DeveloperToolchainStatus {
  return typeof value === "string" && DEVELOPER_TOOLCHAIN_STATUSES.includes(value as DeveloperToolchainStatus);
}

export function parseDeveloperToolchainStatusArtifact(
  value: unknown,
): DeveloperToolchainStatusArtifact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const artifact = value as Record<string, unknown>;
  const keys = Object.keys(artifact);
  if (keys.length !== 3 || keys.some((key) => key !== "schemaVersion" && key !== "status" && key !== "updatedAt")) {
    return null;
  }
  if (artifact.schemaVersion !== DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION) return null;
  if (!isDeveloperToolchainStatus(artifact.status)) return null;
  if (typeof artifact.updatedAt !== "string" || Number.isNaN(Date.parse(artifact.updatedAt))) return null;
  return {
    schemaVersion: DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION,
    status: artifact.status,
    updatedAt: artifact.updatedAt,
  };
}
