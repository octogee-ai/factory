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
