import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../gateway-edge/src/lib/platform-state.js", async (importOriginal) => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return {
    ...(await importOriginal<typeof import("../../../gateway-edge/src/lib/platform-state.js")>()),
    platformStateStore: createDocumentFixtureStore(new Map()),
  };
});

function firebaseAppsSeenFrom(...modules: URL[]): unknown[] {
  return modules.flatMap((module) =>
    (createRequire(module)("firebase-admin/app") as typeof import("firebase-admin/app")).getApps());
}

describe("platform app without Firebase", () => {
  it("creates no Firebase app when the platform app is imported and built", async () => {
    vi.doUnmock("../../../gateway-edge/src/lib/db");
    const { createPlatformApp } = await import("../app.js");

    createPlatformApp();

    expect(firebaseAppsSeenFrom(
      new URL(import.meta.url),
      new URL("../../../gateway-edge/src/lib/db.ts", import.meta.url),
    )).toEqual([]);
  });
});
