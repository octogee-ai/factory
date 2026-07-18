import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  GOOGLE_CAPABILITY_SCOPES,
  GOOGLE_DRIVE_FULL_READ_SCOPE,
  GOOGLE_IDENTITY_SCOPE,
  GOOGLE_SCOPES,
  googleAuthRequestScopes,
  googleCapabilitiesFromScopes,
  type GoogleCapability,
} from "./connectors.js";

describe("google capability bundles", () => {
  it("maps each capability card to its single data scope", () => {
    expect(GOOGLE_CAPABILITY_SCOPES).toEqual({
      calendar: ["https://www.googleapis.com/auth/calendar.events"],
      gmail: ["https://www.googleapis.com/auth/gmail.modify"],
      drive: ["https://www.googleapis.com/auth/drive.file"],
    });
  });

  it("keeps identity separate so bundles stay pure data scopes", () => {
    expect(GOOGLE_IDENTITY_SCOPE).toBe("https://www.googleapis.com/auth/userinfo.email");
    for (const scopes of Object.values(GOOGLE_CAPABILITY_SCOPES)) {
      expect(scopes).not.toContain(GOOGLE_IDENTITY_SCOPE);
    }
  });

  it("auth requests add the identity scope to the capability bundle", () => {
    expect(googleAuthRequestScopes("gmail")).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      GOOGLE_IDENTITY_SCOPE,
    ]);
  });

  it("drive full read is declared for verification but part of no default bundle", () => {
    expect(GOOGLE_DRIVE_FULL_READ_SCOPE).toBe("https://www.googleapis.com/auth/drive.readonly");
    for (const cap of Object.keys(GOOGLE_CAPABILITY_SCOPES) as GoogleCapability[]) {
      expect(googleAuthRequestScopes(cap)).not.toContain(GOOGLE_DRIVE_FULL_READ_SCOPE);
    }
  });

  it("GOOGLE_SCOPES is the default-requestable union", () => {
    expect(GOOGLE_SCOPES).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/drive.file",
      GOOGLE_IDENTITY_SCOPE,
    ]);
  });
});

describe("googleCapabilitiesFromScopes", () => {
  it("derives a capability from its granted data scope", () => {
    expect(
      googleCapabilitiesFromScopes([
        "https://www.googleapis.com/auth/gmail.modify",
        GOOGLE_IDENTITY_SCOPE,
      ]),
    ).toEqual(["gmail"]);
  });

  it("granular consent unticking a data scope drops that capability", () => {
    expect(
      googleCapabilitiesFromScopes([
        GOOGLE_IDENTITY_SCOPE,
        "https://www.googleapis.com/auth/calendar.events",
      ]),
    ).toEqual(["calendar"]);
  });

  it("ignores unknown scopes and handles missing input", () => {
    expect(googleCapabilitiesFromScopes(["openid", GOOGLE_DRIVE_FULL_READ_SCOPE])).toEqual([]);
    expect(googleCapabilitiesFromScopes(undefined)).toEqual([]);
    expect(googleCapabilitiesFromScopes(null)).toEqual([]);
  });

  it("orders capabilities stably: calendar, gmail, drive", () => {
    expect(
      googleCapabilitiesFromScopes([
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar.events",
      ]),
    ).toEqual(["calendar", "gmail", "drive"]);
  });
});

describe("google catalog entry — platform client", () => {
  const google = CONNECTOR_CATALOG.find((m) => m.id === "google")!;

  it("is oauth-web only, agent-runtime, implemented, requesting the default union", () => {
    expect(google.captureMethods).toEqual(["oauth-web"]);
    expect(google.consumption).toBe("agent-runtime");
    expect(google.implemented).toBe(true);
    expect(google.scopes).toEqual(GOOGLE_SCOPES);
  });

  it("the per-user client concept is gone from the catalog shape", () => {
    // @ts-expect-error clientSource was removed with the BYO-client path
    expect(google.clientSource).toBeUndefined();
    // @ts-expect-error platformScopes was removed with the BYO-client path
    expect(google.platformScopes).toBeUndefined();
  });
});
