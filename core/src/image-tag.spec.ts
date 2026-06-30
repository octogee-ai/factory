import { describe, expect, it } from "vitest";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";

describe("IMAGE_TAG_PATTERN", () => {
  it("accepts sha tags and octogee capability suffixes", () => {
    expect(IMAGE_TAG_PATTERN.test("60535e46")).toBe(true);
    expect(IMAGE_TAG_PATTERN.test("60535e46-ocgw1.2")).toBe(true);
  });

  it("rejects mutable or malformed image tags", () => {
    expect(IMAGE_TAG_PATTERN.test("latest")).toBe(false);
    expect(IMAGE_TAG_PATTERN.test("60535e46_OC")).toBe(false);
  });
});
