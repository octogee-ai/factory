export declare const DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION: 1;
export declare const DEVELOPER_TOOLCHAIN_STATUS_FILE_RELATIVE_PATH: ".octogee/toolchains/status.json";
export declare const DEVELOPER_TOOLCHAIN_STATUSES: readonly ["pending", "downloading", "verifying", "ready", "failed"];
export type DeveloperToolchainStatus = typeof DEVELOPER_TOOLCHAIN_STATUSES[number];
export interface DeveloperToolchainStatusArtifact {
    schemaVersion: typeof DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION;
    status: DeveloperToolchainStatus;
    updatedAt: string;
}
export declare function isDeveloperToolchainStatus(value: unknown): value is DeveloperToolchainStatus;
export declare function parseDeveloperToolchainStatusArtifact(value: unknown): DeveloperToolchainStatusArtifact | null;
