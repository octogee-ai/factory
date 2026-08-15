import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const h = vi.hoisted(() => ({
  createGatewayRpc: vi.fn(),
}));

vi.mock("./gateway-rpc.js", async (importActual) => {
  const actual = await importActual<typeof import("./gateway-rpc.js")>();
  return { ...actual, createGatewayRpc: h.createGatewayRpc };
});

import {
  applyConfigPatch,
  configPatchRetryPlan,
  isPermanentConfigPatchFailure,
  customerAgentRosterPatch,
  customerConfigAgentRosterReplacePaths,
  customerConfigFullAgentListReplacePaths,
  customerConfigReplacePaths,
  filterOutCustomerBindings,
  fullAgentListReplacePaths,
  mergeCustomerBindings,
  replaceCustomerAgentsInFullAgentList,
  staleProjectAgentAccountNulls,
} from "./apply-config-patch.js";
import { OpenclawWireError, type GatewayRpcClient } from "./gateway-rpc.js";

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

function baseOpts(extra: Record<string, unknown> = {}) {
  return {
    log: () => {},
    sleep: vi.fn(async () => {}),
    
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

describe("applyConfigPatch — RPC happy path", () => {
  it("uses a 60-second RPC call timeout without changing a caller's 90-second deadline", async () => {
    const rpc = makeFakeRpc();
    h.createGatewayRpc.mockReturnValue(rpc);

    await applyConfigPatch(
      { buildPatch: () => ({}) },
      { ...baseOpts({ totalDeadlineMs: 90_000 }) },
    );

    expect(h.createGatewayRpc).toHaveBeenCalledWith({
      allowLegacyGatewayTokenFallback: true,
      callTimeoutMs: 60_000,
    });
  });

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

  it("skips an opted-in RPC when the merge patch is already reflected in current config", async () => {
    const current = {
      agents: {
        defaults: {
          models: {
            "platform-openrouter/openai/gpt-5.6-luna": {},
          },
        },
        list: [
          {
            id: "octogee-alice-coach",
            model: {
              primary: "platform-openrouter/openai/gpt-5.6-luna",
              fallbacks: [],
            },
            tools: { fs: { workspaceOnly: true } },
          },
        ],
      },
    };
    const configPatch = vi.fn(async () => ({ ok: true as const }));
    const rpc = makeFakeRpc({
      configGet: vi.fn(async () => ({ config: current, hash: "current-hash" })),
      configPatch,
    });

    const result = await applyConfigPatch(
      {
        buildPatch: () => ({
          agents: {
            defaults: {
              models: {
                "platform-openrouter/openai/gpt-5.6-luna": {},
              },
            },
            list: current.agents.list,
          },
        }),
        skipIfAlreadyApplied: true,
      },
      { ...baseOpts(), rpc },
    );

    expect(result).toEqual({ mode: "rpc", attempts: 1, noop: true });
    expect(configPatch).not.toHaveBeenCalled();
  });

  it("still sends an opted-in patch when any requested value differs", async () => {
    const configPatch = vi.fn(async () => ({ ok: true as const }));
    const rpc = makeFakeRpc({
      configGet: vi.fn(async () => ({
        config: { agents: { list: [{ id: "octogee-alice-coach", model: "old" }] } },
        hash: "current-hash",
      })),
      configPatch,
    });

    await applyConfigPatch(
      {
        buildPatch: () => ({
          agents: { list: [{ id: "octogee-alice-coach", model: "new" }] },
        }),
        skipIfAlreadyApplied: true,
      },
      { ...baseOpts(), rpc },
    );

    expect(configPatch).toHaveBeenCalledOnce();
  });
});

describe("applyConfigPatch — hash-mismatch", () => {
  it("retries on hash-mismatch (refetches hash, re-builds, re-submits)", async () => {
    const configGet = vi
      .fn()
      .mockResolvedValueOnce({ config: {}, hash: "stale" })
      .mockResolvedValueOnce({ config: {}, hash: "fresh" });
    const configPatch = vi
      .fn()
      .mockRejectedValueOnce(new OpenclawWireError("hash-mismatch", "config changed since last load"))
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

  it("retries the first hash mismatch immediately and backs off a repeated race", async () => {
    const configPatch = vi
      .fn()
      .mockRejectedValueOnce(new OpenclawWireError("hash-mismatch", "stale 1"))
      .mockRejectedValueOnce(new OpenclawWireError("hash-mismatch", "stale 2"))
      .mockResolvedValueOnce({ ok: true as const });
    const sleep = vi.fn(async () => {});

    await applyConfigPatch(
      { buildPatch: () => ({}) },
      {
        ...baseOpts({ sleep, retryBackoffInitialMs: 250 }),
        rpc: makeFakeRpc({ configPatch }),
      },
    );

    expect(sleep).toHaveBeenCalledExactlyOnceWith(250);
  });

  it("throws hash-mismatch when maxRetries is exhausted", async () => {
    const configPatch = vi.fn(async () => {
      throw new OpenclawWireError("hash-mismatch", "racing writer");
    });

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        { ...baseOpts({ maxRetries: 2 }), rpc: makeFakeRpc({ configPatch }) },
      ),
    ).rejects.toMatchObject({ code: "hash-mismatch" });
  });
});

describe("applyConfigPatch — transient RPC errors retry with backoff", () => {
  it("retries a connect-failed on the next backoff slot and succeeds", async () => {
    const configGet = vi
      .fn()
      .mockRejectedValueOnce(
        new OpenclawWireError("connect-failed", "WS open timed out after 10000ms"),
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
      .mockRejectedValueOnce(new OpenclawWireError("rpc-error", "server stalled"))
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
      throw new OpenclawWireError("timeout", "response timed out");
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
    ).rejects.toBeInstanceOf(OpenclawWireError);

expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 400, 400]);
  });

  it("throws the OpenclawWireError when maxRetries is exhausted (no file-write fallback)", async () => {
    const configGet = vi.fn(async () => {
      throw new OpenclawWireError("connect-failed", "ECONNREFUSED");
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

describe("applyConfigPatch — permanent RPC errors throw without retry", () => {
  it("throws auth-failed without retry", async () => {
    const configGet = vi.fn(async () => {
      throw new OpenclawWireError("auth-failed", "bad token");
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
      throw new OpenclawWireError("invalid-patch", "invalid config: channels.mattermost.accounts");
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
      throw new OpenclawWireError("invalid-response", "malformed");
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

  it("throws a redacted SecretRef placeholder rejection without retry", async () => {
    const configPatch = vi.fn(async () => {
      throw new OpenclawWireError(
        "rpc-error",
        "SecretRef at agents.list[].memorySearch.remote.apiKey contains a redacted id placeholder with no matching original value.",
      );
    });
    const sleep = vi.fn(async () => {});

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        { ...baseOpts({ sleep }), rpc: makeFakeRpc({ configPatch }) },
      ),
    ).rejects.toMatchObject({ code: "rpc-error" });
    expect(configPatch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("applyConfigPatch — caller error bubbling", () => {
  it("propagates unknown (non-OpenclawWireError) errors without touching retry", async () => {
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
        new OpenclawWireError("connect-failed", "WS open timed out after 10000ms"),
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
      throw new OpenclawWireError("connect-failed", "WS open timed out after 5ms");
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
      .mockRejectedValueOnce(new OpenclawWireError("rpc-error", "transient"))
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
  it("plans retry delays from server hints and flags retry wording without a parsed hint", () => {
    expect(
      configPatchRetryPlan(
        new OpenclawWireError("rpc-error", "rate limit exceeded; retry after 44s"),
        2_000,
        30_000,
      ),
    ).toEqual({
      delayMs: 30_000,
      missingRetryAfterHint: false,
      source: "server retry-after",
    });

    expect(
      configPatchRetryPlan(
        new OpenclawWireError("rpc-error", "please retry later"),
        2_000,
        30_000,
      ),
    ).toEqual({
      delayMs: 2_000,
      missingRetryAfterHint: true,
      source: "exp backoff",
    });
  });

  it("honors `retry after Ns` from rpc-error messages instead of local backoff", async () => {
    const sleep = vi.fn(async () => {});
    const configPatch = vi
      .fn()
      .mockRejectedValueOnce(
        new OpenclawWireError(
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
      .mockRejectedValueOnce(new OpenclawWireError("connect-failed", "ECONNRESET"))
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
      throw new OpenclawWireError(
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

describe("applyConfigPatch — abort signal", () => {
  it("throws immediately if the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled by caller"));
    const configGet = vi.fn(async () => ({ config: {}, hash: "h" }));

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        { ...baseOpts(), rpc: makeFakeRpc({ configGet }), signal: ctrl.signal },
      ),
    ).rejects.toThrow(/cancelled by caller|aborted/i);
    expect(configGet).not.toHaveBeenCalled();
  });

  it("aborts the sleep between retries and stops the loop", async () => {
    const ctrl = new AbortController();
    const configGet = vi.fn(async () => {
      throw new OpenclawWireError("connect-failed", "transient");
    });
    const sleep = vi.fn(async () => {
      ctrl.abort(new Error("cancelled mid-backoff"));
    });

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        {
          ...baseOpts({ sleep, retryBackoffInitialMs: 1000, maxRetries: Number.POSITIVE_INFINITY }),
          rpc: makeFakeRpc({ configGet }),
          signal: ctrl.signal,
        },
      ),
    ).rejects.toThrow(/cancelled mid-backoff|aborted/i);
    expect(configGet).toHaveBeenCalledTimes(1);
  });

  it("default sleep wakes early when the signal fires mid-wait (no caller-supplied sleep)", async () => {

const ctrl = new AbortController();
    const configGet = vi.fn(async () => {
      throw new OpenclawWireError("connect-failed", "ECONNRESET");
    });
    setTimeout(() => ctrl.abort(new Error("test-cancelled")), 30);
    const startedAt = Date.now();
    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}) },
        {
          log: () => {},
          maxRetries: Number.POSITIVE_INFINITY,
          retryBackoffInitialMs: 5_000,
          rpc: makeFakeRpc({ configGet }),
          signal: ctrl.signal,
        },
      ),
    ).rejects.toThrow(/test-cancelled|aborted/i);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(1_000);
  });
});

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

  it("invalidates the cache when configPatch returns only a new hash", async () => {
    const cache = { current: { v: 1 }, hash: "h1" };
    const configPatch = vi.fn(async () => ({ ok: true as const, hash: "h2" }));

    await applyConfigPatch(
      { buildPatch: () => ({ v: 2 }) },
      { ...baseOpts({ cache }), rpc: makeFakeRpc({ configPatch }) },
    );

    expect(cache).toEqual({ current: undefined, hash: "" });
  });

  it("preserves the accepted cache after a no-op response omits hash and config", async () => {
    const cache = { current: { v: 1 }, hash: "h1" };
    const configPatch = vi.fn(async () => ({
      ok: true as const,
      noop: true as const,
      path: "/x",
    }));

    await applyConfigPatch(
      { buildPatch: () => ({}) },
      { ...baseOpts({ cache }), rpc: makeFakeRpc({ configPatch }) },
    );

    expect(cache).toEqual({ current: { v: 1 }, hash: "h1" });
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
      .mockRejectedValueOnce(new OpenclawWireError("hash-mismatch", "config changed since last load"))
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

expect(cache.hash).toBe("");
  });
});

describe("applyConfigPatch — replacePaths threading (OC destructive-array guard)", () => {
  it("passes buildReplacePaths(current) to rpc.configPatch alongside the patch", async () => {
    const configPatch = vi.fn(async () => ({ ok: true as const, path: "/x" }));
    const rpc = makeFakeRpc({
      configGet: vi.fn(async () => ({ config: { tag: "cfg1" }, hash: "h1" })),
      configPatch,
    });

    await applyConfigPatch(
      {
        buildPatch: () => ({ bindings: [] }),
        buildReplacePaths: (current) => ["bindings", (current as { tag: string }).tag],
      },
      { ...baseOpts(), rpc },
    );

    expect(configPatch).toHaveBeenCalledWith(
      { bindings: [] },
      "h1",
      { replacePaths: ["bindings", "cfg1"] },
    );
  });

  it("recomputes replacePaths from the re-fetched config on hash-mismatch retry", async () => {
    const configs = [
      { config: { tag: "stale-cfg" }, hash: "stale" },
      { config: { tag: "fresh-cfg" }, hash: "fresh" },
    ];
    const configGet = vi.fn(async () => configs.shift()!);
    const configPatch = vi
      .fn()
      .mockRejectedValueOnce(new OpenclawWireError("hash-mismatch", "config changed since last load"))
      .mockResolvedValueOnce({ ok: true as const, path: "/x" });

    await applyConfigPatch(
      {
        buildPatch: () => ({}),
        buildReplacePaths: (current) => [(current as { tag: string }).tag],
      },
      { ...baseOpts(), rpc: makeFakeRpc({ configGet, configPatch }) },
    );

    expect(configPatch.mock.calls[0][2]).toEqual({ replacePaths: ["stale-cfg"] });
    expect(configPatch.mock.calls[1][2]).toEqual({ replacePaths: ["fresh-cfg"] });
  });

  it("omits the third arg entirely when buildReplacePaths is absent or returns []", async () => {
    const configPatch = vi.fn(async () => ({ ok: true as const, path: "/x" }));
    await applyConfigPatch(
      { buildPatch: () => ({}) },
      { ...baseOpts(), rpc: makeFakeRpc({ configPatch }) },
    );
    expect(configPatch.mock.calls[0][2]).toBeUndefined();

    const configPatchEmpty = vi.fn(async () => ({ ok: true as const, path: "/x" }));
    await applyConfigPatch(
      { buildPatch: () => ({}), buildReplacePaths: () => [] },
      { ...baseOpts(), rpc: makeFakeRpc({ configPatch: configPatchEmpty }) },
    );
    expect(configPatchEmpty.mock.calls[0][2]).toBeUndefined();
  });

  it("treats the destructive-array guard rpc-error as permanent — one attempt, no retry burn", async () => {
    const guardError = new OpenclawWireError(
      "rpc-error",
      "config.patch would remove entries from array path(s): bindings. " +
        "Pass replacePaths with the exact path(s) when this is intentional, or use config.apply for full-config replacement.",
    );
    const configPatch = vi.fn(async () => {
      throw guardError;
    });
    const sleep = vi.fn(async () => {});
    const logs: string[] = [];

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({ bindings: [] }) },
        { ...baseOpts({ sleep }), log: (m: string) => logs.push(m), rpc: makeFakeRpc({ configPatch }) },
      ),
    ).rejects.toThrow(/would remove entries from array path/);

    expect(configPatch).toHaveBeenCalledTimes(1); // permanent — not retried to the deadline
    expect(sleep).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("buildReplacePaths"))).toBe(true); // points at the fix
  });
});

describe("isPermanentConfigPatchFailure", () => {
  it("classifies invalid patch responses, redacted SecretRefs, and destructive array guard rejections as permanent", () => {
    expect(
      isPermanentConfigPatchFailure(
        new OpenclawWireError("invalid-patch", "invalid patch"),
      ),
    ).toBe(true);
    expect(
      isPermanentConfigPatchFailure(
        new OpenclawWireError(
          "rpc-error",
          "config.patch would remove entries from array path(s): bindings",
        ),
      ),
    ).toBe(true);
    expect(
      isPermanentConfigPatchFailure(
        new OpenclawWireError(
          "rpc-error",
          "SecretRef at agents.list[].memorySearch.remote.apiKey contains a redacted id placeholder with no matching original value.",
        ),
      ),
    ).toBe(true);
    expect(
      isPermanentConfigPatchFailure(new OpenclawWireError("timeout", "timed out")),
    ).toBe(false);
  });

  it("classifies the roster-drop refusal as permanent — an identical retry can never carry the allowance", () => {
    expect(
      isPermanentConfigPatchFailure(
        new OpenclawWireError(
          "rpc-error",
          "Config write would drop agent roster entries without an explicit deletion: octogee-alice-proj-old-coach",
        ),
      ),
    ).toBe(true);
  });
});

describe("fullAgentListReplacePaths — the guard confirmation set for full agents.list patches", () => {
  it("confirms the list itself plus the per-entry arrays the platform rewrites — the guard descends into id-keyed entries and names shrunk nested arrays individually", () => {
    expect(fullAgentListReplacePaths()).toEqual([
      "agents.list",
      "agents.list[].model.fallbacks",
      "agents.list[].tools.alsoAllow",
    ]);
  });
});

describe("customerConfigReplacePaths — the customer-scoped guard confirmation set", () => {
  it("confirms bindings without flipping agents.list upserts into replacement", () => {
    expect(customerConfigReplacePaths({}, "alice")).toEqual(["bindings"]);
  });

  it("adds the full-agent-list set only for callers that intentionally send the full replacement list", () => {
    expect(customerConfigFullAgentListReplacePaths({}, "alice")).toEqual([
      "agents.list",
      "agents.list[].model.fallbacks",
      "agents.list[].tools.alsoAllow",
      "bindings",
    ]);
  });

  it("confirms every array under the null-deleted account (mirrors OC collectBaseArrayPaths)", () => {
    const current = {
      channels: {
        mattermost: {
          accounts: {
            "alice-coach": {
              botToken: "x",
              groupAllowFrom: ["mm-user-1", "mm-user-2"],
              nested: { deep: { list: [1, 2] } },
            },
            "bob-coach": { groupAllowFrom: ["mm-user-3"] }, // other accounts untouched
          },
        },
      },
    };
    expect(customerConfigReplacePaths(current, "alice")).toEqual([
      "bindings",
      "channels.mattermost.accounts.alice-coach.groupAllowFrom",
      "channels.mattermost.accounts.alice-coach.nested.deep.list",
    ]);
    expect(customerConfigFullAgentListReplacePaths(current, "alice")).toEqual([
      "agents.list",
      "agents.list[].model.fallbacks",
      "agents.list[].tools.alsoAllow",
      "bindings",
      "channels.mattermost.accounts.alice-coach.groupAllowFrom",
      "channels.mattermost.accounts.alice-coach.nested.deep.list",
    ]);
  });

  it("handles an absent or non-object account (just customer-scoped arrays to confirm)", () => {
    expect(
      customerConfigReplacePaths({ channels: { mattermost: { accounts: {} } } }, "alice"),
    ).toEqual(["bindings"]);
    expect(
      customerConfigReplacePaths(
        { channels: { mattermost: { accounts: { "alice-coach": "garbage" } } } },
        "alice",
      ),
    ).toEqual(["bindings"]);
  });
});

describe("replaceCustomerAgentsInFullAgentList", () => {
  const current = {
    agents: {
      list: [
        { id: "octogee-mac-default" },
        { id: "octogee-alice-coach", stale: true },
        { id: "octogee-alice-proj-old-coach", stale: true },
        { id: "octogee-bob-coach" },
        { id: "octogee-bob-proj-app-coach" },
      ],
    },
  };

  it("drops ALL of the customer's agents (coach + project) and replaces them at the first customer-owned slot, leaving other tenants alone", () => {
    const list = replaceCustomerAgentsInFullAgentList(current, "alice", [
      { id: "octogee-alice-coach" },
      { id: "octogee-alice-proj-orbit-coach" },
    ]);

    expect(list.map((a) => (a as { id: string }).id)).toEqual([
      "octogee-mac-default",
      "octogee-alice-coach",
      "octogee-alice-proj-orbit-coach",
      "octogee-bob-coach",
      "octogee-bob-proj-app-coach",
    ]);
  });

  it("does not confuse hyphenated sibling slugs (alice vs alice-b)", () => {
    const list = replaceCustomerAgentsInFullAgentList(
      { agents: { list: [{ id: "octogee-alice-b-coach" }] } },
      "alice",
      [{ id: "octogee-alice-coach" }],
    );
    expect(list.map((a) => (a as { id: string }).id)).toEqual([
      "octogee-alice-b-coach",
      "octogee-alice-coach",
    ]);
  });

  it("replaces the customer slice in place so redacted SecretRef paths for sibling agents stay stable", () => {
    const list = replaceCustomerAgentsInFullAgentList(
      {
        agents: {
          list: [
            { id: "octogee-mac-default" },
            { id: "octogee-alice-coach", stale: true },
            {
              id: "octogee-bob-coach",
              memorySearch: {
                remote: {
                  apiKey: {
                    __redacted: true,
                    id: "platform-openai-embedding-octogee-bob-coach",
                  },
                },
              },
            },
          ],
        },
      },
      "alice",
      [{ id: "octogee-alice-coach" }],
    );

    expect(list.map((a) => (a as { id: string }).id)).toEqual([
      "octogee-mac-default",
      "octogee-alice-coach",
      "octogee-bob-coach",
    ]);
  });
});

describe("customerAgentRosterPatch", () => {
  it("uses beta keyed entries, upserts only live agents, and translates memorySearch", () => {
    const current = {
      agents: {
        entries: {
          "octogee-alice-coach": { model: "old" },
          "octogee-alice-proj-old-coach": { model: "old" },
          "octogee-bob-coach": { model: "house" },
        },
      },
    };
    const patch = customerAgentRosterPatch(current, "alice", [
      {
        id: "octogee-alice-coach",
        model: "new",
        memorySearch: { provider: "openai-compatible" },
      },
      { id: "octogee-bob-coach", model: "house" },
    ]);

    expect(patch).toEqual({
      entries: {
        "octogee-alice-coach": {
          model: "new",
          memory: { search: { provider: "openai-compatible" } },
        },
      },
    });
    expect(customerConfigAgentRosterReplacePaths(current, "alice")).toEqual(["bindings"]);
  });

  it("never nulls a retired customer entry — 2026.7.2 refuses roster drops without agents.delete", () => {
    const current = {
      agents: {
        entries: {
          "octogee-alice-coach": { model: "old" },
          "octogee-alice-proj-retired-coach": { model: "old" },
        },
      },
    };

    const patch = customerAgentRosterPatch(current, "alice", [
      { id: "octogee-alice-coach", model: "new" },
    ]) as { entries: Record<string, unknown> };

    expect(Object.values(patch.entries)).not.toContain(null);
    expect(patch.entries).not.toHaveProperty("octogee-alice-proj-retired-coach");
  });

  it("retains the stable list patch and destructive array guard confirmations", () => {
    const current = { agents: { list: [{ id: "octogee-bob-coach" }] } };
    expect(customerAgentRosterPatch(current, "alice", [{ id: "octogee-alice-coach" }])).toEqual({
      list: [{ id: "octogee-alice-coach" }],
    });
    expect(customerConfigAgentRosterReplacePaths(current, "alice")).toEqual(
      customerConfigFullAgentListReplacePaths(current, "alice"),
    );
  });

  it("confirms the arrays a nulled keyed agent entry destroys", () => {
    // Nulling `agents.entries.<id>` deletes every array beneath it. OpenClaw's
    // destructive-array guard walks base-vs-merged and reports each one
    // (collectBaseArrayPaths on the `isPlainObject(base) && !isPlainObject(patch)`
    // branch), so an unconfirmed path refuses the whole removal:
    //   config.patch would remove entries from array path(s):
    //   agents.entries.octogee-alice-coach.model.fallbacks
    // That is what deadlocked the TEST shared-b surge handoff — imports landed,
    // unmount never did, and Cowboy re-migrated the same customers in a loop.
    const current = {
      agents: {
        entries: {
          "octogee-alice-coach": {
            model: { fallbacks: ["platform-openrouter/z-ai/glm-5.2"] },
            tools: { alsoAllow: ["octogee_status"] },
          },
          "octogee-alice-proj-orbit-coach": {
            model: { fallbacks: ["platform-openrouter/z-ai/glm-5.2"] },
          },
          "octogee-bob-coach": { model: { fallbacks: ["untouched"] } },
        },
      },
    };

    const paths = customerConfigAgentRosterReplacePaths(current, "alice");

    expect(paths).toEqual(expect.arrayContaining([
      "agents.entries.octogee-alice-coach.model.fallbacks",
      "agents.entries.octogee-alice-coach.tools.alsoAllow",
      "agents.entries.octogee-alice-proj-orbit-coach.model.fallbacks",
    ]));
    // Another customer's arrays are not ours to confirm — a removal that could
    // silently shrink them should still be refused.
    expect(paths).not.toContain("agents.entries.octogee-bob-coach.model.fallbacks");
  });

  it("confirms nothing extra for a keyed agent entry that holds no arrays", () => {
    // test31 deprovisioned cleanly on the unfixed build precisely because its
    // entry had no arrays to destroy; the guard had nothing to report.
    const current = {
      agents: { entries: { "octogee-alice-coach": { model: "house" } } },
    };
    expect(customerConfigAgentRosterReplacePaths(current, "alice")).toEqual(["bindings"]);
  });

  it("confirms arrays under every one of the customer's project accounts", () => {
    const current = {
      agents: { list: [] },
      channels: {
        mattermost: {
          accounts: {
            "alice-coach": { groupAllowFrom: ["workspace"] },
            "alice-proj-orbit": { groupAllowFrom: ["orbit"] },
            "alice-proj-old": { allowBots: ["retired"] },
            "bob-proj-orbit": { groupAllowFrom: ["foreign"] },
          },
        },
      },
    };

    expect(customerConfigAgentRosterReplacePaths(current, "alice")).toEqual([
      "agents.list",
      "agents.list[].model.fallbacks",
      "agents.list[].tools.alsoAllow",
      "bindings",
      "channels.mattermost.accounts.alice-coach.groupAllowFrom",
      "channels.mattermost.accounts.alice-proj-orbit.groupAllowFrom",
      "channels.mattermost.accounts.alice-proj-old.allowBots",
    ]);
  });
});

describe("filterOutCustomerBindings", () => {
  it("removes coach AND project-agent bindings for the slug only", () => {
    const bindings = [
      { agentId: "octogee-alice-coach" },
      { agentId: "octogee-alice-proj-old-coach" },
      {
        agentId: "octogee-bob-coach",
        match: { channel: "mattermost", accountId: "alice-coach" },
      },
      {
        agentId: "octogee-bob-coach",
        match: { channel: "mattermost", accountId: "alice-proj-orbit" },
      },
      { agentId: "octogee-bob-coach" },
      {
        agentId: "octogee-bob-coach",
        match: { channel: "mattermost", accountId: "alice-b-proj-orbit" },
      },
      { agentId: "octogee-mac-default" },
    ];
    expect(filterOutCustomerBindings(bindings, "alice")).toEqual([
      { agentId: "octogee-bob-coach" },
      {
        agentId: "octogee-bob-coach",
        match: { channel: "mattermost", accountId: "alice-b-proj-orbit" },
      },
      { agentId: "octogee-mac-default" },
    ]);
  });
});

describe("mergeCustomerBindings", () => {
  const aliceCoach = {
    agentId: "octogee-alice-coach",
    match: { channel: "mattermost", accountId: "alice-coach", peer: { kind: "group", id: "g1" } },
  };
  const bobCoach = {
    agentId: "octogee-bob-coach",
    match: { channel: "mattermost", accountId: "bob-coach", peer: { kind: "group", id: "g2" } },
  };
  const carolCoach = {
    agentId: "octogee-carol-coach",
    match: { channel: "mattermost", accountId: "carol-coach", peer: { kind: "group", id: "g3" } },
  };

  it("returns the current array untouched when the customer's binding content is unchanged", () => {
    const current = [aliceCoach, bobCoach, carolCoach];
    const next = mergeCustomerBindings(current, ["bob"], [structuredClone(bobCoach)]);
    expect(next).toBe(current);
  });

  it("keeps current order when unchanged even though rebuild would have appended", () => {
    const current = [bobCoach, aliceCoach];
    const next = mergeCustomerBindings(current, ["bob"], [structuredClone(bobCoach)]);
    expect(next.map((b) => b.agentId)).toEqual(["octogee-bob-coach", "octogee-alice-coach"]);
  });

  it("rewrites when the customer gains a binding", () => {
    const added = {
      agentId: "octogee-bob-proj-x-coach",
      match: { channel: "mattermost", accountId: "bob-proj-x", peer: { kind: "group", id: "g9" } },
    };
    const current = [aliceCoach, bobCoach];
    const next = mergeCustomerBindings(current, ["bob"], [bobCoach, added]);
    expect(next).not.toBe(current);
    expect(next.map((b) => b.agentId)).toEqual([
      "octogee-alice-coach",
      "octogee-bob-coach",
      "octogee-bob-proj-x-coach",
    ]);
  });

  it("rewrites when a binding's content changes", () => {
    const moved = structuredClone(bobCoach);
    moved.match.peer.id = "g2-moved";
    const current = [aliceCoach, bobCoach];
    const next = mergeCustomerBindings(current, ["bob"], [moved]);
    expect(next).not.toBe(current);
    expect(next.map((b) => b.match.peer.id)).toEqual(["g1", "g2-moved"]);
  });

  it("rewrites to drop eviction slugs' bindings", () => {
    const current = [aliceCoach, bobCoach, carolCoach];
    const next = mergeCustomerBindings(current, ["bob", "carol"], [structuredClone(bobCoach)]);
    expect(next).not.toBe(current);
    expect(next.map((b) => b.agentId)).toEqual(["octogee-alice-coach", "octogee-bob-coach"]);
  });

  it("appends a first-time customer's bindings", () => {
    const current = [aliceCoach];
    const next = mergeCustomerBindings(current, ["bob"], [bobCoach]);
    expect(next.map((b) => b.agentId)).toEqual(["octogee-alice-coach", "octogee-bob-coach"]);
  });
});

describe("staleProjectAgentAccountNulls", () => {
  const current = {
    channels: {
      mattermost: {
        accounts: {
          "alice-coach": { botToken: "a" },
          "alice-proj-old": { botToken: "dead" },
          "alice-proj-orbit": { botToken: "live" },
          "alice-b-proj-x": { botToken: "sibling" },
          default: { botToken: "d" },
        },
      },
    },
  };

  it("nulls the customer's project accounts that are no longer active (omission is not deletion in config.patch)", () => {
    expect(staleProjectAgentAccountNulls(current, "alice", ["alice-proj-orbit"])).toEqual({
      "alice-proj-old": null,
    });
  });

  it("nulls all project accounts when none are kept, ignoring hyphenated siblings", () => {
    expect(staleProjectAgentAccountNulls(current, "alice", [])).toEqual({
      "alice-proj-old": null,
      "alice-proj-orbit": null,
    });
  });
});
