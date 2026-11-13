import { describe, expect, it } from "vitest";
import {
  computeTestedModules,
  parseImportSpecifiers,
  resolveSpecifier,
} from "../lib/coverage-audit.js";

describe("coverage audit import parsing", () => {
  it("captures dynamic imports whose specifier is extended by a cache-busting expression", () => {
    expect(
      parseImportSpecifiers('return await import("../lib/wsLog.ts?t=" + Date.now());'),
    ).toEqual(["../lib/wsLog.ts?t="]);
  });

  it("resolves Vite query and hash specifiers back to the source module key", () => {
    expect(resolveSpecifier("../lib/wsLog.ts?t=123", "app/src/__tests__/wsLog.spec.ts")).toBe(
      "app/src/lib/wsLog",
    );
    expect(resolveSpecifier("@/lib/wsLog.ts?raw#dev", "app/src/__tests__/wsLog.spec.ts")).toBe(
      "app/src/lib/wsLog",
    );
  });

  it("counts a queried dynamic import as direct coverage for the source module", () => {
    const counts = computeTestedModules(
      [
        {
          path: "app/src/__tests__/wsLog.spec.ts",
          content: 'async function fresh() { return import("../lib/wsLog.ts?t=" + Date.now()); }',
        },
      ],
      ["app/src/lib/wsLog.ts"],
    );

    expect(counts.get("app/src/lib/wsLog.ts")).toBe(1);
  });
});
