import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";

export interface AuthProfileApiKeyTarget {
  type: "auth-profiles.api_key.key";
  path: string;
  ref: { source: "exec"; provider: string; id: string };
  agentId: string;
  authProfileProvider: string;
}

export interface OpenClawSecretsPlan {
  version: 1;
  protocolVersion: 1;
  generatedAt: string;
  generatedBy: "manual";
  targets: AuthProfileApiKeyTarget[];
}

export class OpenClawSecretsApplyError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "OpenClawSecretsApplyError";
    this.status = status;
  }
}

export function authProfileApiKeyTarget(input: {
  agentId: string;
  profileId: string;
  provider: string;
  refId: string;
  refProvider?: string;
}): AuthProfileApiKeyTarget {
  return {
    type: "auth-profiles.api_key.key",
    path: `profiles.${input.profileId}.key`,
    ref: {
      source: "exec",
      provider: input.refProvider ?? SECRET_RESOLVER_PROVIDER,
      id: input.refId,
    },
    agentId: input.agentId,
    authProfileProvider: input.provider,
  };
}

export function buildOpenClawSecretsPlan(
  targets: readonly AuthProfileApiKeyTarget[],
  now: () => Date = () => new Date(),
): OpenClawSecretsPlan {
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: now().toISOString(),
    generatedBy: "manual",
    targets: [...targets],
  };
}

export interface ApplyOpenClawSecretsPlanOptions {
  apply?: (plan: OpenClawSecretsPlan) => Promise<unknown>;
}

function cliResult(stdout: string): { mode?: unknown; changed?: unknown; error?: { message?: unknown } } {
  try {
    const result: unknown = JSON.parse(stdout);
    if (result && typeof result === "object") return result;
  } catch {
    throw new OpenClawSecretsApplyError("openclaw secrets apply returned invalid JSON", null);
  }
  throw new OpenClawSecretsApplyError("openclaw secrets apply returned an invalid result", null);
}

async function applyWithCli(plan: OpenClawSecretsPlan): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "octogee-secrets-plan-"));
  try {
    const filename = path.join(dir, "plan.json");
    await writeFile(filename, JSON.stringify(plan), { mode: 0o600 });
    const { stdout } = await execFileAsync(
      "openclaw",
      ["secrets", "apply", "--from", filename, "--allow-exec", "--json"],
      { timeout: 60_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
    );
    const result = cliResult(stdout);
    if (result.mode !== "write" || typeof result.changed !== "boolean") {
      throw new OpenClawSecretsApplyError("openclaw secrets apply did not acknowledge a write", null);
    }
  } catch (error) {
    if (error instanceof OpenClawSecretsApplyError) throw error;
    const failure = error as { stdout?: string; code?: string | number };
    const result = failure.stdout ? cliResult(failure.stdout) : undefined;
    const detail = typeof result?.error?.message === "string"
      ? result.error.message
      : `command failed (${failure.code ?? "terminated"})`;
    throw new OpenClawSecretsApplyError(`openclaw secrets apply refused: ${detail}`, typeof failure.code === "number" ? failure.code : null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function applyOpenClawSecretsPlan(
  plan: OpenClawSecretsPlan,
  opts: ApplyOpenClawSecretsPlanOptions = {},
): Promise<void> {
  if (plan.targets.length === 0) return;
  await (opts.apply ?? applyWithCli)(plan);
}
