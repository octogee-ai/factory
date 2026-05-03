import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { applyConfigPatch } from "../lib/apply-config-patch.js";
import { GatewayRpcError, type GatewayRpcClient } from "../lib/gateway-rpc.js";

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

/** Default opts every test uses: silenced log + no-wait sleep + finite retries. */
function baseOpts(extra: Record<string, unknown> = {}) {
  return {
    log: () => {},
    sleep: vi.fn(async () => {}),
    // Tests pin a small maxRetries so exhaustion-path assertions don't hang.
    maxRetries: 3,
    ...extra,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-config-patch-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("applyConfigPatch — RPC happy path", () => {
  it("calls configGet then configPatch with the hash returned by the server", async () => {
    const getFn = vi.fn(async () => ({ config: { bindings: [] }, hash: "abc" }));
    const patchFn = vi.fn(async () => ({ ok: true as const, path: "/x" }));
    const rpc = makeFakeRpc({ configGet: getFn, configPatch: patchFn });

    const result = await applyConfigPatch(
      {
        buildPatch: () => ({
          channels: { mattermost: { accounts: { "x-coach": { botToken: "tok" } } } },
        }),
      },
      { ...baseOpts(), rpc },
    );

    expect(result.mode).toBe("rpc");
    expect(result.attempts).toBe(1);
    expect(getFn).toHaveBeenCalledOnce();
    expect(patchFn).toHaveBeenCalledOnce();
    expect(patchFn.mock.calls[0][1]).toBe("abc");
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
      },
      { ...baseOpts(), rpc },
    );

    expect(seen).toEqual(current);
  });
});

// ── Hash-mismatch retries ───────────────────────────────────────────────────

describe("applyConfigPatch — hash-mismatch", () => {
  it("retries on hash-mismatch (refetches hash, re-builds, re-submits)", async () => {
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
      { buildPatch: () => ({}) },
      { ...baseOpts(), rpc },
    );

    expect(result.mode).toBe("rpc");
    expect(configGet).toHaveBeenCalledTimes(2);
    expect(configPatch).toHaveBeenCalledTimes(2);
    expect(configPatch.mock.calls[0][1]).toBe("stale");
    expect(configPatch.mock.calls[1][1]).toBe("fresh");
  });

  it("hash-mismatch retries do NOT consume any backoff sleep (retry immediately)", async () => {
    const configPatch = vi
      .fn()
      .mockRejectedValueOnce(new GatewayRpcError("hash-mismatch", "stale 1"))
      .mockResolvedValueOnce({ ok: true as const });
    const sleep = vi.fn(async () => {});

    await applyConfigPatch(
      { buildPatch: () => ({}) },
      { ...baseOpts({ sleep }), rpc: makeFakeRpc({ configPatch }) },
    );

    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws hash-mismatch when maxRetries is exhausted", async () => {
    const configPatch = vi.fn(async () => {
      throw new GatewayRpcError("hash-mismatch", "racing writer");
    });

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        { ...baseOpts({ maxRetries: 2 }), rpc: makeFakeRpc({ configPatch }) },
      ),
    ).rejects.toMatchObject({ code: "hash-mismatch" });
  });
});

// ── Transient retry with backoff ────────────────────────────────────────────

describe("applyConfigPatch — transient RPC errors retry with backoff", () => {
  it("retries a connect-failed on the next backoff slot and succeeds", async () => {
    const configGet = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRpcError("connect-failed", "WS open timed out after 10000ms"),
      )
      .mockResolvedValueOnce({ config: {}, hash: "h1" });
    const sleep = vi.fn(async () => {});
    const rpc = makeFakeRpc({ configGet });

    const result = await applyConfigPatch(
      { buildPatch: () => ({}) },
      { ...baseOpts({ retryBackoffInitialMs: 500, sleep }), rpc },
    );

    expect(result.mode).toBe("rpc");
    expect(result.attempts).toBe(2);
    expect(configGet).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("treats rpc-error as transient and retries", async () => {
    const configGet = vi
      .fn()
      .mockRejectedValueOnce(new GatewayRpcError("rpc-error", "server stalled"))
      .mockResolvedValueOnce({ config: {}, hash: "h" });

    const result = await applyConfigPatch(
      { buildPatch: () => ({}) },
      { ...baseOpts({ retryBackoffInitialMs: 10 }), rpc: makeFakeRpc({ configGet }) },
    );

    expect(result.mode).toBe("rpc");
    expect(result.attempts).toBe(2);
  });

  it("doubles the backoff between attempts (capped at retryBackoffMaxMs)", async () => {
    const configGet = vi.fn(async () => {
      throw new GatewayRpcError("timeout", "response timed out");
    });
    const sleep = vi.fn(async () => {});

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        {
          ...baseOpts({
            maxRetries: 5,
            retryBackoffInitialMs: 100,
            retryBackoffMaxMs: 400,
            sleep,
          }),
          rpc: makeFakeRpc({ configGet }),
        },
      ),
    ).rejects.toBeInstanceOf(GatewayRpcError);

    // maxRetries=5 → 4 sleeps between 5 attempts: 100, 200, 400 (capped), 400.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 400, 400]);
  });

  it("throws the GatewayRpcError when maxRetries is exhausted (no file-write fallback)", async () => {
    const configGet = vi.fn(async () => {
      throw new GatewayRpcError("connect-failed", "ECONNREFUSED");
    });

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        { ...baseOpts({ maxRetries: 2 }), rpc: makeFakeRpc({ configGet }) },
      ),
    ).rejects.toMatchObject({ code: "connect-failed" });
    expect(configGet).toHaveBeenCalledTimes(2);
  });
});

// ── Permanent errors throw immediately ──────────────────────────────────────

describe("applyConfigPatch — permanent RPC errors throw without retry", () => {
  it("throws auth-failed without retry", async () => {
    const configGet = vi.fn(async () => {
      throw new GatewayRpcError("auth-failed", "bad token");
    });
    const sleep = vi.fn(async () => {});

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        { ...baseOpts({ sleep }), rpc: makeFakeRpc({ configGet }) },
      ),
    ).rejects.toMatchObject({ code: "auth-failed" });

    expect(configGet).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws invalid-patch without retry (server schema rejection)", async () => {
    const configPatch = vi.fn(async () => {
      throw new GatewayRpcError("invalid-patch", "invalid config: channels.mattermost.accounts");
    });
    const sleep = vi.fn(async () => {});

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        { ...baseOpts({ sleep }), rpc: makeFakeRpc({ configPatch }) },
      ),
    ).rejects.toMatchObject({ code: "invalid-patch" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws invalid-response without retry", async () => {
    const configGet = vi.fn(async () => {
      throw new GatewayRpcError("invalid-response", "malformed");
    });
    const sleep = vi.fn(async () => {});

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        { ...baseOpts({ sleep }), rpc: makeFakeRpc({ configGet }) },
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ── Error bubbling for non-RPC exceptions ───────────────────────────────────

describe("applyConfigPatch — caller error bubbling", () => {
  it("propagates unknown (non-GatewayRpcError) errors without touching retry", async () => {
    const rpc = makeFakeRpc({
      configGet: vi.fn(async () => {
        throw new Error("bug in caller");
      }),
    });

    await expect(
      applyConfigPatch({ buildPatch: () => ({}) }, { ...baseOpts(), rpc }),
    ).rejects.toThrow("bug in caller");
  });
});

// ── Timing instrumentation ──────────────────────────────────────────────────

describe("applyConfigPatch — timing instrumentation", () => {
  it("logs a single-line timing trace on happy-path RPC success", async () => {
    const log = vi.fn();

    await applyConfigPatch(
      { buildPatch: () => ({}), logPrefix: "[p]" },
      { ...baseOpts({ log }), rpc: makeFakeRpc() },
    );

    const traceLine = log.mock.calls.map((c) => String(c[0])).find((l) => /config\.patch OK/.test(l));
    expect(traceLine).toBeTruthy();
    expect(traceLine).toContain("attempt=1");
    expect(traceLine).toMatch(/configGet=\d+ms/);
    expect(traceLine).toMatch(/configPatch=\d+ms/);
    expect(traceLine).toMatch(/totalMs=\d+/);
  });

  it("logs per-attempt failure + backoff delay when retrying", async () => {
    const log = vi.fn();
    const configGet = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRpcError("connect-failed", "WS open timed out after 10000ms"),
      )
      .mockResolvedValueOnce({ config: {}, hash: "h" });

    await applyConfigPatch(
      { buildPatch: () => ({}) },
      {
        ...baseOpts({ log, retryBackoffInitialMs: 250 }),
        rpc: makeFakeRpc({ configGet }),
      },
    );

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /attempt=1 failed \(connect-failed/.test(l))).toBe(true);
    expect(lines.some((l) => /retrying in 250ms/.test(l))).toBe(true);
    expect(lines.some((l) => /OK attempt=2/.test(l))).toBe(true);
  });
});
