import { describe, expect, it } from "vitest";

import { isBrokeredWritablePath } from "../routes/workspace/helpers.js";
import { validatedSaveRequest } from "../routes/workspace/save.js";

describe("workspace save helpers", () => {
  it("validates text save requests while preserving empty string content", () => {
    expect(validatedSaveRequest({ path: "notes/empty.md", content: "" })).toEqual({
      ok: true,
      path: "notes/empty.md",
      content: "",
    });
  });

  it("rejects missing fields, unsafe paths, non-text files, and oversized content", () => {
    expect(validatedSaveRequest(undefined)).toEqual({
      ok: false,
      status: 400,
      error: "Missing path",
    });
    expect(validatedSaveRequest({ content: "x" })).toEqual({
      ok: false,
      status: 400,
      error: "Missing path",
    });
    expect(validatedSaveRequest({ path: "notes/x.md" })).toEqual({
      ok: false,
      status: 400,
      error: "Missing content",
    });
    expect(validatedSaveRequest({ path: "../x.md", content: "x" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(validatedSaveRequest({ path: "notes/pic.png", content: "x" })).toEqual({
      ok: false,
      status: 400,
      error: "Only text files can be saved",
      code: "NOT_TEXT",
    });
    expect(validatedSaveRequest({ path: "notes/huge.md", content: "x".repeat(1024 * 1024 + 1) })).toEqual({
      ok: false,
      status: 413,
      error: "Content too large",
      code: "TOO_LARGE",
    });
  });

  it("accepts the Canvas dashboard document as the only writable hidden path", () => {
    expect(validatedSaveRequest({ path: ".octogee/canvas.json", content: "{}" })).toEqual({
      ok: true,
      path: ".octogee/canvas.json",
      content: "{}",
    });
    expect(isBrokeredWritablePath(".octogee/canvas.json", "README.md")).toBe(true);
    expect(isBrokeredWritablePath(".octogee/other.json", "README.md")).toBe(false);
  });
});
