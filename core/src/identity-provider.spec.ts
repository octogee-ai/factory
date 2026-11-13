import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  combineIdentityProviders,
  createGoogleIdentityProvider,
  createOperatorKeyIdentityProvider,
  googleIdentityFromEnvironment,
  operatorKeyIdentityFromEnvironment,
  type IdentityProvider,
} from "./identity-provider.js";
import { signOperatorToken } from "./operator-token.js";

function bearerFrom(claims: unknown): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function provider(issuer: string, ownerId: string): IdentityProvider {
  return { issuers: [issuer], verifyBearer: vi.fn(async () => ({ ownerId, email: null, operator: false })) };
}

describe("combining identity providers", () => {
  it("hands a bearer to the provider that trusts its issuer", async () => {
    const google = provider("https://accounts.google.com", "from-google");
    const firebase = provider("https://securetoken.google.com/demo", "from-firebase");
    const identity = await combineIdentityProviders([google, firebase]).verifyBearer(bearerFrom({ iss: "https://securetoken.google.com/demo" }));
    expect(identity.ownerId).toBe("from-firebase");
    expect(google.verifyBearer).not.toHaveBeenCalled();
  });

  it.each([
    ["an issuer no provider trusts", bearerFrom({ iss: "https://evil.example" }), "not trusted"],
    ["a bearer naming no issuer", bearerFrom({ sub: "ada" }), "names no issuer"],
    ["a bearer that is not a JWT", "opaque", "not a JWT"],
  ])("refuses %s", async (_name, bearer, message) => {
    const only = provider("https://accounts.google.com", "ada");
    await expect(combineIdentityProviders([only]).verifyBearer(bearer)).rejects.toThrow(message);
    expect(only.verifyBearer).not.toHaveBeenCalled();
  });

  it("refuses to run with no provider at all", () => {
    expect(() => combineIdentityProviders([])).toThrow("no identity provider");
  });
});

describe("Google sign-in", () => {
  function google(claims: Record<string, unknown> | undefined) {
    const verify = vi.fn(async () => claims);
    return { verify, identity: createGoogleIdentityProvider({ audience: "client-id", operatorEmails: ["Ada@Example.com"], verify }) };
  }

  it("grants the operator role to a listed verified email, whatever its case", async () => {
    const { identity, verify } = google({ email: "ADA@example.com", email_verified: true });
    await expect(identity.verifyBearer("token")).resolves.toEqual({ ownerId: "ada@example.com", email: "ada@example.com", operator: true });
    expect(verify).toHaveBeenCalledWith("token", "client-id");
  });

  it("does not grant the operator role to an email that is not listed", async () => {
    const { identity } = google({ email: "grace@example.com", email_verified: true });
    await expect(identity.verifyBearer("token")).resolves.toMatchObject({ operator: false });
  });

  it.each([
    ["unverified", { email: "ada@example.com", email_verified: false }],
    ["missing", { sub: "123" }],
    ["absent from an empty payload", undefined],
  ])("refuses a token whose email is %s", async (_name, claims) => {
    await expect(google(claims).identity.verifyBearer("token")).rejects.toThrow("no verified email");
  });

  it("lets a rejected signature surface", async () => {
    const verify = vi.fn(async () => { throw new Error("Wrong recipient"); });
    const identity = createGoogleIdentityProvider({ audience: "client-id", operatorEmails: ["ada@example.com"], verify });
    await expect(identity.verifyBearer("token")).rejects.toThrow("Wrong recipient");
  });
});

describe("Google sign-in settings", () => {
  it("is absent when neither setting is present", () => {
    expect(googleIdentityFromEnvironment({})).toBeNull();
  });

  it("reads the client and a comma-separated operator list", () => {
    expect(googleIdentityFromEnvironment({ FLEET_GOOGLE_CLIENT_ID: "client", FLEET_OPERATOR_EMAILS: "ada@example.com, grace@example.com" })?.issuers)
      .toContain("https://accounts.google.com");
  });

  it.each([
    [{ FLEET_GOOGLE_CLIENT_ID: "client" }, "without FLEET_OPERATOR_EMAILS"],
    [{ FLEET_OPERATOR_EMAILS: "ada@example.com" }, "without FLEET_GOOGLE_CLIENT_ID"],
  ])("refuses half a configuration %j", (env, message) => {
    expect(() => googleIdentityFromEnvironment(env)).toThrow(message);
  });
});

describe("operator key sign-in", () => {
  const pem = (key: { export(options: { type: "spki" | "pkcs8"; format: "pem" }): string | Buffer }, type: "spki" | "pkcs8") =>
    key.export({ type, format: "pem" }).toString();
  function keys() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return { publicKey: pem(publicKey, "spki"), privateKey: pem(privateKey, "pkcs8") };
  }
  const now = 1_800_000_000_000;
  const operator = keys();
  const identity = createOperatorKeyIdentityProvider({ publicKey: operator.publicKey, now: () => now });
  const sign = (overrides: Partial<Parameters<typeof signOperatorToken>[0]> = {}) =>
    signOperatorToken({ privateKey: operator.privateKey, subject: "ada", now: () => now, ...overrides });

  function tamper(token: string, claims: Record<string, unknown>): string {
    const [header, payload, signature] = token.split(".");
    const original = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    return `${header}.${Buffer.from(JSON.stringify({ ...original, ...claims })).toString("base64url")}.${signature}`;
  }

  it("grants the operator role to a token signed by the operator key", async () => {
    await expect(identity.verifyBearer(sign())).resolves.toEqual({ ownerId: "operator:ada", email: null, operator: true });
  });

  it("is reached through the combined providers by its issuer", async () => {
    await expect(combineIdentityProviders([provider("https://accounts.google.com", "x"), identity]).verifyBearer(sign()))
      .resolves.toMatchObject({ operator: true });
  });

  it.each([
    ["signed by another key", () => sign({ privateKey: keys().privateKey }), "signature"],
    ["with altered claims", () => tamper(sign(), { sub: "eve" }), "signature"],
    ["that has expired", () => sign({ now: () => now - 3_600_000 }), "expired"],
    ["that lives longer than an hour", () => sign({ lifetimeSeconds: 7200 }), "longer than an hour"],
    ["that is not a JWT", () => "opaque", "not a JWT"],
  ])("refuses a token %s", async (_name, token, message) => {
    await expect(identity.verifyBearer(token())).rejects.toThrow(message);
  });

  it("refuses to sign a token that names no operator", () => {
    expect(() => sign({ subject: "" })).toThrow("names no operator");
  });

  it("refuses a public key that is not Ed25519", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => createOperatorKeyIdentityProvider({ publicKey: pem(publicKey, "spki") })).toThrow("Ed25519");
  });

  it("is configured by FLEET_OPERATOR_PUBLIC_KEY and absent without it", () => {
    expect(operatorKeyIdentityFromEnvironment({})).toBeNull();
    expect(operatorKeyIdentityFromEnvironment({ FLEET_OPERATOR_PUBLIC_KEY: operator.publicKey })?.issuers).toEqual(["octogee-operator-key"]);
  });
});
