import { describe, expect, it } from "vitest";

import { summarizeToolArgs, summarizeToolOutput } from "./tool-format.js";

describe("summarizeToolArgs", () => {
  it("returns null for nullish args", () => {
    expect(summarizeToolArgs(null)).toBeNull();
    expect(summarizeToolArgs(undefined)).toBeNull();
  });

  it("uses a string arg verbatim (whitespace-collapsed)", () => {
    expect(summarizeToolArgs("git   status")).toBe("git status");
  });

  it("prefers the most meaningful field (command/path/pattern/url/query)", () => {
    expect(summarizeToolArgs({ command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolArgs({ file_path: "/src/x.ts" })).toBe("/src/x.ts");
    expect(summarizeToolArgs({ pattern: "foo.*bar" })).toBe("foo.*bar");
    expect(summarizeToolArgs({ url: "https://x.test" })).toBe("https://x.test");
  });

  it("falls back to compact JSON for unrecognized objects", () => {
    expect(summarizeToolArgs({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it("truncates long previews", () => {
    const out = summarizeToolArgs("x".repeat(500), 10);
    expect(out).toBe(`${"x".repeat(10)}…`);
  });

  it("redacts secrets in the preview", () => {
    const out = summarizeToolArgs('curl -H "Authorization: Bearer sk-abcdefgh1234567890"');
    expect(out).not.toContain("sk-abcdefgh1234567890");
  });
});

describe("summarizeToolOutput", () => {
  it("returns null for non-string / empty output", () => {
    expect(summarizeToolOutput(undefined)).toBeNull();
    expect(summarizeToolOutput("")).toBeNull();
    expect(summarizeToolOutput({ a: 1 })).toBeNull();
  });

  it("collapses + truncates output", () => {
    expect(summarizeToolOutput("on branch\n\nmain", 100)).toBe("on branch main");
    expect(summarizeToolOutput("y".repeat(500), 8)).toBe(`${"y".repeat(8)}…`);
  });
});
