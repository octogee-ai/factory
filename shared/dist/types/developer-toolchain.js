export const DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION = 1;
export const DEVELOPER_TOOLCHAIN_STATUS_FILE_RELATIVE_PATH = ".octogee/toolchains/status.json";
export const DEVELOPER_TOOLCHAIN_STATUSES = [
    "pending",
    "downloading",
    "verifying",
    "ready",
    "failed",
];
export function isDeveloperToolchainStatus(value) {
    return typeof value === "string" && DEVELOPER_TOOLCHAIN_STATUSES.includes(value);
}
export function parseDeveloperToolchainStatusArtifact(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const artifact = value;
    const keys = Object.keys(artifact);
    if (keys.length !== 3 || keys.some((key) => key !== "schemaVersion" && key !== "status" && key !== "updatedAt")) {
        return null;
    }
    if (artifact.schemaVersion !== DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION)
        return null;
    if (!isDeveloperToolchainStatus(artifact.status))
        return null;
    if (typeof artifact.updatedAt !== "string" || Number.isNaN(Date.parse(artifact.updatedAt)))
        return null;
    return {
        schemaVersion: DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION,
        status: artifact.status,
        updatedAt: artifact.updatedAt,
    };
}
