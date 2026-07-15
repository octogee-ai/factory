import fs from "node:fs";
import path from "node:path";

export const SYSTEM_CONFIG_METADATA_FILENAME = ".octogee.json";
export const SYSTEM_CONFIG_GITIGNORE_FILENAME = ".gitignore";
export const SYSTEM_CONFIG_GITIGNORE = "*.bak\n*.tmp\n";
export const CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION = 1;

export function assertSystemConfigMetadata(contents: string): void {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("system_config metadata must contain an object");
  }
  const metadata = parsed as Record<string, unknown>;
  if (
    !Number.isInteger(metadata.schemaVersion) ||
    (metadata.schemaVersion as number) < 0 ||
    (metadata.schemaVersion as number) > CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION
  ) {
    throw new Error("system_config metadata schemaVersion is invalid");
  }
  if (metadata.lastMigration !== undefined && typeof metadata.lastMigration !== "string") {
    throw new Error("system_config metadata lastMigration is invalid");
  }
}

export function assertSystemConfigGitignore(contents: string): void {
  if (contents !== SYSTEM_CONFIG_GITIGNORE) {
    throw new Error("system_config .gitignore is invalid");
  }
}

export function assertSystemConfigSupportFiles(repoDir: string): void {
  assertSystemConfigMetadata(
    fs.readFileSync(path.join(repoDir, SYSTEM_CONFIG_METADATA_FILENAME), "utf8"),
  );
  assertSystemConfigGitignore(
    fs.readFileSync(path.join(repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), "utf8"),
  );
}
