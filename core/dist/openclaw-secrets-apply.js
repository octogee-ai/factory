import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
/**
 * Writes auth-profile secrets through openclaw's own `secrets apply`, the only
 * sanctioned writer of an agent's auth_profile_store.
 *
 * We used to write the store's sqlite row directly. openclaw 2026.7.2 owns that
 * database — its schema is generated and moves every release, and a row we wrote
 * behind its back is invisible to the secrets runtime until the next boot.
 * `secrets apply` takes a plan of ref-valued targets, writes the store, resolves
 * the refs through the configured providers, and publishes the results to the
 * running agents.
 */
const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";
const PLAN_FILE_MODE = 0o600;
const PLAN_DIR_MODE = 0o700;
const DEFAULT_COMMAND = "openclaw";
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
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
function defaultRun(command, args, options) {
    const result = spawnSync(command, args, {
        env: options.env,
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ...(result.error ? { error: result.error } : {}),
    };
}
function secretsApplyArgs(planPath, dryRun) {
    return [
        "secrets",
        "apply",
        "--from",
        planPath,
        "--allow-exec",
        ...(dryRun ? ["--dry-run"] : []),
    ];
}
/** Applies a plan through the openclaw CLI. Throws OpenClawSecretsApplyError on
 *  any spawn failure or non-zero exit — the caller decides whether that is fatal
 *  or a retry. */
export function applyOpenClawSecretsPlan(plan, opts = {}) {
    if (plan.targets.length === 0)
        return;
    const run = opts.run ?? defaultRun;
    const command = opts.command ?? DEFAULT_COMMAND;
    const planDir = fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "octogee-secrets-plan-"));
    fs.chmodSync(planDir, PLAN_DIR_MODE);
    const planPath = path.join(planDir, "plan.json");
    try {
        fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, { mode: PLAN_FILE_MODE });
        fs.chmodSync(planPath, PLAN_FILE_MODE);
        const result = run(command, secretsApplyArgs(planPath, opts.dryRun === true), {
            env: opts.env ?? process.env,
        });
        if (result.error) {
            throw new OpenClawSecretsApplyError(`openclaw secrets apply could not run: ${result.error.message}`, result.status);
        }
        if (result.status !== 0) {
            throw new OpenClawSecretsApplyError(`openclaw secrets apply exit ${String(result.status)}: ${(result.stderr || result.stdout).trim() || "no output"}`, result.status);
        }
    }
    finally {
        fs.rmSync(planDir, { recursive: true, force: true });
    }
}
