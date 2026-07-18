import { describe, expect, it, vi } from "vitest";

import {
  revokeAllConnectorGrantsForUser,
  revokeProviderGrant,
  type ConnectorRevocationDeps,
  type ConnectorRevocationTarget,
} from "./connector-revocation.js";

const google: ConnectorRevocationTarget = {
  connectorId: "google",
  revocationUrl: "https://oauth2.googleapis.com/revoke",
};

function depsFor(
  secrets: Record<string, unknown>,
  fetchImpl: NonNullable<ConnectorRevocationDeps["fetchImpl"]>,
) {
  const warnings: string[] = [];
  return {
    warnings,
    db: {
      collection: () => ({
        doc: (uid: string) => ({
          collection: () => ({
            doc: (connectorId: string) => ({
              get: async () => ({ data: () => secrets[`${uid}/${connectorId}`] }),
            }),
          }),
        }),
      }),
    } as unknown as ConnectorRevocationDeps["db"],
    decryptSecret: async (ciphertext: string) => ciphertext.replace("enc:", "plain:"),
    logger: { warn: (message: string) => warnings.push(message) },
    fetchImpl,
  } satisfies ConnectorRevocationDeps & { warnings: string[] };
}

describe("revokeProviderGrant", () => {
  it("revokes one refresh token and does not make a second request with the access token", async () => {
    const posted: string[] = [];
    const deps = depsFor(
      {
        "u1/google": {
          tokens: {
            encryptedRefreshToken: "enc:refresh",
            encryptedAccessToken: "enc:access",
          },
        },
      },
      vi.fn(async (_url, init) => {
        posted.push(new URLSearchParams(init?.body as string).get("token") ?? "");
        return { ok: true, status: 200 } as Response;
      }),
    );

    await revokeProviderGrant("u1", google, deps);

    expect(posted).toEqual(["plain:refresh"]);
    expect(deps.warnings).toEqual([]);
  });

  it("falls back to the access token when no refresh token is stored", async () => {
    const posted: string[] = [];
    const deps = depsFor(
      { "u1/google": { tokens: { encryptedAccessToken: "enc:access" } } },
      vi.fn(async (_url, init) => {
        posted.push(new URLSearchParams(init?.body as string).get("token") ?? "");
        return { ok: true, status: 200 } as Response;
      }),
    );

    await revokeProviderGrant("u1", google, deps);

    expect(posted).toEqual(["plain:access"]);
  });

  it("adds a deadline to the provider request", async () => {
    let signal: AbortSignal | null | undefined;
    const deps = depsFor(
      { "u1/google": { tokens: { encryptedRefreshToken: "enc:refresh" } } },
      vi.fn(async (_url, init) => {
        signal = init?.signal;
        return { ok: true, status: 200 } as Response;
      }),
    );

    await revokeProviderGrant("u1", google, deps);

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("logs and resolves when reading the stored grant fails", async () => {
    const warnings: string[] = [];
    const deps = {
      db: {
        collection: () => ({
          doc: () => ({
            collection: () => ({
              doc: () => ({ get: async () => { throw new Error("firestore unavailable"); } }),
            }),
          }),
        }),
      } as unknown as ConnectorRevocationDeps["db"],
      decryptSecret: vi.fn(async () => "plain"),
      logger: { warn: (message: string) => warnings.push(message) },
      fetchImpl: vi.fn(async () => ({ ok: true, status: 200 }) as Response),
    } satisfies ConnectorRevocationDeps;

    await expect(revokeProviderGrant("u1", google, deps)).resolves.toBeUndefined();

    expect(warnings.join(" ")).toContain("firestore unavailable");
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("logs provider failures without throwing", async () => {
    const deps = depsFor(
      { "u1/google": { tokens: { encryptedRefreshToken: "enc:refresh" } } },
      vi.fn(async () => ({ ok: false, status: 400 }) as Response),
    );

    await expect(revokeProviderGrant("u1", google, deps)).resolves.toBeUndefined();

    expect(deps.warnings.join(" ")).toContain("returned 400");
  });
});

describe("revokeAllConnectorGrantsForUser", () => {
  it("continues to later providers after one grant cannot be read", async () => {
    const posted: string[] = [];
    const warnings: string[] = [];
    const deps = {
      db: {
        collection: () => ({
          doc: () => ({
            collection: () => ({
              doc: (connectorId: string) => ({
                get: async () => {
                  if (connectorId === "google") throw new Error("google read failed");
                  return { data: () => ({ tokens: { encryptedRefreshToken: "enc:microsoft" } }) };
                },
              }),
            }),
          }),
        }),
      } as unknown as ConnectorRevocationDeps["db"],
      decryptSecret: async (ciphertext: string) => ciphertext.replace("enc:", "plain:"),
      logger: { warn: (message: string) => warnings.push(message) },
      fetchImpl: vi.fn(async (url: string | URL | Request) => {
        posted.push(String(url));
        return { ok: true, status: 200 } as Response;
      }),
    } satisfies ConnectorRevocationDeps;

    await revokeAllConnectorGrantsForUser(
      "u1",
      [google, { connectorId: "microsoft", revocationUrl: "https://login.example/revoke" }],
      deps,
    );

    expect(posted).toEqual(["https://login.example/revoke"]);
    expect(warnings.join(" ")).toContain("google read failed");
  });
});
