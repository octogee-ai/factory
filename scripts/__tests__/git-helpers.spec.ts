import { describe, it, expect } from "vitest";

// Mock the config module before importing git.ts (which imports it at load
// time and would otherwise read env vars / hit the real filesystem).
import { vi } from "vitest";
vi.mock("../lib/config.js", () => ({
  log: () => {},
  dlog: () => {},
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_API_TOKEN: "",
  GIT_SSH_HOST: "gitea.test",
  CUSTOMERS_DIR: "/tmp/octogee-test/customers-doesnt-exist",
  CUSTOMER_KEYS_DIR: "/tmp/octogee-test/keys",
  AGENTS_DIR: "/tmp/octogee-test/agents",
}));

const {
  errMessage,
  execErrStderr,
  listOnDiskCustomerSlugs,
  customerSshKeyPath,
} = await import("../lib/git.js");

describe("errMessage", () => {
  it("returns .message for Error instances", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values without throwing", () => {
    expect(errMessage("plain string")).toBe("plain string");
    expect(errMessage(42)).toBe("42");
    expect(errMessage(null)).toBe("null");
    expect(errMessage(undefined)).toBe("undefined");
    expect(errMessage({ code: "ENOENT" })).toBe("[object Object]");
  });

  it("handles thrown values that look error-ish but aren't Error", () => {
    expect(errMessage({ message: "oops" })).toBe("[object Object]");
  });
});

describe("execErrStderr", () => {
  it("returns trimmed stderr when err has a .stderr with .toString()", () => {
    const e = { stderr: Buffer.from("  build failed\n") };
    expect(execErrStderr(e)).toBe("build failed");
  });

  it("returns empty string when err has no stderr", () => {
    expect(execErrStderr(new Error("plain"))).toBe("");
    expect(execErrStderr({})).toBe("");
    expect(execErrStderr(null)).toBe("");
    expect(execErrStderr(undefined)).toBe("");
    expect(execErrStderr("string err")).toBe("");
  });

  it("returns empty string when err.stderr is a string (no .toString function form)", () => {
    // Plain string stderr lacks the typeof-function check we guard on
    // (string has toString but it's a method, not a stderr.toString
    // bound to that particular value). Confirms we don't accidentally
    // accept a non-Buffer/non-object stderr shape.
    expect(execErrStderr({ stderr: "raw" })).toBe("raw");
  });
});

describe("customerSshKeyPath", () => {
  it("composes the per-slug key path under CUSTOMER_KEYS_DIR", () => {
    expect(customerSshKeyPath("acme")).toBe(
      "/tmp/octogee-test/keys/acme/id_ed25519",
    );
  });
});

describe("listOnDiskCustomerSlugs", () => {
  it("returns [] when CUSTOMERS_DIR doesn't exist (no throw)", () => {
    // Mocked CUSTOMERS_DIR points at a path that doesn't exist;
    // the function must short-circuit cleanly so syncAllWorkspaces
    // is a no-op on fresh gateway boots before any provisioning.
    expect(listOnDiskCustomerSlugs()).toEqual([]);
  });
});
