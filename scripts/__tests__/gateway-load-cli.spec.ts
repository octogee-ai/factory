import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("gateway load CLI execution intent", () => {
  const run = (...flags: string[]) => {
    const dir = mkdtempSync(resolve(tmpdir(), "gateway-load-cli-")); dirs.push(dir);
    const plan = resolve(dir, "plan.json");
    const out = resolve(dir, "report");
    writeFileSync(plan, JSON.stringify({ gatewayId: "shared-0", readConcurrency: [1], coachConcurrency: [1], maxCoachTurns: 1,
      targets: [{ name: "alice", workspaceSlug: "alice", tokenEnv: "OCTOGEE_LOAD_TOKEN_ALICE", channelId: "a".repeat(26) }] }));
    const result = spawnSync(process.execPath,
      ["--import", "tsx", resolve(import.meta.dirname, "../ops/gateway-load-test.ts"), `--plan=${plan}`, `--out=${out}`, ...flags],
      { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10_000, env: { ...process.env, OCTOGEE_LOAD_TOKEN_ALICE: "private-invalid-token" } });
    return { result, out };
  };

  it("previews without credentials, Kubernetes calls, or output directory creation", () => {
    const { result, out } = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ execute: false, targets: 1, coachTurns: 1 });
    expect(existsSync(out)).toBe(false);
    expect(result.stdout + result.stderr).not.toContain("private-invalid-token");
  });

  it("requires a separate opt-in for real coach turns before opening any session", () => {
    const { result, out } = run("--execute");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plan validation");
    expect(existsSync(out)).toBe(false);
    expect(result.stdout + result.stderr).not.toContain("private-invalid-token");
  });
});
