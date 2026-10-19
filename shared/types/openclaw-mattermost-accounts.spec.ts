import { describe, expect, it } from "vitest";
import {
  PLATFORM_MATTERMOST_BASE_URL,
  mattermostAccountEndpointsForTarget,
} from "./openclaw-mattermost-accounts.js";

const MM_URL = "http://mattermost.octogee-test.svc.cluster.local:8065";
const account = { botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-coach" }, dmPolicy: "disabled" };
const currentWith = (baseUrl?: string) => ({
  channels: { mattermost: { accounts: { "alice-coach": { ...account, ...(baseUrl === undefined ? {} : { baseUrl }) } } } },
});

describe("mattermostAccountEndpointsForTarget", () => {
  it("keeps the gateway's current platform URL when it already resolves the ${MM_URL} placeholder", () => {
    const result = mattermostAccountEndpointsForTarget(currentWith(MM_URL), { "alice-coach": account }, true, { MM_URL });
    expect(result["alice-coach"]).toEqual({ ...account, baseUrl: MM_URL });
  });

  it("writes the placeholder when the current account points elsewhere", () => {
    const result = mattermostAccountEndpointsForTarget(currentWith("https://owner.example"), { "alice-coach": account }, true, { MM_URL });
    expect(result["alice-coach"]).toEqual({ ...account, baseUrl: PLATFORM_MATTERMOST_BASE_URL });
  });

  it("writes the placeholder when the account is new or the platform URL is unknown", () => {
    expect(mattermostAccountEndpointsForTarget(currentWith(), { "alice-coach": account }, true, { MM_URL })["alice-coach"])
      .toEqual({ ...account, baseUrl: PLATFORM_MATTERMOST_BASE_URL });
    expect(mattermostAccountEndpointsForTarget(currentWith(MM_URL), { "alice-coach": account }, true, {})["alice-coach"])
      .toEqual({ ...account, baseUrl: PLATFORM_MATTERMOST_BASE_URL });
    expect(mattermostAccountEndpointsForTarget(currentWith(MM_URL), { "alice-coach": account }, true, { MM_URL: "" })["alice-coach"])
      .toEqual({ ...account, baseUrl: PLATFORM_MATTERMOST_BASE_URL });
  });

  it("leaves Builder-owned endpoints to the current config or the submitted account", () => {
    expect(mattermostAccountEndpointsForTarget(currentWith("https://owner.example"), { "alice-coach": account }, false, { MM_URL })["alice-coach"])
      .toEqual({ ...account, baseUrl: "https://owner.example" });
    expect(mattermostAccountEndpointsForTarget(currentWith(), { "alice-coach": { ...account, baseUrl: "https://submitted.example" } }, false, { MM_URL })["alice-coach"])
      .toEqual({ ...account, baseUrl: "https://submitted.example" });
  });
});
