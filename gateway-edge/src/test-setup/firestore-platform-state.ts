import { vi } from "vitest";

vi.mock("../lib/platform-state.js", async (importOriginal) => {
  const { createFirestorePlatformStateStore } = await import("@octogee/core/testing/firestore-store");
  const { db } = await import("../lib/db.js");
  return {
    ...(await importOriginal<typeof import("../lib/platform-state.js")>()),
    platformStateStore: createFirestorePlatformStateStore({ db }),
  };
});
