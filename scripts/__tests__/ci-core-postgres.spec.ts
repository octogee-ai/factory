import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: exec }));
import { runCorePostgresChecks } from "../ci/core-postgres.mjs";

let directory: string;
let drift = false;
let integrationFails = false;
let roleValid = true;
const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];

beforeEach(() => {
  vi.spyOn(process, "getuid").mockReturnValue(501);
  vi.stubEnv("OCTOGEE_TEST_POSTGRES_DSN", "postgresql://ambient-must-not-be-used/example");
  calls.length = 0;
  directory = "";
  drift = integrationFails = false;
  roleValid = true;
  exec.mockReset().mockImplementation((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command: basename(command), args, env: options.env });
    if (basename(command) === "postgres") return "postgres (PostgreSQL) 16.15\n";
    if (basename(command) === "initdb") {
      const data = args[args.indexOf("-D") + 1];
      directory = dirname(data);
      mkdirSync(data);
      writeFileSync(join(data, "postgresql.conf"), "");
    }
    if (basename(command) === "psql" && args.includes("-At")) return roleValid ? "t\n" : "f\n";
    if (basename(command) === "git" && args.includes("diff") && drift) throw new Error("catalog drift");
    if (command === "npm" && integrationFails) throw new Error("integration failed");
    return "";
  });
});
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("required core PostgreSQL CI", () => {
  it("uses an isolated non-superuser owner and runs both PG files after pinned catalog qualification", () => {
    runCorePostgresChecks();
    const qualifier = calls.findIndex(call => call.args.some(arg => arg.endsWith("qualify-agent-store-routines.mjs")));
    const diff = calls.findIndex(call => call.command === "git" && call.args.includes("diff"));
    const integration = calls.findIndex(call => call.command === "npm");
    expect(qualifier).toBeGreaterThan(-1);
    expect(diff).toBeGreaterThan(qualifier);
    expect(integration).toBeGreaterThan(diff);
    expect(calls[integration].args).toEqual(["test", "--", "src/agent-store-postgres.integration.spec.ts", "src/agent-store-recovery.integration.spec.ts", "--maxWorkers=1", "--no-file-parallelism"]);
    const dsn = new URL(calls[integration].env!.OCTOGEE_TEST_POSTGRES_DSN!);
    expect(dsn.username).toBe("octogee_ci_admin");
    expect(dsn.searchParams.get("host")).toBe(join(directory, "socket"));
    expect(calls.find(call => call.command === "psql" && call.args.some(arg => arg.includes("CREATE ROLE")))?.args.join(" ")).toContain("NOSUPERUSER NOCREATEDB CREATEROLE");
    expect(calls.at(-1)?.args).toContain("stop");
    expect(existsSync(directory)).toBe(false);
  });

  it("fails a wrong-role preflight before qualification or tests and stops its private server", () => {
    roleValid = false;
    expect(() => runCorePostgresChecks()).toThrow(/non-superuser/);
    expect(calls.some(call => call.command === "npm")).toBe(false);
    expect(calls.some(call => call.args.some(arg => arg.endsWith("qualify-agent-store-routines.mjs")))).toBe(false);
    expect(calls.at(-1)?.args).toContain("stop");
    expect(existsSync(directory)).toBe(false);
  });

  it("preserves catalog drift as failure while still running integration, including its own failure", () => {
    drift = integrationFails = true;
    expect(() => runCorePostgresChecks()).toThrow(/catalog drift[\s\S]*integration failed/);
    expect(calls.some(call => call.command === "npm")).toBe(true);
    expect(calls.some(call => call.command === "git" && call.args.includes("restore"))).toBe(false);
    expect(calls.at(-1)?.args).toContain("stop");
    expect(existsSync(directory)).toBe(false);
  });
});
