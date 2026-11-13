import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";
export class OpenClawSecretsApplyError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "OpenClawSecretsApplyError";
        this.status = status;
    }
}
export function authProfileApiKeyTarget(input) {
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
export function buildOpenClawSecretsPlan(targets, now = () => new Date()) {
    return {
        version: 1,
        protocolVersion: 1,
        generatedAt: now().toISOString(),
        generatedBy: "manual",
        targets: [...targets],
    };
}
function cliResult(stdout) {
    try {
        const result = JSON.parse(stdout);
        if (result && typeof result === "object")
            return result;
    }
    catch {
        throw new OpenClawSecretsApplyError("openclaw secrets apply returned invalid JSON", null);
    }
    throw new OpenClawSecretsApplyError("openclaw secrets apply returned an invalid result", null);
}
const CONFIG_MUTATION_CONFLICT = /ConfigMutationConflictError|config changed since last load/i;
const CLI_CONFLICT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
async function applyWithCli(plan, log) {
    for (let attempt = 0;; attempt += 1) {
        try {
            await applyWithCliOnce(plan);
            if (attempt > 0)
                log?.(`[secrets-apply] succeeded after ${attempt} config mutation conflict retr${attempt === 1 ? "y" : "ies"}`);
            return;
        }
        catch (error) {
            const delay = CLI_CONFLICT_RETRY_DELAYS_MS[attempt];
            if (!(error instanceof OpenClawSecretsApplyError) || !CONFIG_MUTATION_CONFLICT.test(error.message) || delay === undefined) {
                throw error;
            }
            log?.(`[secrets-apply] config mutation conflict on attempt ${attempt + 1}/${CLI_CONFLICT_RETRY_DELAYS_MS.length + 1}; retrying in ${delay}ms`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}
async function applyWithCliOnce(plan) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "octogee-secrets-plan-"));
    try {
        const filename = path.join(dir, "plan.json");
        await writeFile(filename, JSON.stringify(plan), { mode: 0o600 });
        const { stdout } = await execFileAsync("openclaw", ["secrets", "apply", "--from", filename, "--allow-exec", "--json"], { timeout: 60_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
        const result = cliResult(stdout);
        if (result.mode !== "write" || typeof result.changed !== "boolean") {
            throw new OpenClawSecretsApplyError("openclaw secrets apply did not acknowledge a write", null);
        }
    }
    catch (error) {
        if (error instanceof OpenClawSecretsApplyError)
            throw error;
        const failure = error;
        const result = failure.stdout ? cliResult(failure.stdout) : undefined;
        const detail = typeof result?.error?.message === "string"
            ? result.error.message
            : `command failed (${failure.code ?? "terminated"})`;
        throw new OpenClawSecretsApplyError(`openclaw secrets apply refused: ${detail}`, typeof failure.code === "number" ? failure.code : null);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
export async function applyOpenClawSecretsPlan(plan, opts = {}) {
    if (plan.targets.length === 0)
        return;
    await (opts.apply ?? ((target) => applyWithCli(target, opts.log)))(plan);
}
