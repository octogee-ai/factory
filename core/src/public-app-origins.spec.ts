import { describe, expect, it } from "vitest";
import { parsePublicAppOrigins, publicAppHostsFromEnv, publicAppOriginsFromEnv } from "./public-app-origins.js";

describe("public app origins", () => {
  it("accepts comma or whitespace separated bare https origins and drops duplicates", () => {
    expect(parsePublicAppOrigins("https://app.example.com, https://example.com\nhttps://app.example.com"))
      .toEqual(["https://app.example.com", "https://example.com"]);
  });

  it("accepts bare HTTP origins on localhost", () => {
    expect(parsePublicAppOrigins("http://localhost:4322, https://example.com"))
      .toEqual(["http://localhost:4322", "https://example.com"]);
  });

  it.each([undefined, "", " , "])("fails loud when nothing is configured: %j", (raw) => {
    expect(() => parsePublicAppOrigins(raw)).toThrow(/PUBLIC_APP_ORIGINS must list at least one https origin/);
  });

  it.each([
    "http://app.example.com",
    "http://127.0.0.1:4322",
    "http://localhost.example.com",
    "http://localhost:4322/",
    "http://user@localhost:4322",
    "https://app.example.com/",
    "https://app.example.com/path",
    "app.example.com",
  ])("rejects anything that is not a bare https origin: %s", (entry) => {
    expect(() => parsePublicAppOrigins(entry)).toThrow(/PUBLIC_APP_ORIGINS entry/);
  });

  it("reads origins and hosts from the environment", () => {
    const env = { PUBLIC_APP_ORIGINS: "https://app.example.com,https://example.com" };
    expect(publicAppOriginsFromEnv(env)).toEqual(["https://app.example.com", "https://example.com"]);
    expect(publicAppHostsFromEnv(env)).toEqual(["app.example.com", "example.com"]);
    expect(() => publicAppOriginsFromEnv({})).toThrow(/PUBLIC_APP_ORIGINS/);
  });
});
