import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firebaseAdmin = vi.hoisted(() => ({
  applicationDefault: vi.fn(() => ({ kind: "application-default" })),
  cert: vi.fn(() => ({ kind: "service-account-key" })),
  initializeApp: vi.fn(() => ({ name: "[DEFAULT]" })),
  listUsers: vi.fn(async () => ({ users: [] })),
}));

vi.mock("firebase-admin/app", () => ({
  applicationDefault: firebaseAdmin.applicationDefault,
  cert: firebaseAdmin.cert,
  initializeApp: firebaseAdmin.initializeApp,
}));
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ listUsers: firebaseAdmin.listUsers }),
}));

import {
  deleteAllFirebaseAuthUsers,
  main,
} from "../ops/delete-firebase-auth-users.js";

describe("delete-firebase-auth-users entrypoint credentials", () => {
  let home: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "auth-cleanup-operator-home-"));
    const secrets = path.join(home, ".openclaw", "secrets");
    fs.mkdirSync(secrets, { recursive: true });
    fs.writeFileSync(
      path.join(secrets, "octogee-test-sa-key.json"),
      JSON.stringify({ project_id: "octogee-test", client_email: "stale@octogee-test.iam.gserviceaccount.com" }),
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    firebaseAdmin.cert.mockClear();
    firebaseAdmin.initializeApp.mockClear();
    firebaseAdmin.listUsers.mockClear();
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("verifies Auth access with application default credentials for the requested project, ignoring laptop key files", async () => {
    await main(["--verify", "--project=octogee-test"]);

    expect(firebaseAdmin.cert).not.toHaveBeenCalled();
    expect(firebaseAdmin.initializeApp).toHaveBeenCalledWith({
      credential: { kind: "application-default" },
      projectId: "octogee-test",
    });
    expect(firebaseAdmin.listUsers).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/application default for octogee-test/));
  });

  it("rejects a service-account key argument instead of silently switching credentials", async () => {
    await expect(
      main(["--project=octogee-test", "--service-account=/keys/stale.json"]),
    ).rejects.toThrow(/unknown argument/i);
    expect(firebaseAdmin.initializeApp).not.toHaveBeenCalled();
  });

  it("refuses to run without an explicit project", async () => {
    await expect(main(["--verify"])).rejects.toThrow(/--project is required/);
    expect(firebaseAdmin.initializeApp).not.toHaveBeenCalled();
  });
});

describe("deleteAllFirebaseAuthUsers", () => {
  it("collects every page before deleting users in Admin SDK-sized batches", async () => {
    const listedPageTokens: Array<string | undefined> = [];
    const deletedBatches: string[][] = [];
    let listingComplete = false;
    const auth = {
      listUsers: async (_maxResults: number, pageToken?: string) => {
        listedPageTokens.push(pageToken);
        if (listingComplete) return { users: [] };
        if (!pageToken) {
          return {
            users: [{ uid: "one" }, { uid: "two" }],
            pageToken: "next-page",
          };
        }
        listingComplete = true;
        return { users: [{ uid: "three" }] };
      },
      deleteUsers: async (uids: string[]) => {
        deletedBatches.push(uids);
        return { failureCount: 0 };
      },
    };

    await expect(deleteAllFirebaseAuthUsers(auth)).resolves.toBe(3);
    expect(listedPageTokens).toEqual([undefined, "next-page", undefined]);
    expect(deletedBatches).toEqual([["one", "two", "three"]]);
  });

  it("fails rather than claiming a complete reset when any batch deletion fails", async () => {
    const auth = {
      listUsers: async () => ({ users: [{ uid: "one" }] }),
      deleteUsers: async () => ({ failureCount: 1 }),
    };

    await expect(deleteAllFirebaseAuthUsers(auth)).rejects.toThrow(
      "Firebase Auth deletion failed for 1 user(s)",
    );
  });

  it("fails rather than claiming a complete reset when a user remains after deletion", async () => {
    let listCount = 0;
    const auth = {
      listUsers: async () => {
        listCount += 1;
        return listCount === 1
          ? { users: [{ uid: "one" }] }
          : { users: [{ uid: "residual" }] };
      },
      deleteUsers: async () => ({ failureCount: 0 }),
    };

    await expect(deleteAllFirebaseAuthUsers(auth)).rejects.toThrow(
      "Firebase Auth still contains users after deletion",
    );
  });
});
