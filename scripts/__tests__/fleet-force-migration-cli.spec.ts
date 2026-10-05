import { afterEach, describe, expect, it, vi } from "vitest";
import { forceMigrationHarness } from "./fleet-force-migration.test-support.js";

const mocks = vi.hoisted(() => ({ db: undefined as unknown, transport: undefined as unknown }));
vi.mock("firebase-admin/app", async importOriginal => ({
  ...await importOriginal<typeof import("firebase-admin/app")>(),
  initializeApp: vi.fn(), applicationDefault: vi.fn(),
}));
vi.mock("firebase-admin/firestore", async importOriginal => ({
  ...await importOriginal<typeof import("firebase-admin/firestore")>(),
  getFirestore: () => mocks.db,
}));
vi.mock("../ops/fleet-force-migration-transport.js", () => ({ createForceMigrationTransport: () => mocks.transport }));
vi.mock("@octogee/core/gateway-live-release", async importOriginal => ({
  ...await importOriginal<typeof import("@octogee/core/gateway-live-release")>(),
  readGatewayAuthorization: async () => ({ gateway: { desiredStatus: "running" }, config: { profile: "standard" } }),
  readGatewayRuntimeHeartbeat: async () => ({ status: "ready" }),
}));
vi.mock("../lib/glm-operations.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/glm-operations.js")>(),
  awaitOperation: async () => ({ status: "succeeded", steps: [] }),
}));
import { main } from "../ops/fleet.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Fleet forced migration customer lookup", () => {
  it.each([false, true])("resolves a username alias to the canonical slug for apply=%s", async apply => {
    const h = forceMigrationHarness();
    const user = h.docs.get("users/u1")!;
    user.username = "login-alias";
    user.provisioning.openclaw.slug = "alice";
    mocks.db = h.db;
    const bound = { podName: "builder-pod", podUid: "pod-uid", containerImage: "image", beforeBootId: "before" };
    const transport = {
      capture: vi.fn(async () => bound), dispatch: vi.fn(async () => {}),
      observe: vi.fn(async (_bound: typeof bound, attemptId: string) => ({ version: 1, attemptId, beforeBootId: "before", afterBootId: "after", ready: true })),
    };
    mocks.transport = transport;
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await main(["--env=test", "migrate-customer", "login-alias", "--to=shared-b", "--force", "--operation=move-1", ...(apply ? ["--apply"] : [])]);
    expect(transport.dispatch).toHaveBeenCalledTimes(apply ? 1 : 0);
    if (apply) {
      expect(h.op().forceDrainRequest.completedAt).toEqual(expect.any(Number));
      expect([...h.docs.values()].find(doc => doc.recordType === "audit")?.target.slug).toBe("alice");
    } else expect(h.writes).toEqual([]);
  });
});
