import { applicationDefault, initializeApp } from "firebase-admin/app";
import { installUserEntitlements, staticUserEntitlements, userEntitlements } from "@octogee/shared/types/user-entitlements";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../index.js";

vi.mock("firebase-admin/app", async (original) => ({
  ...await original<typeof import("firebase-admin/app")>(),
  applicationDefault: vi.fn(),
  initializeApp: vi.fn(),
}));

const previous = userEntitlements();
afterEach(() => {
  installUserEntitlements(previous);
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

async function startUntilFirebase() {
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "octogee-test");
  vi.mocked(applicationDefault).mockReturnValue({} as never);
  vi.mocked(initializeApp).mockImplementation(() => { throw new Error("bootstrap boundary"); });
  await expect(main({ userLifecycle: null })).rejects.toThrow("bootstrap boundary");
}

it("initializes bare platform entitlements before starting the fleet controller", async () => {
  Reflect.deleteProperty(globalThis, Symbol.for("octogee.userEntitlements"));
  await startUntilFirebase();
  expect(userEntitlements()).toBe(staticUserEntitlements);
});

it("keeps the product resolver when starting the fleet controller", async () => {
  const product = { ...staticUserEntitlements, sizingKey: () => "product-size" };
  installUserEntitlements(product);
  await startUntilFirebase();
  expect(userEntitlements()).toBe(product);
});
