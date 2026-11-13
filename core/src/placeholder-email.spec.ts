import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PLACEHOLDER_EMAIL_DOMAIN,
  installPlaceholderEmailDomain,
  isPlaceholderEmail,
  placeholderEmail,
} from "./placeholder-email.js";

afterEach(() => installPlaceholderEmailDomain(DEFAULT_PLACEHOLDER_EMAIL_DOMAIN));

describe("placeholder email", () => {
  it("addresses an account with no email at a reserved domain by default", () => {
    expect(placeholderEmail("acme")).toBe("acme@users.invalid");
    expect(isPlaceholderEmail("acme@users.invalid")).toBe(true);
  });

  it("addresses it at the domain the composition root installs", () => {
    installPlaceholderEmailDomain("accounts.example");
    expect(placeholderEmail("acme")).toBe("acme@accounts.example");
    expect(isPlaceholderEmail("acme@accounts.example")).toBe(true);
    expect(isPlaceholderEmail("acme@users.invalid")).toBe(false);
  });

  it.each(["ada@example.com", "ada@notusers.invalid", "ada@users.invalid.example.com"])("does not take %s for a placeholder", email => {
    expect(isPlaceholderEmail(email)).toBe(false);
  });

  it.each(["", "@users.invalid", "users", "Users.Invalid", "users..invalid", "-users.invalid"])("refuses to install %j as a domain", domain => {
    expect(() => installPlaceholderEmailDomain(domain)).toThrow("placeholder email domain");
  });
});
