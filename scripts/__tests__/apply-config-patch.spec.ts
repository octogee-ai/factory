/**
 * Unit tests for `applyConfigPatch` — the fetch-hash / patch / fallback
 * ceremony every runtime writer on top of §7 uses instead of
 * `writeOpenClawConfig`.
 *
 * The orchestrator is what makes RPC migration safe: on any RPC failure
 * (gateway down, auth, invalid-patch, timeout), it falls back to the
 * existing file-write path so provisioning still completes. Tests cover
 * both rails and the hash-mismatch retry loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { applyConfigPatch } from "../lib/apply-config-patch.js";
import { GatewayRpcError, type GatewayRpcClient } from "../lib/gateway-rpc.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeFakeRpc(overrides: Partial<GatewayRpcClient> = {}): GatewayRpcClient {
  return {
    configGet: overrides.configGet ?? vi.fn(async () => ({ config: {}, hash: "h1" })),
    configPatch:
      overrides.configPatch ??
      vi.fn(async () => ({ ok: true as const, path: "/fake/openclaw.json" })),
    channelsStatus: overrides.channelsStatus ?? vi.fn(async () => ({ channels: [] })),
    isGatewayUp: overrides.isGatewayUp ?? vi.fn(async () => true),
    close: overrides.close ?? vi.fn(async () => {}),
  };
}

// Isolate each test's file-write fallback to a temp openclaw.json.
let tmpDir: string;
let tmpConfigPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-config-patch-"));
  tmpConfigPath = path.join(tmpDir, "openclaw.json");
  fs.writeFileSync(
    tmpConfigPath,
    JSON.stringify(
      { agents: { list: [] }, bindings: [], channels: { mattermost: {} } },
      null,
      2,
    ),
    "utf-8",
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("applyConfigPatch — RPC path", () => {
  it("calls configGet then configPatch with the hash returned by the server", async () => {
    const getFn = vi.fn(async () => ({ config: { bindings: [] }, hash: "abc" }));
    const patchFn = vi.fn(async () => ({ ok: true as const, path: "/x" }));
    const rpc = makeFakeRpc({ configGet: getFn, configPatch: patchFn });

    const result = await applyConfigPatch(
      {
        buildPatch: () => ({ channels: { mattermost: { accounts: { "x-coach": { botToken: "tok" } } } } }),
        fallback: () => {
          throw new Error("fallback must not run on happy path");
        },
      },
      { rpc, configPath: tmpConfigPath, log: () => {} },
    );

    expect(result.mode).toBe("rpc");
    expect(getFn).toHaveBeenCalledOnce();
    expect(patchFn).toHaveBeenCalledOnce();
    expect(patchFn.mock.calls[0][1]).toBe("abc");
    expect(patchFn.mock.calls[0][0]).toEqual({
      channels: { mattermost: { accounts: { "x-coach": { botToken: "tok" } } } },
    });
  });

  it("passes the current config snapshot to buildPatch so callers can merge arrays", async () => {
    const current = { bindings: [{ agentId: "a", match: { peer: { id: "p" } } }] };
    const rpc = makeFakeRpc({
      configGet: vi.fn(async () => ({ config: current, hash: "h" })),
    });

    let seen: unknown;
    await applyConfigPatch(
      {
        buildPatch: (cfg) => {
          seen = cfg;
          return {};
        },
        fallback: () => {},
      },
      { rpc, configPath: tmpConfigPath, log: () => {} },
    );

    expect(seen).toEqual(current);
  });

  it("retries once on hash-mismatch (refetches the hash, re-builds the patch, re-submits)", async () => {
    const configGet = vi
      .fn()
      .mockResolvedValueOnce({ config: {}, hash: "stale" })
      .mockResolvedValueOnce({ config: {}, hash: "fresh" });
    const configPatch = vi
      .fn()
      .mockRejectedValueOnce(new GatewayRpcError("hash-mismatch", "config changed since last load"))
      .mockResolvedValueOnce({ ok: true as const });
    const rpc = makeFakeRpc({ configGet, configPatch });

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback: () => {} },
      { rpc, configPath: tmpConfigPath, log: () => {} },
    );

    expect(result.mode).toBe("rpc");
    expect(configGet).toHaveBeenCalledTimes(2);
    expect(configPatch).toHaveBeenCalledTimes(2);
    expect(configPatch.mock.calls[0][1]).toBe("stale");
    expect(configPatch.mock.calls[1][1]).toBe("fresh");
  });

  it("gives up after one hash-mismatch retry and falls back to file-write", async () => {
    const configPatch = vi
      .fn()
      .mockRejectedValue(new GatewayRpcError("hash-mismatch", "still stale"));
    const rpc = makeFakeRpc({ configPatch });

    const fallback = vi.fn((cfg: any) => {
      cfg.channels.mattermost.accounts = { "x-coach": { botToken: "tok" } };
    });

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback },
      { rpc, configPath: tmpConfigPath, log: () => {} },
    );

    expect(result.mode).toBe("fallback-file-write");
    expect(configPatch).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledOnce();
    const written = JSON.parse(fs.readFileSync(tmpConfigPath, "utf-8"));
    expect(written.channels.mattermost.accounts["x-coach"].botToken).toBe("tok");
  });
});

// ── Fallback path ───────────────────────────────────────────────────────────

describe("applyConfigPatch — fallback to file-write", () => {
  it("falls back when the gateway connection fails", async () => {
    const rpc = makeFakeRpc({
      configGet: vi.fn(async () => {
        throw new GatewayRpcError("connect-failed", "ECONNREFUSED");
      }),
    });
    const fallback = vi.fn((cfg: any) => {
      cfg.bindings.push({ agentId: "a" });
    });
    const log = vi.fn();

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback, logPrefix: "[test]" },
      { rpc, configPath: tmpConfigPath, log },
    );

    expect(result.mode).toBe("fallback-file-write");
    expect(fallback).toHaveBeenCalledOnce();
    const written = JSON.parse(fs.readFileSync(tmpConfigPath, "utf-8"));
    expect(written.bindings).toEqual([{ agentId: "a" }]);
    // Structured warning must mention the fallback + the reason.
    expect(log.mock.calls.some((c) => /fallback|file-write/i.test(String(c[0])))).toBe(true);
    expect(log.mock.calls.some((c) => /ECONNREFUSED|connect-failed/i.test(String(c[0])))).toBe(true);
  });

  it("falls back on auth-failed (bad token)", async () => {
    const rpc = makeFakeRpc({
      configGet: vi.fn(async () => {
        throw new GatewayRpcError("auth-failed", "bad token");
      }),
    });
    const fallback = vi.fn();

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback },
      { rpc, configPath: tmpConfigPath, log: () => {} },
    );

    expect(result.mode).toBe("fallback-file-write");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back on invalid-patch (server schema rejection)", async () => {
    const rpc = makeFakeRpc({
      configPatch: vi.fn(async () => {
        throw new GatewayRpcError("invalid-patch", "invalid config: channels.mattermost.accounts");
      }),
    });
    const fallback = vi.fn();

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback },
      { rpc, configPath: tmpConfigPath, log: () => {} },
    );

    expect(result.mode).toBe("fallback-file-write");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back on timeout", async () => {
    const rpc = makeFakeRpc({
      configPatch: vi.fn(async () => {
        throw new GatewayRpcError("timeout", "response timed out");
      }),
    });
    const fallback = vi.fn();

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback },
      { rpc, configPath: tmpConfigPath, log: () => {} },
    );

    expect(result.mode).toBe("fallback-file-write");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("propagates unknown (non-GatewayRpcError) errors instead of falling back silently", async () => {
    const rpc = makeFakeRpc({
      configGet: vi.fn(async () => {
        throw new Error("bug in caller");
      }),
    });

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}), fallback: () => {} },
        { rpc, configPath: tmpConfigPath, log: () => {} },
      ),
    ).rejects.toThrow("bug in caller");
  });
});
