import { describe, expect, it } from "vitest";

import { redactSecrets, redactStructuredSecrets } from "./secret-redaction.js";

describe("secret redaction", () => {
  it("redacts credential labels, auth headers, provider keys, and bare JWTs", () => {
    const input = [
      "api_key=private-value",
      "Authorization: Bearer abcdef0123456789ABCDEF",
      "Cookie: session=private-cookie",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1aWQifQ.abcdefghijklmnop",
    ].join("\n");

    const redacted = redactSecrets(input);
    expect(redacted).not.toContain("private-value");
    expect(redacted).not.toContain("abcdef0123456789ABCDEF");
    expect(redacted).not.toContain("private-cookie");
    expect(redacted).not.toContain("github_pat_");
    expect(redacted).not.toContain("eyJhbGci");
    expect(redacted.match(/\[redacted\]/g)).toHaveLength(5);
  });

  it("redacts a Set-Cookie header value", () => {
    expect(redactSecrets("Set-Cookie: sid=private-cookie; Path=/")).toBe(
      "Set-Cookie: [redacted]",
    );
  });

  it("redacts an Authorization Basic header value", () => {
    const out = redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(out).toBe("Authorization: Basic [redacted]");
  });

  it("redacts OpenAI-style keys, including sk-proj- and sk-ant- prefixes", () => {
    const out = redactSecrets("key: sk-ABCDEFGHIJKLMNOPQRSTUVWX0123456789");
    expect(out).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX0123456789");
    expect(out).toContain("[redacted]");

    expect(redactSecrets("sk-proj-ABCDEFGHIJKLMNOP0123")).toBe("[redacted]");
    expect(redactSecrets("sk-ant-api03-ABCDEFGHIJKLMNOP0123")).toBe("[redacted]");
  });

  it("redacts GitHub tokens (ghp_/gho_/github_pat_)", () => {
    expect(redactSecrets("gho_16C7e42F292c6912E7710c838347Ae178B4a")).toBe("[redacted]");
    expect(redactSecrets("ghp_16C7e42F292c6912E7710c838347Ae178B4a")).toBe("[redacted]");
    expect(redactSecrets("github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ012345")).toBe(
      "[redacted]",
    );
  });

  it("redacts AWS access key ids (AKIA and ASIA)", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[redacted]");
    expect(redactSecrets("ASIAIOSFODNN7EXAMPLE")).toBe("[redacted]");
  });

  it("redacts a Slack token", () => {
    expect(redactSecrets("xoxb-2345678901-ABCDEFGHIJKLMNOP")).toBe("[redacted]");
  });

  it("redacts a bare Bearer token but keeps the scheme word", () => {
    const out = redactSecrets("sent Bearer abcdef0123456789ABCDEF now");
    expect(out).toBe("sent Bearer [redacted] now");
  });

  it("redacts a PEM private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`prefix ${pem} suffix`)).toBe("prefix [redacted] suffix");
  });

  it("redacts long hex and mixed base64url token-like runs", () => {
    const hex = "a".repeat(40);
    expect(redactSecrets(`digest ${hex}`)).toBe("digest [redacted]");
    const mixed = `aB3${"x".repeat(40)}`;
    expect(redactSecrets(mixed)).toBe("[redacted]");
  });

  it("redacts a long run whole when a specific pattern also claims it", () => {
    const token = `aB3${"x".repeat(50)}`;
    expect(redactSecrets(`api_key=${token}`)).toBe("api_key=[redacted]");
    expect(redactSecrets(`Authorization: Bearer ${token}`)).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactSecrets(`Cookie: session=${token}`)).toBe("Cookie: [redacted]");
    expect(redactSecrets(`sk-ant-${token}`)).toBe("[redacted]");
    expect(redactSecrets(`xoxb-${token}`)).toBe("[redacted]");
  });

  it("leaves ordinary prose and long single-character runs untouched", () => {
    expect(redactSecrets("The quick brown fox jumps over the lazy dog.")).toBe(
      "The quick brown fox jumps over the lazy dog.",
    );
    const plain = "x".repeat(80);
    expect(redactSecrets(plain)).toBe(plain);
  });

  it("is a no-op on empty input", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("redacts credential-shaped fields recursively even when values are short", () => {
    expect(redactStructuredSecrets({
      event: "connector_failed",
      accessToken: "tiny",
      nested: [{ refresh_token: "also-tiny", status: "failed" }],
    })).toEqual({
      event: "connector_failed",
      accessToken: "[redacted]",
      nested: [{ refresh_token: "[redacted]", status: "failed" }],
    });
  });
});
