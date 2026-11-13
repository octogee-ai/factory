import { describe, expect, it } from "vitest";
import { IANA_TIME_ZONE_PATTERN, parseTimeZone } from "./time-zone.js";

describe("parseTimeZone", () => {
  it("accepts IANA zones the runtime knows, as the browser reports them", () => {
    for (const zone of ["America/Chicago", "Europe/Berlin", "America/Argentina/Buenos_Aires", "Etc/GMT+3", "UTC", "Pacific/Auckland"]) {
      expect(parseTimeZone(zone), zone).toBe(zone);
    }
  });

  it("refuses non-strings, unknown zones, shell or path characters and oversized values", () => {
    for (const bad of [undefined, null, 7, "", "Mars/Olympus", "America/Chicago; rm -rf /", "../etc/passwd", "/usr/share/zoneinfo/UTC", "America Chicago", "a".repeat(65)]) {
      expect(parseTimeZone(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("publishes the same pattern Firestore rules enforce", () => {
    const re = new RegExp(IANA_TIME_ZONE_PATTERN, "u");
    expect(re.test("America/Chicago")).toBe(true);
    expect(re.test("../x")).toBe(false);
    expect(re.test("a b")).toBe(false);
  });
});
