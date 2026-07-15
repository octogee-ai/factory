import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateOpenClawConfig } from "./openclaw-config-validation.js";
import {
  mattermostAccountSecretsPath,
  updateMattermostAccountSecrets,
} from "./mattermost-account-secrets.js";
import {
  checkpointDurableSystemConfigForSlug,
  extractLegacyMattermostAccountSecrets,
  removeLegacyMacConfig,
  SystemConfigCheckpointError,
  type SystemConfigSyncResult,
  systemConfigPath,
} from "./system-config.js";
import { reconcilePlatformInvariants } from "./system-config-invariants.js";

type JsonObject = Record<string, unknown>;

export interface SystemConfigAdoptionResult {
  applied: boolean;
  approvalHash: string;
  changedPaths: string[];
  acceptedCommit?: string;
}

interface SystemConfigAdoptionOptions {
  slug: string;
  sourcePath: string;
  openclawDir: string;
  env?: NodeJS.ProcessEnv;
  approveHash?: string;
  validateConfig?: (configPath: string) => void;
  writeSecrets?: typeof updateMattermostAccountSecrets;
  checkpoint?: typeof checkpointDurableSystemConfigForSlug;
}

export class SystemConfigAdoptionApprovalError extends Error {
  readonly code = "adoption-approval-mismatch";

  constructor() {
    super("adoption approval hash does not match the validated candidate");
    this.name = "SystemConfigAdoptionApprovalError";
  }
}

export class SystemConfigAdoptionCheckpointError extends Error {
  readonly code = "adoption-checkpoint-failed";

  constructor(
    readonly localState: "restored" | "committed-pending" | "rollback-failed",
    readonly checkpointError: unknown,
    readonly rollbackError?: unknown,
  ) {
    super(`config adoption checkpoint failed; local state is ${localState}`);
    this.name = "SystemConfigAdoptionCheckpointError";
  }
}

function parseObject(contents: string): JsonObject {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("adoption source must contain a JSON object");
  }
  return parsed as JsonObject;
}

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function readMattermostSecrets(openclawDir: string): Record<string, string> {
  const filePath = mattermostAccountSecretsPath(openclawDir);
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = parseObject(contents);
  if (!Object.values(parsed).every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("Mattermost account secret store contains an invalid value");
  }
  return parsed as Record<string, string>;
}

function setMattermostProviderPath(config: JsonObject, providerPath: string): void {
  const secrets = config.secrets as JsonObject;
  const providers = secrets.providers as JsonObject;
  const provider = providers["octogee-mattermost"] as JsonObject;
  provider.path = providerPath;
}

function validateAdoptionCandidate(
  candidate: JsonObject,
  secrets: Record<string, string>,
  openclawDir: string,
  validate: (configPath: string) => void,
): void {
  const validationDir = fs.mkdtempSync(path.join(openclawDir, ".system-config-adoption-"));
  fs.chmodSync(validationDir, 0o700);
  try {
    const validationSecretsPath = path.join(validationDir, "mattermost-accounts.json");
    const validationConfigPath = path.join(validationDir, "openclaw.json");
    atomicWrite(validationSecretsPath, `${JSON.stringify(secrets, null, 2)}\n`);
    const validationCandidate = structuredClone(candidate);
    setMattermostProviderPath(validationCandidate, validationSecretsPath);
    atomicWrite(validationConfigPath, `${JSON.stringify(validationCandidate, null, 2)}\n`);
    validate(validationConfigPath);
  } finally {
    fs.rmSync(validationDir, { recursive: true, force: true });
  }
}

const PRECOMMIT_CHECKPOINT_FAILURES = new Set([
  "invalid-builder-slug",
  "checkout-unavailable",
  "openclaw-json-missing",
  "remote-head-unavailable",
  "non-fast-forward-conflict",
  "status-check-failed",
  "validation-failed",
  "validation-restore-failed",
  "platform-invariant-violation",
  "stage-failed",
  "sync-locked",
]);

function canRestoreAfterCheckpointFailure(result: SystemConfigSyncResult): boolean {
  if (result.committed || result.pushed) return false;
  if (result.rejected) return true;
  return PRECOMMIT_CHECKPOINT_FAILURES.has(result.errorCode ?? result.skipped ?? "");
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function changedJsonPaths(
  before: unknown,
  after: unknown,
  prefix = "",
): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!isObject(before) || !isObject(after)) return prefix ? [prefix] : ["root"];
  const paths: string[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      paths.push(...changedJsonPaths({}, after[key], childPath));
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(after, key)) {
      paths.push(...changedJsonPaths(before[key], {}, childPath));
      continue;
    }
    paths.push(...changedJsonPaths(before[key], after[key], childPath));
  }
  return paths;
}

export async function adoptSystemConfig(
  options: SystemConfigAdoptionOptions,
): Promise<SystemConfigAdoptionResult> {
  const env = options.env ?? process.env;
  const targetPath = systemConfigPath(options.openclawDir);
  const currentContents = fs.readFileSync(targetPath, "utf8");
  const current = parseObject(currentContents);
  const currentSecrets = readMattermostSecrets(options.openclawDir);
  const candidate = parseObject(fs.readFileSync(options.sourcePath, "utf8"));
  removeLegacyMacConfig(candidate, env);
  const secrets = extractLegacyMattermostAccountSecrets(candidate);
  reconcilePlatformInvariants(candidate, env);
  const contents = `${JSON.stringify(candidate, null, 2)}\n`;
  const approvalHash = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
  validateAdoptionCandidate(
    candidate,
    { ...currentSecrets, ...secrets },
    options.openclawDir,
    options.validateConfig ?? validateOpenClawConfig,
  );
  const changedPaths = changedJsonPaths(current, candidate);
  if (options.approveHash === undefined) {
    return { applied: false, approvalHash, changedPaths };
  }
  if (options.approveHash !== approvalHash) throw new SystemConfigAdoptionApprovalError();

  const writeSecrets = options.writeSecrets ?? updateMattermostAccountSecrets;
  const secretIds = Object.keys(secrets);
  if (secretIds.length > 0) {
    await writeSecrets(options.openclawDir, { set: secrets });
  }
  atomicWrite(targetPath, contents);
  let result: SystemConfigSyncResult;
  try {
    result = (options.checkpoint ?? checkpointDurableSystemConfigForSlug)(options.slug, {
      openclawDir: options.openclawDir,
      env,
      source: "boot-migration",
      validateConfig: options.validateConfig,
    });
  } catch (error) {
    if (!(error instanceof SystemConfigCheckpointError) ||
        !canRestoreAfterCheckpointFailure(error.result)) {
      throw new SystemConfigAdoptionCheckpointError("committed-pending", error);
    }
    try {
      atomicWrite(targetPath, currentContents);
      if (secretIds.length > 0) {
        const previous = Object.fromEntries(
          secretIds.flatMap((accountId) => currentSecrets[accountId] === undefined
            ? []
            : [[accountId, currentSecrets[accountId]]]),
        );
        const remove = secretIds.filter((accountId) => currentSecrets[accountId] === undefined);
        await writeSecrets(options.openclawDir, { set: previous, remove });
      }
    } catch (rollbackError) {
      throw new SystemConfigAdoptionCheckpointError("rollback-failed", error, rollbackError);
    }
    throw new SystemConfigAdoptionCheckpointError("restored", error);
  }
  return {
    applied: true,
    approvalHash,
    changedPaths,
    acceptedCommit: result.acceptedCommit,
  };
}
