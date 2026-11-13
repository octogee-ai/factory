import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INTERNAL_FETCH_TIMEOUT_MS,
  GATEWAY_CREDENTIAL_TOKEN_HEADER,
  SIDECAR_BROKER_TOKEN_HEADER,
  gatewayCredentialHeaders,
  internalFetch,
  sidecarBrokerHeaders,
} from "./internal-fetch.js";

const hangingFetch: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason));
  });

const tempDirs: string[] = [];

async function tokenFile(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scripts-internal-fetch-"));
  tempDirs.push(dir);
  const file = path.join(dir, "token");
  await writeFile(file, body);
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("internalFetch", () => {
  it("materializes the separate gateway credential capability header", async () => {
    const headers = await gatewayCredentialHeaders(await tokenFile("credential-jwt\n"));
    expect(headers).toEqual({ [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt" });
  });

  it("fails closed when the gateway credential capability is unavailable", async () => {
    await expect(gatewayCredentialHeaders(path.join(os.tmpdir(), `missing-${Math.random()}`)))
      .rejects.toThrow("projected gateway credential token unavailable");
  });

  it("materializes the sidecar-only broker capability header", async () => {
    const headers = await sidecarBrokerHeaders(await tokenFile("sidecar-jwt\n"));
    expect(headers).toEqual({ [SIDECAR_BROKER_TOKEN_HEADER]: "sidecar-jwt" });
  });

  it("adds both internal key and projected service-account token headers", async () => {
    const seen: RequestInit[] = [];
    await internalFetch(
      "http://gateway-edge.local/api/model-credentials/subscription/auth-state",
      { method: "POST" },
      {
        internalServiceKey: "service-key",
        tokenPath: await tokenFile("projected-jwt\n"),
        fetchImpl: async (_url, init) => {
          seen.push(init ?? {});
          return new Response("ok");
        },
      },
    );

    const headers = new Headers(seen[0].headers);
    expect(headers.get("x-internal-service-key")).toBe("service-key");
    expect(headers.get("x-k8s-sa-token")).toBe("projected-jwt");
  });

  it("omits the service-account token header when the projected token is missing", async () => {
    const seen: RequestInit[] = [];
    await internalFetch(
      "http://gateway-edge.local/api/model-credentials/subscription/auth-state",
      {},
      {
        internalServiceKey: "service-key",
        tokenPath: path.join(os.tmpdir(), "missing-token-" + Math.random()),
        fetchImpl: async (_url, init) => {
          seen.push(init ?? {});
          return new Response("ok");
        },
      },
    );

    const headers = new Headers(seen[0].headers);
    expect(headers.get("x-internal-service-key")).toBe("service-key");
    expect(headers.get("x-k8s-sa-token")).toBeNull();
  });

  it("fails before fetch when a caller requires projected tenant identity but its token is absent", async () => {
    let called = false;

    await expect(internalFetch(
      "http://octogee-api/internal/automations/authorize",
      {},
      {
        requireProjectedToken: true,
        tokenPath: path.join(os.tmpdir(), "missing-token-" + Math.random()),
        fetchImpl: async () => {
          called = true;
          return new Response("ok");
        },
      },
    )).rejects.toThrow("projected service-account token unavailable");
    expect(called).toBe(false);
  });

  it("bounds a signal-less request and names the call when the timeout trips", async () => {
    const requested: number[] = [];
    const controller = new AbortController();

    const pending = internalFetch(
      "http://octogee-api.local/internal/gitea/user-pubkeys?slug=aug02",
      { method: "GET" },
      {
        tokenPath: await tokenFile("projected-jwt\n"),
        fetchImpl: hangingFetch,
        timeoutSignal: (ms) => {
          requested.push(ms);
          return controller.signal;
        },
      },
    );
    controller.abort(new Error("timed out"));

    await expect(pending).rejects.toThrow(
      /internal-fetch: GET http:\/\/octogee-api\.local\/internal\/gitea\/user-pubkeys\?slug=aug02 timed out after 60000ms/,
    );
    expect(requested).toEqual([DEFAULT_INTERNAL_FETCH_TIMEOUT_MS]);
  });

  it("leaves a caller-supplied signal in charge instead of imposing the default timeout", async () => {
    const requested: number[] = [];
    const caller = new AbortController();
    const seen: RequestInit[] = [];

    const pending = internalFetch(
      "http://octogee-api.local/api/project/publish",
      { method: "POST", signal: caller.signal },
      {
        tokenPath: await tokenFile("projected-jwt\n"),
        fetchImpl: (url, init) => {
          seen.push(init ?? {});
          return hangingFetch(url, init);
        },
        timeoutSignal: (ms) => {
          requested.push(ms);
          return new AbortController().signal;
        },
      },
    );
    caller.abort(new Error("caller gave up"));

    await expect(pending).rejects.toThrow(/caller gave up/);
    expect(requested).toEqual([]);
    expect(seen[0].signal).toBe(caller.signal);
  });

  it("composes an explicit timeout with a caller-supplied signal", async () => {
    const requested: number[] = [];
    const caller = new AbortController();
    const timeout = new AbortController();

    const pending = internalFetch(
      "http://octogee-api.local/internal/gitea/ensure-user",
      { method: "POST", signal: caller.signal },
      {
        tokenPath: await tokenFile("projected-jwt\n"),
        fetchImpl: hangingFetch,
        timeoutMs: 5_000,
        timeoutSignal: (ms) => {
          requested.push(ms);
          return timeout.signal;
        },
      },
    );
    timeout.abort(new Error("timed out"));

    await expect(pending).rejects.toThrow(
      /internal-fetch: POST http:\/\/octogee-api\.local\/internal\/gitea\/ensure-user timed out after 5000ms/,
    );
    expect(requested).toEqual([5_000]);
  });
});
