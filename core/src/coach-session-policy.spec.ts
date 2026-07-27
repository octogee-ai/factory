import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintCoachRuntimePolicy,
  reconcileCoachRuntimeSessionPolicy,
} from "./coach-session-policy.js";

const dirs: string[] = [];

function agentDir(slug = "alice"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "octogee-coach-session-policy-"));
  dirs.push(dir);
  const target = path.join(dir, `octogee-${slug}-coach`, "agent");
  mkdirSync(target, { recursive: true });
  return target;
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    tools: { profile: "coding", alsoAllow: ["octogee_ask_ops"] },
    agents: {
      list: [
        {
          id: "octogee-alice-coach",
          model: "platform-openrouter/z-ai/glm-5.2",
          tools: { fs: { workspaceOnly: true } },
        },
      ],
    },
    ...overrides,
  };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("coach runtime session policy", () => {
  it("fingerprints the current global and per-coach model/tool policy, never credentials", () => {
    const fingerprint = fingerprintCoachRuntimePolicy(config(), "octogee-alice-coach");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).toBe(fingerprintCoachRuntimePolicy(config(), "octogee-alice-coach"));
    expect(fingerprint).not.toBe(
      fingerprintCoachRuntimePolicy(config({ tools: { profile: "minimal", alsoAllow: [] } }), "octogee-alice-coach"),
    );
  });

  it("fingerprints a beta keyed coach entry after Doctor migrates agents.list", () => {
    const keyed = config({
      agents: {
        entries: {
          "octogee-alice-coach": {
            model: "platform-openrouter/z-ai/glm-5.2",
            tools: { fs: { workspaceOnly: true } },
          },
        },
      },
    });

    expect(fingerprintCoachRuntimePolicy(keyed, "octogee-alice-coach"))
      .toBe(fingerprintCoachRuntimePolicy(keyed, "octogee-alice-coach"));
  });

  it("resets existing runtime sessions once before recording a previously-untracked policy", async () => {
    const dir = agentDir();
    const reset = vi.fn(async () => 2);

    await expect(
      reconcileCoachRuntimeSessionPolicy({
        agentDir: dir,
        fingerprint: "a".repeat(64),
        resetSessions: reset,
      }),
    ).resolves.toEqual({ refreshed: true, resetCount: 2 });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(path.join(dir, ".octogee-session-policy.json"), "utf8"))).toEqual({
      fingerprint: "a".repeat(64),
      schemaVersion: 1,
    });
  });

  it("is idempotent after a completed refresh", async () => {
    const dir = agentDir();
    writeFileSync(
      path.join(dir, ".octogee-session-policy.json"),
      JSON.stringify({ schemaVersion: 1, fingerprint: "a".repeat(64) }),
    );
    const reset = vi.fn(async () => 1);

    await expect(
      reconcileCoachRuntimeSessionPolicy({
        agentDir: dir,
        fingerprint: "a".repeat(64),
        resetSessions: reset,
      }),
    ).resolves.toEqual({ refreshed: false, resetCount: 0 });
    expect(reset).not.toHaveBeenCalled();
  });

  it("keeps the previous marker when a refresh fails so the next convergence retries", async () => {
    const dir = agentDir();
    writeFileSync(
      path.join(dir, ".octogee-session-policy.json"),
      JSON.stringify({ schemaVersion: 1, fingerprint: "a".repeat(64) }),
    );
    const reset = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });

    await expect(
      reconcileCoachRuntimeSessionPolicy({
        agentDir: dir,
        fingerprint: "b".repeat(64),
        resetSessions: reset,
      }),
    ).rejects.toThrow("gateway unavailable");
    expect(JSON.parse(readFileSync(path.join(dir, ".octogee-session-policy.json"), "utf8"))).toEqual({
      fingerprint: "a".repeat(64),
      schemaVersion: 1,
    });
  });
});
