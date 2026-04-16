/**
 * Unit tests for `applyConfigPatch` — the fetch-hash / patch / retry /
 * fallback ceremony every runtime writer uses instead of `writeOpenClawConfig`.
 *
 * The orchestrator is what makes RPC migration safe:
 *   - on a transient RPC failure (connect-failed, timeout, rpc-error) it
 *     retries with exponential backoff before giving up;
 *   - on a permanent failure (auth-failed, invalid-patch, invalid-response)
 *     it falls back to file-write immediately;
 *   - on a hash-mismatch it re-fetches the hash and re-patches.
 *
 * Tests inject a `sleep` stub so retry delays don't burn real time.
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

/** Default opts every test uses: temp config path + silenced log + no-wait sleep. */
function baseOpts(configPath: string, extra: Record<string, any> = {}) {
  return {
    configPath,
    log: () => {},
    sleep: vi.fn(async () => {}),
    // Keep backoff length the default (3 entries = 4 attempts) unless a
    // test overrides; real delay is stubbed so no wall-clock cost.
    ...extra,
  };
}

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

describe("applyConfigPatch — RPC happy path", () => {
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
      { ...baseOpts(tmpConfigPath), rpc },
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
        fallback: () => {},
      },
      { ...baseOpts(tmpConfigPath), rpc },
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
      { buildPatch: () => ({}), fallback: () => {} },
      { ...baseOpts(tmpConfigPath), rpc },
    );

    expect(result.mode).toBe("rpc");
    expect(configGet).toHaveBeenCalledTimes(2);
    expect(configPatch).toHaveBeenCalledTimes(2);
    expect(configPatch.mock.calls[0][1]).toBe("stale");
    expect(configPatch.mock.calls[1][1]).toBe("fresh");
  });

  it("hash-mismatch retries do NOT consume the backoff-budget (retry immediately)", async () => {
    const configPatch = vi
      .fn()
      .mockRejectedValueOnce(new GatewayRpcError("hash-mismatch", "stale 1"))
      .mockResolvedValueOnce({ ok: true as const });
    const sleep = vi.fn(async () => {});

    await applyConfigPatch(
      { buildPatch: () => ({}), fallback: () => {} },
      { ...baseOpts(tmpConfigPath, { sleep }), rpc: makeFakeRpc({ configPatch }) },
    );

    // Zero sleeps between attempts — hash-mismatch path goes straight back.
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ── Transient retry with backoff ────────────────────────────────────────────

describe("applyConfigPatch — transient RPC errors retry with backoff", () => {
  it("retries a connect-failed on the next backoff slot and succeeds", async () => {
    const configGet = vi
      .fn()
      .mockRejectedValueOnce(new GatewayRpcError("connect-failed", "WS open timed out after 10000ms"))
      .mockResolvedValueOnce({ config: {}, hash: "h1" });
    const sleep = vi.fn(async () => {});
    const rpc = makeFakeRpc({ configGet });

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback: () => {} },
      {
        ...baseOpts(tmpConfigPath, { retryBackoffMs: [500, 1000, 2000], sleep }),
        rpc,
      },
    );

    expect(result.mode).toBe("rpc");
    expect(result.attempts).toBe(2);
    expect(configGet).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("retries timeout errors across all backoff slots before falling back", async () => {
    const configGet = vi.fn(async () => {
      throw new GatewayRpcError("timeout", "response timed out");
    });
    const sleep = vi.fn(async () => {});
    const fallback = vi.fn();
    const rpc = makeFakeRpc({ configGet });

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback },
      {
        ...baseOpts(tmpConfigPath, { retryBackoffMs: [100, 200, 400], sleep }),
        rpc,
      },
    );

    expect(result.mode).toBe("fallback-file-write");
    expect(result.attempts).toBe(4); // initial + 3 retries
    expect(configGet).toHaveBeenCalledTimes(4);
    // Backoff slot is consumed between each failed attempt.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 400]);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("treats rpc-error as transient and retries", async () => {
    const configGet = vi
      .fn()
      .mockRejectedValueOnce(new GatewayRpcError("rpc-error", "server stalled"))
      .mockResolvedValueOnce({ config: {}, hash: "h" });
    const sleep = vi.fn(async () => {});

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback: () => {} },
      {
        ...baseOpts(tmpConfigPath, { retryBackoffMs: [10], sleep }),
        rpc: makeFakeRpc({ configGet }),
      },
    );

    expect(result.mode).toBe("rpc");
    expect(result.attempts).toBe(2);
  });

  it("does NOT retry when backoff is empty (single-attempt mode)", async () => {
    const configGet = vi.fn(async () => {
      throw new GatewayRpcError("connect-failed", "ECONNREFUSED");
    });
    const sleep = vi.fn(async () => {});
    const fallback = vi.fn();

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback },
      {
        ...baseOpts(tmpConfigPath, { retryBackoffMs: [], sleep }),
        rpc: makeFakeRpc({ configGet }),
      },
    );

    expect(result.mode).toBe("fallback-file-write");
    expect(result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });
});

// ── Permanent errors skip retry ─────────────────────────────────────────────

describe("applyConfigPatch — permanent RPC errors fall back immediately", () => {
  it("falls back on auth-failed without retry", async () => {
    const configGet = vi.fn(async () => {
      throw new GatewayRpcError("auth-failed", "bad token");
    });
    const sleep = vi.fn(async () => {});
    const fallback = vi.fn();

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback },
      {
        ...baseOpts(tmpConfigPath, { retryBackoffMs: [100, 200], sleep }),
        rpc: makeFakeRpc({ configGet }),
      },
    );

    expect(result.mode).toBe("fallback-file-write");
    expect(result.attempts).toBe(1);
    expect(configGet).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back on invalid-patch without retry (server schema rejection)", async () => {
    const configPatch = vi.fn(async () => {
      throw new GatewayRpcError("invalid-patch", "invalid config: channels.mattermost.accounts");
    });
    const sleep = vi.fn(async () => {});
    const fallback = vi.fn();

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback },
      {
        ...baseOpts(tmpConfigPath, { retryBackoffMs: [100, 200], sleep }),
        rpc: makeFakeRpc({ configPatch }),
      },
    );

    expect(result.mode).toBe("fallback-file-write");
    expect(result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("falls back on invalid-response without retry", async () => {
    const configGet = vi.fn(async () => {
      throw new GatewayRpcError("invalid-response", "malformed");
    });
    const sleep = vi.fn(async () => {});

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback: () => {} },
      {
        ...baseOpts(tmpConfigPath, { retryBackoffMs: [100], sleep }),
        rpc: makeFakeRpc({ configGet }),
      },
    );

    expect(result.mode).toBe("fallback-file-write");
    expect(result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ── Fallback correctness + error-bubbling ───────────────────────────────────

describe("applyConfigPatch — fallback correctness + error bubbling", () => {
  it("writes the fallback mutator's result to disk when RPC fails", async () => {
    const configGet = vi.fn(async () => {
      throw new GatewayRpcError("connect-failed", "ECONNREFUSED");
    });
    const fallback = vi.fn((cfg: any) => {
      cfg.bindings.push({ agentId: "a" });
    });

    const result = await applyConfigPatch(
      { buildPatch: () => ({}), fallback, logPrefix: "[test]" },
      {
        ...baseOpts(tmpConfigPath, { retryBackoffMs: [] }),
        rpc: makeFakeRpc({ configGet }),
      },
    );

    expect(result.mode).toBe("fallback-file-write");
    const written = JSON.parse(fs.readFileSync(tmpConfigPath, "utf-8"));
    expect(written.bindings).toEqual([{ agentId: "a" }]);
  });

  it("emits a structured warn line mentioning fallback + reason", async () => {
    const log = vi.fn();
    const configGet = vi.fn(async () => {
      throw new GatewayRpcError("connect-failed", "ECONNREFUSED");
    });

    await applyConfigPatch(
      { buildPatch: () => ({}), fallback: () => {}, logPrefix: "[p]" },
      {
        configPath: tmpConfigPath,
        log,
        retryBackoffMs: [],
        sleep: vi.fn(async () => {}),
        rpc: makeFakeRpc({ configGet }),
      },
    );

    expect(log.mock.calls.some((c) => /fallback|file-write/i.test(String(c[0])))).toBe(true);
    expect(log.mock.calls.some((c) => /connect-failed|ECONNREFUSED/i.test(String(c[0])))).toBe(true);
  });

  it("propagates unknown (non-GatewayRpcError) errors instead of silently falling back", async () => {
    const rpc = makeFakeRpc({
      configGet: vi.fn(async () => {
        throw new Error("bug in caller");
      }),
    });

    await expect(
      applyConfigPatch(
        { buildPatch: () => ({}), fallback: () => {} },
        { ...baseOpts(tmpConfigPath), rpc },
      ),
    ).rejects.toThrow("bug in caller");
  });
});

// ── Timing instrumentation ──────────────────────────────────────────────────

describe("applyConfigPatch — timing instrumentation (#3)", () => {
  it("logs a single-line timing trace on happy-path RPC success", async () => {
    const log = vi.fn();

    await applyConfigPatch(
      { buildPatch: () => ({}), fallback: () => {}, logPrefix: "[p]" },
      {
        configPath: tmpConfigPath,
        log,
        rpc: makeFakeRpc(),
        retryBackoffMs: [],
        sleep: vi.fn(async () => {}),
      },
    );

    const traceLine = log.mock.calls.map((c) => String(c[0])).find((l) => /config\.patch OK/.test(l));
    expect(traceLine).toBeTruthy();
    expect(traceLine).toContain("attempt=1/1");
    expect(traceLine).toMatch(/configGet=\d+ms/);
    expect(traceLine).toMatch(/configPatch=\d+ms/);
    expect(traceLine).toMatch(/totalMs=\d+/);
  });

  it("logs per-attempt failure + backoff delay when retrying", async () => {
    const log = vi.fn();
    const configGet = vi
      .fn()
      .mockRejectedValueOnce(new GatewayRpcError("connect-failed", "WS open timed out after 10000ms"))
      .mockResolvedValueOnce({ config: {}, hash: "h" });

    await applyConfigPatch(
      { buildPatch: () => ({}), fallback: () => {} },
      {
        configPath: tmpConfigPath,
        log,
        retryBackoffMs: [250],
        sleep: vi.fn(async () => {}),
        rpc: makeFakeRpc({ configGet }),
      },
    );

    const attempts = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => /attempt=/.test(l));
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.some((l) => /attempt=1\/2 failed \(connect-failed/.test(l))).toBe(true);
    expect(attempts.some((l) => /retrying in 250ms/.test(l))).toBe(true);
    expect(attempts.some((l) => /OK attempt=2\/2/.test(l))).toBe(true);
  });
});
