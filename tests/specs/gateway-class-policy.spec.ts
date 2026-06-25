import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(repoRoot, "infra/gateway/apply-gateway-class-policy.mjs");

function runPolicy(gatewayClass: string, config: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "octogee-gateway-class-"));
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(config, null, 2));
  const result = spawnSync("node", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_DIR: dir,
      GATEWAY_CLASS: gatewayClass,
      GATEWAY_PROFILE: "",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `class policy failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as any;
}

describe("infra/gateway/apply-gateway-class-policy.mjs", () => {
  it("shared class denies exec/process but KEEPS codex allowlisted and CLAMPS it to a sandboxed app-server (workspace-write, never YOLO)", () => {
    const out = runPolicy("shared", {
      tools: {
        deny: ["read"],
        subagents: { tools: { deny: ["write"] } },
      },
      plugins: {
        allow: ["codex"],
        entries: {
          codex: { enabled: true, config: { appServer: { sandbox: "danger-full-access" } } },
        },
      },
    });

    expect(out.tools.deny).toEqual(["read", "exec", "process"]);
    expect(out.tools.exec).toEqual({ mode: "deny" });
    expect(out.tools.subagents.tools.deny).toEqual(["write", "exec", "process"]);
    // BYOS codex may run on a shared pod, but only sandboxed: the policy clamps a
    // danger-full-access request down to workspace-write and keeps codex
    // allowlisted so byot-sync can enable it per-customer.
    expect(out.plugins.allow).toEqual(["codex"]);
    expect(out.plugins.entries.codex.config.appServer.sandbox).toBe("workspace-write");
    expect(out.plugins.entries.codex.config.appServer.approvalPolicy).toBe("never");
  });

  it("builder class enables OpenClaw exec/process but keeps Codex disabled", () => {
    const out = runPolicy("builder", {
      tools: {
        deny: ["exec", "process", "read"],
        exec: { mode: "deny" },
        subagents: { tools: { deny: ["exec", "process", "write"] } },
      },
      plugins: {
        allow: ["codex"],
        entries: { codex: { enabled: true } },
      },
    });

    expect(out.tools.deny).toEqual(["read"]);
    expect(out.tools.exec).toBeUndefined();
    expect(out.tools.subagents.tools.deny).toEqual(["write"]);
    expect(out.plugins.allow).toEqual([]);
    expect(out.plugins.entries.codex.enabled).toBe(false);
  });

  it("operator class leaves the config untouched for the operator-image patcher", () => {
    const config = {
      tools: { deny: ["exec"], exec: { mode: "deny" } },
      plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
    };
    const out = runPolicy("operator", config);
    expect(out).toEqual(config);
  });
});
