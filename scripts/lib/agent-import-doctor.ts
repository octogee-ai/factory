import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RequestHandler } from "express";

type JsonObject = Record<string, unknown>;

export interface AgentImportDoctorCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface AgentImportDoctorResult {
  outcome: "migrated" | "unchanged" | "unsupported" | "failed";
  doctorVersion: string;
  changedPaths: string[];
  diagnostics: string[];
  repairedCandidate?: JsonObject;
}

interface AgentImportDoctorOptions {
  command?: string;
  tmpRoot?: string;
  env?: NodeJS.ProcessEnv;
  run?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => AgentImportDoctorCommandResult;
}

const CREDENTIAL_KEYS = new Set([
  "apikey", "api_key", "cookie", "credential", "credentials", "env", "oauth", "password",
  "privatekey", "private_key", "secret", "secrets", "token",
]);

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function assertSecretFree(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertSecretFree);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase().replace(/-/g, ""))) {
      throw new Error("agent import doctor candidate contains a credential-bearing path");
    }
    assertSecretFree(entry);
  }
}

function defaultRun(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): AgentImportDoctorCommandResult {
  const result = spawnSync(command, args, {
    env: options.env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function atomicPrivateWrite(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const left = record(before);
  const right = record(after);
  if (!left || !right || Array.isArray(before) || Array.isArray(after)) return [prefix || "root"];
  const paths: string[] = [];
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const next = prefix ? `${prefix}.${key}` : key;
    paths.push(...changedPaths(left[key], right[key], next));
  }
  return paths;
}

function isolatedEnvironment(
  stateDir: string,
  configPath: string,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL ?? "C.UTF-8",
    HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DOCTOR_MODE: "run",
    NO_COLOR: "1",
  };
}

function versionFrom(result: AgentImportDoctorCommandResult): string {
  if (result.status !== 0) return "unknown";
  const firstLine = result.stdout.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine.replace(/^OpenClaw\s+/i, "").trim() || "unknown";
}

export function runAgentImportDoctor(
  candidate: unknown,
  options: AgentImportDoctorOptions = {},
): AgentImportDoctorResult {
  const source = record(candidate);
  if (!source) throw new Error("agent import doctor candidate must be an object");
  assertSecretFree(source);
  const run = options.run ?? defaultRun;
  const command = options.command ?? "openclaw";
  const stateDir = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "octogee-agent-import-doctor-"));
  fs.chmodSync(stateDir, 0o700);
  const configPath = path.join(stateDir, "openclaw.json");
  try {
    atomicPrivateWrite(configPath, source);
    const env = isolatedEnvironment(stateDir, configPath, options.env ?? process.env);
    const version = versionFrom(run(command, ["--version"], { env }));
    const doctor = run(command, ["doctor", "--fix", "--non-interactive"], { env });
    if (doctor.error) {
      return {
        outcome: "failed",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: ["doctor_spawn_failed"],
      };
    }
    if (doctor.status !== 0) {
      return {
        outcome: "unsupported",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: [`doctor_exit_${String(doctor.status)}`],
      };
    }
    const validate = run(command, ["config", "validate"], { env });
    if (validate.error) {
      return {
        outcome: "failed",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: ["validate_spawn_failed"],
      };
    }
    if (validate.status !== 0) {
      return {
        outcome: "unsupported",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: [`validate_exit_${String(validate.status)}`],
      };
    }
    let repaired: unknown;
    try {
      repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      return {
        outcome: "failed",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: ["doctor_output_invalid"],
      };
    }
    const repairedObject = record(repaired);
    if (!repairedObject) {
      return {
        outcome: "failed",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: ["doctor_output_invalid"],
      };
    }
    assertSecretFree(repairedObject);
    const changes = changedPaths(source, repairedObject);
    return {
      outcome: changes.length > 0 ? "migrated" : "unchanged",
      doctorVersion: version,
      changedPaths: changes,
      diagnostics: [],
      repairedCandidate: repairedObject,
    };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function bearer(req: Parameters<RequestHandler>[0]): string | null {
  const authorization = req.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
}

function safeEqual(left: string | null, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function createAgentImportDoctorHandler(options: {
  token: string;
  runDoctor?: (candidate: unknown) => AgentImportDoctorResult;
}): RequestHandler {
  if (!options.token) throw new Error("agent import doctor token is required");
  const doctor = options.runDoctor ?? ((candidate) => runAgentImportDoctor(candidate));
  return (req, res) => {
    if (!safeEqual(bearer(req), options.token)) {
      res.status(401).json({ error: "agent import doctor authentication failed" });
      return;
    }
    const body = record(req.body);
    if (!body || !record(body.candidate)) {
      res.status(400).json({ error: "agent import doctor candidate is required" });
      return;
    }
    try {
      res.json(doctor(body.candidate));
    } catch (error) {
      res.status(422).json({
        error: "agent import doctor rejected the candidate",
        code: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
