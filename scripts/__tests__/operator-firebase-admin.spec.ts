import { beforeEach, describe, expect, it, vi } from "vitest";

const firebaseAdmin = vi.hoisted(() => ({
  applicationDefault: vi.fn(() => ({ kind: "application-default" })),
  initializeApp: vi.fn(() => ({ name: "[DEFAULT]" })),
}));

vi.mock("firebase-admin/app", () => firebaseAdmin);

import { initializeOperatorFirebaseAdmin } from "../lib/operator-firebase-admin.js";

describe("initializeOperatorFirebaseAdmin", () => {
  beforeEach(() => {
    firebaseAdmin.applicationDefault.mockClear();
    firebaseAdmin.initializeApp.mockClear();
  });

  it("authenticates with application default credentials for the explicit project", () => {
    const log = vi.fn();

    initializeOperatorFirebaseAdmin("firebase-test", { env: {}, log });

    expect(firebaseAdmin.initializeApp).toHaveBeenCalledWith({
      credential: { kind: "application-default" },
      projectId: "firebase-test",
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("gcloud auth application-default login");
    expect(log.mock.calls[0]?.[0]).toContain("firebase-test");
  });

  it("names the key file when GOOGLE_APPLICATION_CREDENTIALS supplies the credentials", () => {
    const log = vi.fn();

    initializeOperatorFirebaseAdmin("octogee", {
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/keys/operator.json" },
      log,
    });

    expect(firebaseAdmin.initializeApp).toHaveBeenCalledWith({
      credential: { kind: "application-default" },
      projectId: "octogee",
    });
    expect(log.mock.calls[0]?.[0]).toContain("GOOGLE_APPLICATION_CREDENTIALS=/keys/operator.json");
    expect(log.mock.calls[0]?.[0]).toContain("octogee");
  });

  it("refuses an empty project instead of letting the SDK pick the gcloud default project", () => {
    expect(() => initializeOperatorFirebaseAdmin("", { env: {}, log: vi.fn() })).toThrow(/project/i);
    expect(firebaseAdmin.initializeApp).not.toHaveBeenCalled();
  });
});
