import { describe, it, expect } from "vitest";
import { signFleetRequest } from "../lib/fleet-signature";
import {
  SIGNATURE_HEADER,
  MIGRATION_ID_HEADER,
  MIGRATION_SLUG_HEADER,
} from "../../shared/types/fleet-controller";
import { createMigrationClient } from "../lib/fleet-migration-client";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function captureFetch(handler: (call: CapturedCall) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    }
    let body: string | null = null;
    if (typeof init?.body === "string") body = init.body;
    const call: CapturedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fakeFetch };
}

const SECRET = "test-secret";

describe("MigrationClient.quiesce", () => {
  it("POSTs JSON to /quiesce/{gatewayId} signed with HMAC over `${migrationId}\\n${rawBody}`", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      secret: SECRET,
      resolveGatewayUrl: () => `https://fleet-test.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.quiesce({
      migrationId: "m1",
      gatewayId: "gw-source",
      slug: "alice",
      timeoutMs: 30_000,
    });
    expect(res).toMatchObject({ migrationId: "m1", slug: "alice", drained: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://fleet-test.example.com/quiesce/gw-source");
    expect(calls[0].method).toBe("POST");
    const expectedSig = signFleetRequest(SECRET, "m1", calls[0].body!);
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expectedSig);
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({ migrationId: "m1", slug: "alice", timeoutMs: 30_000 });
  });

  it("throws on non-2xx response with the gateway's error body in the message", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 }),
    );
    const client = createMigrationClient({
      secret: SECRET,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    await expect(
      client.quiesce({ migrationId: "m1", gatewayId: "gw", slug: "alice" }),
    ).rejects.toThrow(/quiesce.*401.*invalid signature/i);
  });

  it("throws when the gateway returns drained=false with a runningCount", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", drained: false, runningCount: 2 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      secret: SECRET,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    await expect(
      client.quiesce({ migrationId: "m1", gatewayId: "gw", slug: "alice" }),
    ).rejects.toThrow(/did not drain.*2 still running/i);
  });
});

describe("MigrationClient.unmount", () => {
  it("POSTs JSON to /unmount/{gatewayId} signed identically to quiesce", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", unmounted: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      secret: SECRET,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.unmount({ migrationId: "m1", gatewayId: "gw-source", slug: "alice" });
    expect(res.unmounted).toBe(true);
    expect(calls[0].url).toBe("https://fleet.example.com/unmount/gw-source");
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({ migrationId: "m1", slug: "alice" });
    const expectedSig = signFleetRequest(SECRET, "m1", calls[0].body!);
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expectedSig);
  });

  it("treats unmounted=false as success (idempotent — already gone)", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", unmounted: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      secret: SECRET,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.unmount({ migrationId: "m1", gatewayId: "gw-source", slug: "alice" });
    expect(res.unmounted).toBe(false); // not an error — caller can decide
  });
});

describe("MigrationClient.transferState", () => {
  it("pipes the export response body into the import request body and returns the import response", async () => {
    const tarBytes = new Uint8Array([0x74, 0x65, 0x73, 0x74]); // "test"
    const exportResponse = new Response(tarBytes, {
      status: 200,
      headers: { "content-type": "application/x-tar" },
    });
    const importResponse = new Response(
      JSON.stringify({ migrationId: "m1", slug: "alice", imported: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    let exportCallSeen = false;
    let importCallSeen = false;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/export/")) {
        exportCallSeen = true;
        return exportResponse;
      }
      if (url.includes("/import/")) {
        importCallSeen = true;
        const headers: Record<string, string> = {};
        if (init?.headers) {
          const h = init.headers as Record<string, string>;
          for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
        }
        // Verify HMAC over `${migrationId}\n${slug}` per the import contract
        const expectedSig = signFleetRequest(SECRET, "m1", "alice");
        expect(headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expectedSig);
        expect(headers[MIGRATION_ID_HEADER.toLowerCase()]).toBe("m1");
        expect(headers[MIGRATION_SLUG_HEADER.toLowerCase()]).toBe("alice");
        return importResponse;
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const client = createMigrationClient({
      secret: SECRET,
      resolveGatewayUrl: (id) =>
        id === "gw-from" ? "https://fleet-from.example.com" : "https://fleet-to.example.com",
      fetch: fakeFetch,
    });
    const res = await client.transferState({
      migrationId: "m1",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
    });
    expect(exportCallSeen).toBe(true);
    expect(importCallSeen).toBe(true);
    expect(res.imported).toBe(true);
  });

  it("throws if export returns non-2xx (no import attempt)", async () => {
    let importCalls = 0;
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/export/")) {
        return new Response("upstream gateway is draining", { status: 503 });
      }
      if (url.includes("/import/")) {
        importCalls++;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const client = createMigrationClient({
      secret: SECRET,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    await expect(
      client.transferState({
        migrationId: "m1",
        fromGatewayId: "gw-from",
        toGatewayId: "gw-to",
        slug: "alice",
      }),
    ).rejects.toThrow(/export.*503/i);
    expect(importCalls).toBe(0);
  });
});
