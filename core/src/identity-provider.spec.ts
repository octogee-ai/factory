import { describe, expect, it, vi } from "vitest";
import {
  combineIdentityProviders,
  createGoogleIdentityProvider,
  googleIdentityFromEnvironment,
  type IdentityProvider,
} from "./identity-provider.js";

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
