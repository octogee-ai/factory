import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectStore: vi.fn(),
  shell: vi.fn(),
  getFirestore: vi.fn(() => ({})),
  getAuth: vi.fn(),
}));

vi.mock("@octogee/core/platform-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@octogee/core/platform-state")>()),
  platformStateStoreForDeploymentTarget: mocks.selectStore,
}));
vi.mock("firebase-admin/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase-admin/app")>()),
  initializeApp: vi.fn(),
  applicationDefault: vi.fn(),
  getApps: () => [],
}));
vi.mock("firebase-admin/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase-admin/firestore")>()),
  getFirestore: mocks.getFirestore,
}));
vi.mock("firebase-admin/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase-admin/auth")>()),
  getAuth: mocks.getAuth,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: mocks.shell,
  execFileSync: mocks.shell,
  execSync: mocks.shell,
  spawn: mocks.shell,
  spawnSync: mocks.shell,
}));

import { main as fleet } from "../ops/fleet.js";
import { main as rotateUserMmPat } from "../ops/rotate-user-mm-pat.js";
import { main as setAdminRole } from "../ops/set-admin-role.js";
import { TEST_TARGET } from "./fixtures/deployment.js";

function otherTargetsDatabase(selected: { deploymentTargetId: string }): Promise<never> {
  return Promise.reject(new Error(`platform database belongs to deployment target "prod-central", not "${selected.deploymentTargetId}"`));
}

describe("operator commands bind the platform database to their deployment target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectStore.mockImplementation(otherTargetsDatabase);
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.stubEnv("PLATFORM_STATE_BACKEND", "postgres");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("stops fleet --env=test at another target's database before Kubernetes or Firestore", async () => {
    await expect(fleet([
      "--env=test", "gw", "deploy", "builder-a", `--sha=${"a".repeat(40)}`, "--apply",
    ])).rejects.toThrow('belongs to deployment target "prod-central", not "test-central"');
    expect(mocks.selectStore.mock.calls[0]?.[0]).toMatchObject({ deploymentTargetId: "test-central" });
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it.each([
    ["rotate-user-mm-pat", rotateUserMmPat],
    ["set-admin-role", setAdminRole],
  ])("%s takes its target from the Firebase project and stops before any account change", async (_name, command) => {
    await expect(command([`--project=${TEST_TARGET.firebaseProjectId}`, "someone@example.com"])).rejects.toThrow(
      'belongs to deployment target "prod-central", not "test-central"',
    );
    expect(mocks.selectStore.mock.calls[0]?.[0]).toMatchObject({ deploymentTargetId: "test-central" });
    expect(mocks.getAuth.mock.results.flatMap((result) => Object.values(result.value ?? {}))).toEqual([]);
  });

  it("refuses a Firebase project that names no deployment target", async () => {
    await expect(setAdminRole(["--project=somewhere-else", "someone@example.com"])).rejects.toThrow(
      "Unknown Firebase deployment project: somewhere-else",
    );
    expect(mocks.selectStore).not.toHaveBeenCalled();
  });
});
