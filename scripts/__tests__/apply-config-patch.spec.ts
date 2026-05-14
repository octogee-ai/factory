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

// ── Deadline + retry-after parsing ──────────────────────────────────────────
//
// Production incident 2026-05-13: 4 concurrent migrations hammered OpenClaw's
// config.patch RPC. Server returned `rate limit exceeded for config.patch;
// retry after 44s` but the client ignored that hint and used local exponential
// backoff (2s→4s→8s…30s, indefinitely). With Infinity maxRetries (the prod
// default), christopher's patch took 605s across 13 attempts. The deadline
// caps total time and the retry-after parser uses the server's hint when given.

describe("applyConfigPatch — totalDeadlineMs", () => {
  it("throws once cumulative time exceeds totalDeadlineMs", async () => {
    let now = 0;
    const advance = (ms: number) => {
      now += ms;
    };
    const sleep = vi.fn(async (ms: number) => advance(ms));
    const clock = () => now;

    const configGet = vi.fn(async () => {
      advance(5);
      throw new GatewayRpcError("connect-failed", "WS open timed out after 5ms");
    });

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        {
          ...baseOpts({
            sleep,
            now: clock,
            totalDeadlineMs: 100,
            retryBackoffInitialMs: 50,
            retryBackoffMaxMs: 1000,
            maxRetries: Number.POSITIVE_INFINITY,
          }),
          rpc: makeFakeRpc({ configGet }),
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("totalDeadlineMs"),
    });
  });

  it("caps the next backoff so it doesn't sleep past the deadline", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const clock = () => now;
    const configGet = vi
      .fn()
      .mockRejectedValueOnce(new GatewayRpcError("rpc-error", "transient"))
      .mockResolvedValueOnce({ config: {}, hash: "h" });

    await applyConfigPatch(
      { buildPatch: () => ({}) },
      {
        ...baseOpts({
          sleep,
          now: clock,
          totalDeadlineMs: 30,
          retryBackoffInitialMs: 100,
        }),
        rpc: makeFakeRpc({ configGet }),
      },
    );

    expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(30);
  });
});

describe("applyConfigPatch — server retry-after hint", () => {
  it("honors `retry after Ns` from rpc-error messages instead of local backoff", async () => {
    const sleep = vi.fn(async () => {});
    const configPatch = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRpcError(
          "rpc-error",
          "rate limit exceeded for config.patch; retry after 44s",
        ),
      )
      .mockResolvedValueOnce({ ok: true as const });

    await applyConfigPatch(
      { buildPatch: () => ({}) },
      {
        ...baseOpts({ sleep, retryBackoffInitialMs: 2000 }),
        rpc: makeFakeRpc({ configPatch }),
      },
    );

    expect(sleep).toHaveBeenCalledWith(44_000);
  });

  it("falls through to exponential backoff when the message has no retry-after hint", async () => {
    const sleep = vi.fn(async () => {});
    const configGet = vi
      .fn()
      .mockRejectedValueOnce(new GatewayRpcError("connect-failed", "ECONNRESET"))
      .mockResolvedValueOnce({ config: {}, hash: "h" });

    await applyConfigPatch(
      { buildPatch: () => ({}) },
      {
        ...baseOpts({ sleep, retryBackoffInitialMs: 200 }),
        rpc: makeFakeRpc({ configGet }),
      },
    );

    expect(sleep).toHaveBeenCalledWith(200);
  });

  it("clamps the server retry-after hint by remaining deadline", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const configPatch = vi.fn(async () => {
      now += 10;
      throw new GatewayRpcError(
        "rpc-error",
        "rate limit exceeded for config.patch; retry after 60s",
      );
    });

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        {
          ...baseOpts({
            sleep,
            now: () => now,
            totalDeadlineMs: 500,
            maxRetries: Number.POSITIVE_INFINITY,
          }),
          rpc: makeFakeRpc({ configPatch }),
        },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("totalDeadlineMs") });

    for (const call of sleep.mock.calls) {
      expect(call[0]).toBeLessThanOrEqual(500);
    }
  });
});

// ── Config cache (skip configGet between successive patches) ────────────────
//
// Each customer-add costs ~5-6s in configGet round-trip even when the
// provisioner already knows the current config (it just patched). Threading a
// small mutable `{ current, hash }` cache through applyConfigPatch lets the
// adapter skip configGet entirely after the first successful patch. The
// gateway's config.patch response carries the new hash and merged config —
// updating the cache from that response is a one-liner.

describe("applyConfigPatch — config cache", () => {
  it("uses cached current+hash on first attempt instead of calling configGet", async () => {
    const cache = { current: { bindings: [{ agentId: "a" }] }, hash: "cached-hash" };
    const configGet = vi.fn(async () => ({ config: {}, hash: "fresh" }));
    const configPatch = vi.fn(async () => ({
      ok: true as const,
      hash: "new-hash",
      config: { bindings: [{ agentId: "a" }, { agentId: "b" }] },
    }));

    let seen: unknown;
    await applyConfigPatch(
      {
        buildPatch: (cfg) => {
          seen = cfg;
          return {};
        },
      },
      { ...baseOpts({ cache }), rpc: makeFakeRpc({ configGet, configPatch }) },
    );

    expect(configGet).not.toHaveBeenCalled();
    expect(seen).toEqual({ bindings: [{ agentId: "a" }] });
    expect(configPatch.mock.calls[0][1]).toBe("cached-hash");
  });

  it("updates cache with hash + config from successful configPatch response", async () => {
    const cache = { current: { v: 1 }, hash: "h1" };
    const configPatch = vi.fn(async () => ({
      ok: true as const,
      hash: "h2",
      config: { v: 2 },
    }));

    await applyConfigPatch(
      { buildPatch: () => ({ v: 2 }) },
      { ...baseOpts({ cache }), rpc: makeFakeRpc({ configPatch }) },
    );

    expect(cache.hash).toBe("h2");
    expect(cache.current).toEqual({ v: 2 });
  });

  it("falls back to configGet when cache hash is empty (first call)", async () => {
    const cache = { current: undefined as unknown, hash: "" };
    const configGet = vi.fn(async () => ({ config: { v: 1 }, hash: "fresh" }));
    const configPatch = vi.fn(async () => ({
      ok: true as const,
      hash: "after",
      config: { v: 2 },
    }));

    await applyConfigPatch(
      { buildPatch: () => ({ v: 2 }) },
      { ...baseOpts({ cache }), rpc: makeFakeRpc({ configGet, configPatch }) },
    );

    expect(configGet).toHaveBeenCalledOnce();
    expect(cache.hash).toBe("after");
    expect(cache.current).toEqual({ v: 2 });
  });

  it("on hash-mismatch with cache, refetches via configGet and retries (cache then refreshed)", async () => {
    const cache = { current: { v: 0 }, hash: "stale" };
    const configGet = vi.fn(async () => ({ config: { v: 1 }, hash: "fresh" }));
    const configPatch = vi
      .fn()
      .mockRejectedValueOnce(new GatewayRpcError("hash-mismatch", "config changed since last load"))
      .mockResolvedValueOnce({ ok: true as const, hash: "after", config: { v: 2 } });

    await applyConfigPatch(
      { buildPatch: () => ({ v: 2 }) },
      { ...baseOpts({ cache }), rpc: makeFakeRpc({ configGet, configPatch }) },
    );

    expect(configPatch.mock.calls[0][1]).toBe("stale");
    expect(configPatch.mock.calls[1][1]).toBe("fresh");
    expect(configGet).toHaveBeenCalledOnce();
    expect(cache.hash).toBe("after");
    expect(cache.current).toEqual({ v: 2 });
  });

  it("clears cache hash when configPatch response omits hash (server pre-fork-patch)", async () => {
    const cache = { current: { v: 1 }, hash: "h1" };
    const configPatch = vi.fn(async () => ({ ok: true as const, path: "/x" }));

    await applyConfigPatch(
      { buildPatch: () => ({}) },
      { ...baseOpts({ cache }), rpc: makeFakeRpc({ configPatch }) },
    );

    // No fresh hash returned ⇒ next call must refetch
    expect(cache.hash).toBe("");
  });
});
